// Publishes the local Swarmaa service at https://<hostname> through a named Cloudflare Tunnel.
// Usage: npm run tunnel -- --hostname api.swarmaa.com [--dry-run]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { plist } from './setup-lib.js';

export interface TunnelResult { publicUrl: string; changed: string[] }

const NAME = 'swarmaa';
const LABEL = 'com.swarma.tunnel';

/** Sets KEY=value in .env text, keeping every other line and its position. */
export function setEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
}

export function envValue(text: string, key: string): string {
  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

export function validHostname(host: string): boolean {
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
}

export async function setupTunnel(opts: { hostname: string; root: string; dry: boolean; log: (line: string) => void; home?: string }): Promise<TunnelResult> {
  const { hostname, root, dry, log } = opts;
  const home = opts.home ?? homedir();
  if (!validHostname(hostname) || !(hostname === 'swarmaa.com' || hostname.endsWith('.swarmaa.com'))) throw new Error(`hostname must be swarmaa.com or a subdomain of it, got ${hostname}`);
  const cf = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find(existsSync);
  if (!cf) throw new Error('cloudflared is not installed (brew install cloudflared)');
  const run = (args: string[], capture = true) => {
    if (dry) { log(`  [dry-run] cloudflared ${args.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; }
    const r = spawnSync(cf, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const changed: string[] = [];

  if (!existsSync(join(home, '.cloudflared', 'cert.pem'))) {
    log('Authorize Cloudflare: approve swarmaa.com in the browser window that opens.');
    if (run(['tunnel', 'login'], false).status !== 0) throw new Error('cloudflared tunnel login did not complete');
  }

  let id = '';
  if (!dry) {
    const list = run(['tunnel', 'list', '--output', 'json']);
    id = ((JSON.parse(list.stdout || 'null') ?? []) as { id: string; name: string }[]).find(t => t.name === NAME)?.id ?? '';
  }
  if (!id) {
    log(`Creating tunnel ${NAME}`);
    const r = run(['tunnel', 'create', NAME]);
    if (r.status !== 0) throw new Error(`cloudflared tunnel create failed: ${r.stderr.trim().split('\n').at(-1)}`);
    id = dry ? '<tunnel-id>' : (`${r.stdout}\n${r.stderr}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0] ?? '');
    if (!id) throw new Error('could not read the new tunnel id');
  }
  log(`Routing ${hostname} to tunnel ${NAME}`);
  const route = run(['tunnel', 'route', 'dns', NAME, hostname]);
  if (route.status !== 0 && !/already (exists|configured)/i.test(route.stderr)) throw new Error(`DNS route failed: ${route.stderr.trim().split('\n').at(-1)}`);

  const envFile = join(root, '.env');
  let env = readFileSync(envFile, 'utf8');
  const port = envValue(env, 'PORT') || '8787';
  const yml = join(root, '.local', 'cloudflared.yml');
  // The service only accepts its PUBLIC_URL host, so pin the Host header the origin sees.
  const config = [`tunnel: ${id}`, `credentials-file: ${join(home, '.cloudflared', `${id}.json`)}`, 'ingress:',
    `  - hostname: ${hostname}`, `    service: http://127.0.0.1:${port}`, '    originRequest:', `      httpHostHeader: ${hostname}`,
    '  - service: http_status:404', ''].join('\n');
  const agent = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const logFile = join(root, '.local', 'logs', 'tunnel.log');
  const xml = plist(LABEL, [cf, 'tunnel', '--no-autoupdate', '--config', yml, 'run', NAME], { stdout: logFile, stderr: logFile });
  const origins = new Set(envValue(env, 'ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean));
  origins.add(`https://${hostname}`);
  env = setEnv(setEnv(setEnv(setEnv(env, 'PUBLIC_URL', `https://${hostname}`), 'ALLOWED_ORIGINS', [...origins].join(',')), 'OAUTH_ENABLED', 'true'), 'TRUST_PROXY', 'true');

  if (dry) {
    log(`  [dry-run] write ${yml} and ${agent}; set PUBLIC_URL=https://${hostname} in .env; restart the service; start the tunnel`);
    return { publicUrl: `https://${hostname}`, changed: [yml, agent, envFile] };
  }
  mkdirSync(join(root, '.local', 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(yml, config, { mode: 0o600 });
  writeFileSync(agent, xml, { mode: 0o644 });
  writeFileSync(envFile, env, { mode: 0o600 });
  changed.push(yml, agent, envFile);

  const uid = process.getuid?.() ?? 501;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  for (let i = 0; i < 20 && spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`]).status === 0; i++) spawnSync('sleep', ['0.25']);
  if (spawnSync('launchctl', ['bootstrap', `gui/${uid}`, agent]).status !== 0) throw new Error(`launchctl bootstrap ${LABEL} failed`);
  log(`Started ${LABEL}`);
  if (spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/com.swarma.service`]).status === 0) log('Restarted the Swarmaa service with the public URL');

  const url = `https://${hostname}/.well-known/oauth-protected-resource`;
  for (let i = 0; i < 20; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).ok) { log(`Reachable at https://${hostname}`); return { publicUrl: `https://${hostname}`, changed }; } } catch { /* DNS or tunnel still starting */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  log(`Tunnel is running, but https://${hostname} did not answer yet (DNS can take a few minutes).`);
  return { publicUrl: `https://${hostname}`, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { hostname: { type: 'string', default: 'api.swarmaa.com' }, 'dry-run': { type: 'boolean', default: false } } });
  setupTunnel({ hostname: values.hostname!, root: process.cwd(), dry: values['dry-run']!, log: l => console.log(l) })
    .then(r => console.log(`MCP URL: ${r.publicUrl}/mcp`))
    .catch(e => { console.error(`Tunnel setup failed: ${(e as Error).message}`); process.exitCode = 1; });
}
