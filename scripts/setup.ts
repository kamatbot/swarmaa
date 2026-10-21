// First-launch wizard: npm run setup [-- --dry-run]. Idempotent; state in .local/setup.json. Never prints tokens.
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AGY_TOOLS, bridgeConfig, mergeAgyPermissions, parseEnv, plist, slugScopes, yes } from './setup-lib.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const dry = process.argv.includes('--dry-run');
const HOME = homedir();
// Prefer the stable Homebrew symlink so LaunchAgents survive `brew upgrade node`.
const NODE = (() => { try { return realpathSync('/opt/homebrew/bin/node') === realpathSync(process.execPath) ? '/opt/homebrew/bin/node' : process.execPath; } catch { return process.execPath; } })();
const PGDATA = join(ROOT, '.local/pg'), PGLOG = join(ROOT, '.local/pg.log'), LOGS = join(ROOT, '.local/logs');
const LAUNCHER = join(ROOT, 'clients/macos/swarma-mcp.sh');
const LA = join(HOME, 'Library/LaunchAgents');
const PGENV = { LC_ALL: 'en_US.UTF-8' };
const say = (s = '') => console.log(s);
const plan = (s: string) => say(`  [dry-run] ${s}`);
const die = (s: string): never => { throw new Error(s); };

interface Result { status: number; stderr: string }
/** Mutating commands are only printed under --dry-run; pass mutating:false for read-only probes. */
function run(cmd: string, args: string[], o: { mutating?: boolean; env?: Record<string, string> } = {}): Result {
  if (dry && o.mutating !== false) { plan([cmd, ...args].map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' ')); return { status: 0, stderr: '' }; }
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...o.env }, timeout: 600_000 });
  return { status: r.status ?? 1, stderr: r.stderr ?? '' };
}
const tail = (r: Result) => r.stderr.trim().split('\n').slice(-5).join('\n');
const admin = (...a: string[]) => run(NODE, ['--env-file=.env', '--import', 'tsx', 'scripts/admin.ts', ...a]);
// Write inside the repo (private by default); under --dry-run just announce.
function put(file: string, data: string, mode = 0o600): void {
  if (dry) { plan(`write ${file} (mode ${mode.toString(8)})`); return; }
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data, { mode }); chmodSync(file, mode);
}
const mkdirp = (dir: string, mode = 0o700) => { if (dry) plan(`mkdir -p ${dir}`); else mkdirSync(dir, { recursive: true, mode }); };

if (Number(process.versions.node.split('.')[0]) < 22) die('Swarma needs Node >= 22.');
say(dry ? 'Swarma setup (dry run: nothing will be changed)\n' : 'Swarma setup\n');

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
async function ask(q: string): Promise<string> {
  process.stdout.write(`${q} `);
  const r = await lines.next();
  const a = r.done ? '' : String(r.value).trim();
  if (!process.stdin.isTTY) process.stdout.write(`${a}\n`); // piped answers are not echoed by a terminal
  return a;
}
const askYes = async (q: string, d: boolean) => yes(await ask(`${q} [${d ? 'Y/n' : 'y/N'}]`), d);

interface State { folders?: string[]; agents?: string[]; workers?: string[]; autostart?: boolean }
let state: State = {};
try { state = JSON.parse(readFileSync('.local/setup.json', 'utf8')) as State; } catch { /* first run */ }

