import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { plist } from './setup-lib.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpToolClient } from '../src/bridge/client.js';

interface WorkerStatus { name: string; running: unknown[] }
export interface DeployIO {
  command(command: string, args: string[], timeout: number): string;
  signal(pid: number): void;
  sleep(ms: number): Promise<void>;
  status(): Promise<WorkerStatus[]>;
  healthy(url: string): Promise<boolean>;
  log(message: string): void;
  uid: number;
  port: string;
  installRelay?(): string;
}

/** launchctl list <label> is a dictionary, unlike the three-column job listing. */
export function launchPid(output: string): number | undefined {
  const pid = Number(output.match(/"PID"\s*=\s*(\d+)\s*;/u)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function localIO(): DeployIO {
  const port = process.env.PORT || '8787';
  return {
    installRelay: () => {
      const root = resolve('.'), agents = resolve(homedir(), 'Library/LaunchAgents');
      mkdirSync(agents, { recursive: true });
      mkdirSync(resolve(root, '.local/logs'), { recursive: true, mode: 0o700 });
      const file = resolve(agents, 'com.swarma.relay.plist');
      // A stable Homebrew link to this same Node, not the versioned Cellar path: `brew upgrade` deletes the old
      // Cellar folder, and launchd then fails the relay with exit 78 (no phone can pair or connect).
      const real = (p: string): string => { try { return realpathSync(p); } catch { return ''; } };
      const self = real(process.execPath);
      const node = ['/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/opt/node@24/bin/node', '/usr/local/bin/node']
        .find(p => real(p) === self) ?? process.execPath;
      writeFileSync(file, plist('com.swarma.relay', [node, '--env-file=.env', 'dist/src/relay-agent.js'], {
        workingDirectory: root, stdout: resolve(root, '.local/logs/relay.log'), stderr: resolve(root, '.local/logs/relay.err.log'),
        env: { PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ''}` },
      }), { mode: 0o600 });
      return file;
    },
    port, uid: process.getuid?.() ?? -1,
    command: (command, args, timeout) => {
      try { return execFileSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { throw new Error(`${command} ${args.join(' ')} failed or timed out`); }
    },
    signal: pid => { process.kill(pid, 'SIGUSR2'); },
    sleep: ms => delay(ms),
    status: async () => {
      // Optional caller-supplied dashboard token; never discover credentials or print them.
      const token = process.env.SWARMAA_TOKEN || process.env.COLLECTIVE_TOKEN;
      if (!token) return [];
      const result = await new HttpToolClient(`http://127.0.0.1:${port}`, token, 1500).call<{ workers: WorkerStatus[] }>('swarm_status', {});
      return result.workers;
    },
    healthy: async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      await response.body?.cancel();
      return response.status === 200;
    },
    log: message => process.stdout.write(`${message}\n`),
  };
}

export async function deployLocal(args = process.argv.slice(2), io = localIO()): Promise<void> {
  let dry = false, service = true, relay = false, only: string | undefined, drainTimeoutSeconds = 300;
  const usage = 'Usage: npm run deploy:local -- [--dry-run] [--only claude|codex|agy] [--no-service] [--relay] [--drain-timeout <seconds>]';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--relay') relay = true;
    else if (args[i] === '--dry-run') dry = true;
    else if (args[i] === '--no-service') service = false;
    else if (args[i] === '--only' && ['claude', 'codex', 'agy'].includes(args[i + 1] ?? '')) only = args[++i];
    else if (args[i] === '--drain-timeout') {
      const raw = args[++i] ?? '';
      if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 86400) throw new Error(usage);
      drainTimeoutSeconds = Number(raw);
    }
    else throw new Error(usage);
  }
  if (!/^\d+$/u.test(io.port) || Number(io.port) < 1 || Number(io.port) > 65535 || io.uid < 0) throw new Error('A valid PORT and a launchd user session are required');
  const launch = (...a: string[]): string => io.command('launchctl', a, 10000);
  io.log(`${dry ? 'Would run' : 'Running'} npm run build`);
  if (!dry) io.command('npm', ['run', 'build'], 300000);
  const labels = launch('list').split('\n').map(line => line.trim().split(/\s+/u)).filter(parts =>
    /^\d+$/u.test(parts[0] ?? '') && /^com\.swarma\.bridge\.[a-z0-9_-]+$/u.test(parts[2] ?? '') && (!only || parts[2] === `com.swarma.bridge.${only}`)
  ).map(parts => parts[2]!);
  const bridges = labels.map(label => ({ label, pid: launchPid(launch('list', label)) })).filter((b): b is { label: string; pid: number } => b.pid !== undefined);
  if (!bridges.length) io.log('No matching running bridges');
  for (const b of bridges) io.log(`${dry ? 'Would drain' : 'Draining'} ${b.label} (PID ${b.pid}) with SIGUSR2; wait for a new PID`);
  const target = `gui/${io.uid}/com.swarma.service`;
  const healthUrl = `http://127.0.0.1:${io.port}/.well-known/oauth-authorization-server`;
  if (dry) {
    if (relay) io.log('Would install and restart com.swarma.relay after service readiness');
    if (service) io.log(`After every bridge has a new PID: launchctl kickstart -k ${target}; wait for HTTP 200 at ${healthUrl}`);
    return;
  }
  // Signal every old bridge before waiting; an already issued claim is allowed to finish.
  for (const b of bridges) {
    if (launchPid(launch('list', b.label)) !== b.pid) throw new Error(`${b.label} changed PID before drain; rerun after checking its state`);
    io.signal(b.pid);
  }
  const pending = new Map(bridges.map(b => [b.label, b.pid]));
  const drainLimitMs = drainTimeoutSeconds * 1000;
  const drainDeadline = Date.now() + drainLimitMs;
  let drainedWaitMs = 0;
  while (pending.size) {
    if (drainedWaitMs >= drainLimitMs || Date.now() >= drainDeadline) {
      throw new Error(`Drain timed out after ${drainTimeoutSeconds}s waiting for: ${[...pending.keys()].join(', ')}`);
    }
    await io.sleep(2000);
    drainedWaitMs += 2000;
    let workers: WorkerStatus[] = [];
    try { workers = await io.status(); } catch { /* PID state is enough when status is unavailable. */ }
    for (const [label, oldPid] of pending) {
      const pid = launchPid(launch('list', label));
      if (pid && pid !== oldPid) {
        io.log(`${label}: PID ${oldPid} -> ${pid}`);
        pending.delete(label);
      } else {
        const worker = workers.find(w => w.name === `worker-${label.slice('com.swarma.bridge.'.length)}`);
        io.log(`${label}: ${pid ? `waiting on PID ${pid}` : 'waiting for launchd to start a new PID'}${worker ? `; ${worker.running.length} running task(s)` : ''}`);
      }
    }
  }
  const restartRelay = async () => {
    if (!relay) return;
    if (!io.installRelay) throw new Error('Relay plist installation unavailable');
    const file = io.installRelay(), relayTarget = `gui/${io.uid}/com.swarma.relay`;
    const loaded = (): boolean => { try { launch('print', relayTarget); return true; } catch { return false; } };
    try { launch('bootout', relayTarget); } catch { /* first install */ }
    // bootout returns before the old relay exits; bootstrapping while it is still loaded fails, and the late unload
    // then leaves no relay at all (the phone loses the Mac). Wait for the label to disappear first.
    for (let i = 0; i < 30 && loaded(); i++) await io.sleep(500);
    for (let attempt = 1; ; attempt++) {
      try { launch('bootstrap', `gui/${io.uid}`, file); break; }
      catch (error) { if (attempt >= 5) throw error; await io.sleep(1000); }
    }
    launch('kickstart', '-k', relayTarget);
    let pid: number | undefined;
    for (let i = 0; i < 20 && !pid; i++) {
      await io.sleep(500);
      try { pid = launchPid(launch('list', 'com.swarma.relay')); } catch { /* not loaded yet */ }
    }
    if (!pid) throw new Error('Relay did not start under launchd; check .local/logs/relay.err.log');
    await io.sleep(3000);
    let still: number | undefined;
    try { still = launchPid(launch('list', 'com.swarma.relay')); } catch { /* unloaded */ }
    if (!still) throw new Error(`Relay PID ${pid} exited right after start; check .local/logs/relay.err.log`);
    io.log(`Relay running under launchd (PID ${still})`);
    io.log('Relay installed and restarted; check its log for host_id and connection status');
  };
  if (!service) { await restartRelay(); return; }
  io.log(`Restarting ${target}`);
  launch('kickstart', '-k', target);
  for (let attempt = 0; attempt < 30; attempt++) {
    let healthy = false;
    try { healthy = await io.healthy(healthUrl); } catch { /* starting */ }
    if (healthy) { io.log('Service ready (HTTP 200)'); await restartRelay(); return; }
    await io.sleep(2000);
  }
  throw new Error('Service did not return HTTP 200 after restart');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.version.startsWith('v24.')) throw new Error('deploy:local requires Node.js 24');
  process.env.PATH = `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ''}`;
  deployLocal().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Local deploy failed'}\n`); process.exitCode = 1; });
}
