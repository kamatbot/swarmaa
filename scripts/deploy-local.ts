import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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
}

/** launchctl list <label> is a dictionary, unlike the three-column job listing. */
export function launchPid(output: string): number | undefined {
  const pid = Number(output.match(/"PID"\s*=\s*(\d+)\s*;/u)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function localIO(): DeployIO {
  const port = process.env.PORT || '8787';
  return {
    port, uid: process.getuid?.() ?? -1,
    command: (command, args, timeout) => {
      try { return execFileSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { throw new Error(`${command} ${args.join(' ')} failed or timed out`); }
    },
    signal: pid => { process.kill(pid, 'SIGUSR2'); },
    sleep: ms => delay(ms),
    status: async () => {
      // Optional caller-supplied dashboard token; never discover credentials or print them.
      const token = process.env.COLLECTIVE_TOKEN;
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
  let dry = false, service = true, only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dry = true;
    else if (args[i] === '--no-service') service = false;
    else if (args[i] === '--only' && ['claude', 'codex', 'agy'].includes(args[i + 1] ?? '')) only = args[++i];
    else throw new Error('Usage: npm run deploy:local -- [--dry-run] [--only claude|codex|agy] [--no-service]');
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
    if (service) io.log(`After every bridge has a new PID: launchctl kickstart -k ${target}; wait for HTTP 200 at ${healthUrl}`);
    return;
  }
  // Signal every old bridge before waiting; an already issued claim is allowed to finish.
  for (const b of bridges) {
    if (launchPid(launch('list', b.label)) !== b.pid) throw new Error(`${b.label} changed PID before drain; rerun after checking its state`);
    io.signal(b.pid);
  }
  const pending = new Map(bridges.map(b => [b.label, b.pid]));
  while (pending.size) {
    await io.sleep(2000);
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
  if (!service) return;
  io.log(`Restarting ${target}`);
  launch('kickstart', '-k', target);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if (await io.healthy(healthUrl)) { io.log('Service ready (HTTP 200)'); return; } } catch { /* starting */ }
    await io.sleep(2000);
  }
  throw new Error('Service did not return HTTP 200 after restart');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.version.startsWith('v24.')) throw new Error('deploy:local requires Node.js 24');
  process.env.PATH = `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ''}`;
  deployLocal().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Local deploy failed'}\n`); process.exitCode = 1; });
}