async function main(): Promise<void> {
  // 2. .env
  if (!existsSync('.env')) {
    say('Creating .env with unique local credentials...');
    const r = run(NODE, ['--import', 'tsx', 'scripts/init-local.ts']);
    if (r.status !== 0) die(`init-local failed:\n${tail(r)}`);
  }
  const env = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const port = env.PORT || '8787';

  // 3. database
  const url = env.DATABASE_URL;
  let pgbin: string | undefined;
  const findBin = () => pgbin ??= ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim()].find(d => d && existsSync(join(d, 'pg_ctl')));
  const u = url ? new URL(url) : undefined;
  const managed = !!u && u.hostname === '127.0.0.1' && u.port === '54329';
  const connect = async (target: string) => {
    const c = new pg.Client({ connectionString: target, connectionTimeoutMillis: 3000 });
    c.on('error', () => undefined);
    try { await c.connect(); return c; } catch { await c.end().catch(() => undefined); return undefined; }
  };
  if (!url || !u) {
    if (!dry) die('DATABASE_URL is missing from .env.');
    plan('.env would be created first; database steps are skipped in this dry run');
  } else if (!(await connect(url).then(async c => { await c?.end(); return !!c; }))) {
    if (!managed) die(`Cannot reach the database at ${u.hostname}:${u.port || 5432}. Start it or fix DATABASE_URL in .env.`);
    const bin = findBin();
    if (!bin) { console.error('PostgreSQL was not found. Install it, then re-run setup:\n  brew install postgresql@17'); process.exit(1); }
    const pgctl = join(bin, 'pg_ctl');
    if (!existsSync(PGDATA)) {
      const pw = env.POSTGRES_PASSWORD || die('POSTGRES_PASSWORD is missing from .env.');
      const pwfile = join(ROOT, '.local/.pgpw.tmp');
      say('Initializing the local PostgreSQL cluster in .local/pg ...');
      if (!dry) { mkdirSync(dirname(pwfile), { recursive: true, mode: 0o700 }); writeFileSync(pwfile, `${pw}\n`, { mode: 0o600 }); }
      try {
        const r = run(join(bin, 'initdb'), ['-D', PGDATA, '-U', 'collective', `--pwfile=${pwfile}`, '-A', 'scram-sha-256'], { env: PGENV });
        if (r.status !== 0) die(`initdb failed:\n${tail(r)}`);
      } finally { rmSync(pwfile, { force: true }); }
    }
    if (run(pgctl, ['-D', PGDATA, 'status'], { mutating: false, env: PGENV }).status !== 0) {
      say('Starting PostgreSQL on 127.0.0.1:54329 ...');
      const r = run(pgctl, ['-D', PGDATA, '-o', '-p 54329 -k /tmp -h 127.0.0.1', '-l', PGLOG, '-w', 'start'], { env: PGENV });
      if (r.status !== 0) die(`pg_ctl start failed (see .local/pg.log):\n${tail(r)}`);
    }
    const name = u.pathname.slice(1);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) die('DATABASE_URL database name must be lowercase letters, digits and underscore.');
    if (dry) plan(`CREATE DATABASE ${name} if missing`);
    else {
      const admin0 = new URL(url); admin0.pathname = '/postgres';
      const c = await connect(admin0.toString()) ?? die('Cannot connect to the postgres database after starting the cluster.');
      try {
        if (!(await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await c.query(`CREATE DATABASE "${name}"`);
      } finally { await c.end(); }
    }
  } else say('Database reachable.');

  // 4. migrate
  say('Applying migrations ...');
  const m = run(NODE, ['--env-file=.env', '--import', 'tsx', 'scripts/migrate.ts']);
  if (m.status !== 0) die(`migrate failed:\n${tail(m)}`);

  // 5. project folders
  const def = state.folders ?? [];
  const ans = await ask(`Project folders the swarm may work on (comma-separated absolute paths, blank = demo only${def.length ? `; Enter keeps ${def.join(',')}, - clears` : ''}):`);
  const valid: string[] = [];
  for (const raw of (ans === '-' ? '' : ans || def.join(',')).split(',').map(s => s.trim()).filter(Boolean)) {
    const p = raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw;
    if (!isAbsolute(p)) { say(`  skipped ${raw}: not an absolute path`); continue; }
    try { if (statSync(p).isDirectory()) { valid.push(resolve(p)); continue; } } catch { /* fallthrough */ }
    say(`  skipped ${raw}: not an existing directory`);
  }
  const demo = join(ROOT, '.local/demo-project');
  if (!existsSync(demo)) { mkdirp(demo); put(join(demo, 'README.md'), '# Swarma demo project\n\nA scratch folder for trying the swarm without touching real code.\n', 0o644); }
  const projects = [{ scope: 'project:demo', root: demo }, ...slugScopes(valid, ['demo'])];
  const scopes = projects.map(p => p.scope).join(',');

  // 6. agents
  const exe = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  const detect = (cmd: string): string | undefined => {
    const sh = spawnSync('/bin/sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).stdout?.trim().split('\n').pop() ?? '';
    return [sh, join(HOME, '.local/bin', cmd), join('/opt/homebrew/bin', cmd)].find(p => p.startsWith('/') && exe(p));
  };
  const ensureIdentity = (name: string, role: string, file: string): boolean => {
    const exists = existsSync(file);
    const r = exists ? admin('set-scopes', '--name', name, '--scopes', scopes) : admin('create', '--name', name, '--role', role, '--scopes', scopes, '--out', file);
    if (r.status === 0) { say(`  ${exists ? 'updated scopes of' : 'created'} ${name}`); return true; }
    if (!exists && /already exists|duplicate|unique/i.test(r.stderr)) say(`  ${name} already exists but ${file} is missing. Rotate it into place with:\n    npm run admin -- rotate --name ${name} --out ${file}\n  (or revoke it and use another name), then re-run setup.`);
    else say(`  could not ${exists ? 'update' : 'create'} ${name}:\n${tail(r)}`);
    return false;
  };
  let built = false;
  const build = () => { if (built) return true; say('Building (npm run build) ...'); const r = run('npm', ['run', 'build']); if (r.status !== 0) say(`  build failed:\n${tail(r)}`); return built = r.status === 0; };
  const AGENTS = [
    { key: 'claude', label: 'Claude Code', stem: 'claude', ident: 'claude-interactive', model: 'sonnet' as string | undefined },
    { key: 'codex', label: 'Codex', stem: 'codex', ident: 'codex-interactive', model: undefined },
    { key: 'agy', label: 'Antigravity', stem: 'antigravity', ident: 'antigravity-interactive', model: undefined },
  ];
  const agents: string[] = [], workers: string[] = [];
  for (const a of AGENTS) {
    const bin = detect(a.key);
    if (!bin) { say(`${a.label} not found; skipping.`); continue; }
    if (!(await askYes(`Connect ${a.label} to Swarma shared memory?`, state.agents ? state.agents.includes(a.key) : true))) continue;
    if (!existsSync(join(ROOT, 'dist/src/stdio-proxy.js'))) build();
    if (!ensureIdentity(a.ident, 'frontend', join(ROOT, `.local/${a.stem}.json`))) continue;
    if (a.key === 'claude') { run(bin, ['mcp', 'remove', '-s', 'user', 'swarma']); run(bin, ['mcp', 'add', '-s', 'user', 'swarma', '--', '/bin/sh', LAUNCHER, a.stem]); }
    else if (a.key === 'codex') { run(bin, ['mcp', 'remove', 'swarma']); run(bin, ['mcp', 'add', 'swarma', '--', '/bin/sh', LAUNCHER, a.stem]); }
    else {
      run(bin, ['mcp', 'add', 'swarma', '/bin/sh', LAUNCHER, a.stem]);
      const f = join(HOME, '.gemini/antigravity-cli/settings.json');
      let cur: unknown = {}, ok = true;
      if (existsSync(f)) try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch { ok = false; say(`  ${f} is not valid JSON; left untouched. Add mcp(swarma/<tool>) allow entries yourself.`); }
      if (ok) {
        if (dry) plan(`merge permissions.allow mcp(swarma/{${AGY_TOOLS.join(',')}}) into ${f}`);
        else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(mergeAgyPermissions(cur, AGY_TOOLS), null, 2)}\n`); }
      }
    }
    agents.push(a.key);
    if (a.key === 'agy' || !(await askYes(`Run ${a.key} as a background worker (read-only tasks)?`, state.workers?.includes(a.key) ?? false))) continue;
    const tokenFile = join(ROOT, `.local/worker-${a.key}.json`);
    if (!ensureIdentity(`worker-${a.key}`, 'worker', tokenFile)) continue;
    const cfg = bridgeConfig({ port, tokenFile, agent: { id: a.key, binary: bin, model: a.model }, projects });
    put(join(ROOT, `.local/bridge-${a.key}.json`), `${JSON.stringify(cfg, null, 2)}\n`);
    workers.push(a.key);
  }

  // 7. autostart
  const autostart = await askYes('Start Swarma automatically at login?', state.autostart ?? true);
  const uid = process.getuid?.() ?? 501, label = (s: string) => `com.swarma.${s}`;
  const bridgeArgs = (k: string) => [NODE, join(ROOT, 'dist/src/bridge.js'), '--config', join(ROOT, `.local/bridge-${k}.json`)];
  if (autostart) {
    if (build()) {
      mkdirp(LOGS); mkdirp(LA, 0o755);
      const baseEnv = { PATH: `${dirname(NODE)}:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin`, HOME };
      const bin = managed ? findBin() : undefined;
      if (managed && !bin) say('  PostgreSQL binaries not found; not creating a postgres LaunchAgent.');
      const jobs: { id: string; args: string[]; extra?: Record<string, string>; wd?: string }[] = [
        ...(bin ? [{ id: 'postgres', args: [join(bin, 'postgres'), '-D', PGDATA, '-p', '54329', '-k', '/tmp', '-h', '127.0.0.1'], extra: PGENV }] : []),
        { id: 'service', args: [NODE, `--env-file=${join(ROOT, '.env')}`, join(ROOT, 'dist/src/server.js')], wd: ROOT },
        ...workers.map(k => ({ id: `bridge.${k}`, args: bridgeArgs(k), wd: ROOT })),
      ];
      for (const j of jobs) {
        const file = join(LA, `${label(j.id)}.plist`), log = join(LOGS, `${j.id}.log`);
        const xml = plist(label(j.id), j.args, { workingDirectory: j.wd, env: { ...baseEnv, ...j.extra }, stdout: log, stderr: log });
        if (dry) { plan(`write ${file}`); say(xml.replace(/^/gm, '      ')); } else writeFileSync(file, xml, { mode: 0o644 });
        if (j.id === 'postgres' && run(join(bin!, 'pg_ctl'), ['-D', PGDATA, 'status'], { mutating: false, env: PGENV }).status === 0) {
          const r = run(join(bin!, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', 'stop'], { env: PGENV });
          if (r.status !== 0) say(`  could not stop the pg_ctl cluster:\n${tail(r)}`);
        }
        run('launchctl', ['bootout', `gui/${uid}/${label(j.id)}`]);
        const r = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
        say(r.status === 0 ? `  loaded ${label(j.id)}` : `  launchctl bootstrap ${label(j.id)} failed:\n${tail(r)}`);
      }
      for (const k of ['claude', 'codex']) {
        const file = join(LA, `${label(`bridge.${k}`)}.plist`);
        if (workers.includes(k) || !existsSync(file)) continue;
        run('launchctl', ['bootout', `gui/${uid}/${label(`bridge.${k}`)}`]);
        if (dry) plan(`rm ${file}`); else rmSync(file, { force: true });
      }
    }
  } else {
    say('\nManual start commands (from the repo root):');
    if (managed) say(`  LC_ALL=en_US.UTF-8 ${join(findBin() ?? '<pgbin>', 'pg_ctl')} -D .local/pg -o "-p 54329 -k /tmp -h 127.0.0.1" -l .local/pg.log -w start`);
    say('  npm run dev');
    for (const k of workers) say(`  npm run bridge -- --config .local/bridge-${k}.json`);
  }

  if (!dry) put(join(ROOT, '.local/setup.json'), `${JSON.stringify({ folders: valid, agents, workers, autostart }, null, 2)}\n`);

  // 8. summary
  say(`\nSetup ${dry ? 'dry run ' : ''}complete.`);
  say(`  Agents connected: ${agents.join(', ') || 'none'}`);
  say(`  Background workers: ${workers.join(', ') || 'none'}`);
  say('  Scopes:');
  for (const p of projects) say(`    ${p.scope} -> ${p.root}`);
  say(`  Service URL: http://127.0.0.1:${port}`);
  say('  Remote access (Tailscale / Cloudflare): see docs/SWARMA.md');
}

try { await main(); } catch (e) { console.error(`\nSetup failed: ${(e as Error).message}`); process.exitCode = 1; } finally { rl.close(); }
