// First-launch setup: `npm run setup` opens the browser onboarding; `-- --cli` runs the terminal prompts.
// Flags: --dry-run (plan only), --no-open (print the URL), --cli. Idempotent; state in .local/setup.json. Never prints tokens.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { PasskeyService } from '../src/passkeys.js';
import { SOURCES, detectSources } from '../src/capture/index.js';
import { installJournalHooks, removeJournalHooks, type Harness } from './hooks-install.js';
import {
  AGY_TOOLS, DEFAULT_HOSTNAME, isCompiled, packageRoot, scriptCommand, HARNESS_KEYS, HOOK_APP_KEYS, PlanError, SHARING_HARNESSES, WORKER_HARNESSES, bridgeConfig, identityScopes, mergeAgyPermissions,
  parseEnv, plist, slugScopes, splitFolder, stateFile, validHostname, validatePlan, yes,
  type HarnessKey, type HookAppKey, type ScopeRoot, type SetupPlan, type State,
} from './setup-lib.js';
import { setupTunnel } from './tunnel.js';

export const ROOT = packageRoot(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
// Prefer the stable Homebrew symlink so LaunchAgents survive `brew upgrade node`.
const NODE = (() => { try { return realpathSync('/opt/homebrew/bin/node') === realpathSync(process.execPath) ? '/opt/homebrew/bin/node' : process.execPath; } catch { return process.execPath; } })();
const LA = join(HOME, 'Library/LaunchAgents');
const PGENV = { LC_ALL: 'en_US.UTF-8' };

const META: Record<HarnessKey, { label: string; ident: string; stem: string; model?: string; /** worker agent id (default: the harness key) */ agent?: string }> = {
  claude: { label: 'Claude Code', ident: 'claude-interactive', stem: 'claude', model: 'sonnet' },
  codex: { label: 'Codex', ident: 'codex-interactive', stem: 'codex' },
  agy: { label: 'Antigravity', ident: 'antigravity-interactive', stem: 'antigravity', agent: 'antigravity' },
  grok: { label: 'Grok', ident: 'grok', stem: 'grok' },
  dot: { label: 'Dot', ident: 'dot', stem: 'dot' },
  notchtrader: { label: 'NotchTrader', ident: 'notchtrader', stem: 'notchtrader' },
};
const HOOK_APPS: Record<HookAppKey, { label: string; marks: (home: string, env: NodeJS.ProcessEnv) => string[]; bin: string }> = {
  kiro: { label: 'Kiro', bin: 'kiro', marks: (h, e) => [e.KIRO_HOME?.trim() || join(h, '.kiro'), '/Applications/Kiro.app', join(h, 'Applications/Kiro.app')] },
  windsurf: { label: 'Windsurf / Devin Desktop', bin: 'windsurf', marks: h => [join(h, '.codeium/windsurf'), '/Applications/Windsurf.app', join(h, 'Applications/Windsurf.app')] },
  qwen: { label: 'Qwen Code', bin: 'qwen', marks: h => [join(h, '.qwen')] },
};
const CLI_KEYS = ['claude', 'codex', 'agy'] as const;
const HOSTED = ['grok', 'dot'] as const;

// ---------------------------------------------------------------- detection

export interface Detected {
  clis: Partial<Record<'claude' | 'codex' | 'agy', string>>;
  notchtrader: boolean;
  postgres: { found: boolean; reachable: boolean };
  envExists: boolean;
  state: State;
  /** Ids of the poll-captured apps found on this Mac (cursor, opencode, ...). */
  captureSources?: string[];
  /** Hook-based apps found on this Mac (kiro, windsurf, qwen). */
  hookApps?: HookAppKey[];
}

const exe = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
function findCli(cmd: string): string | undefined {
  const sh = spawnSync('/bin/sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).stdout?.trim().split('\n').pop() ?? '';
  return [sh, join(HOME, '.local/bin', cmd), join('/opt/homebrew/bin', cmd)].find(p => p.startsWith('/') && exe(p));
}
// SWARMAA_PG_BIN (the bundled PostgreSQL) wins over Homebrew.
const findPgBin = () => [process.env.SWARMAA_PG_BIN?.trim(), '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim()].find(d => d && existsSync(join(d, 'pg_ctl')));
async function pgConnect(target: string): Promise<pg.Client | undefined> {
  const c = new pg.Client({ connectionString: target, connectionTimeoutMillis: 3000 });
  c.on('error', () => undefined);
  try { await c.connect(); return c; } catch { await c.end().catch(() => undefined); return undefined; }
}

export async function detect(root = ROOT): Promise<Detected> {
  const clis: Detected['clis'] = {};
  for (const k of CLI_KEYS) { const p = findCli(k); if (p) clis[k] = p; }
  let state: State = {};
  try { state = JSON.parse(readFileSync(join(root, '.local/setup.json'), 'utf8')) as State; } catch { /* first run */ }
  const envExists = existsSync(join(root, '.env'));
  const url = envExists ? parseEnv(readFileSync(join(root, '.env'), 'utf8')).DATABASE_URL : undefined;
  let reachable = false;
  if (url) { const c = await pgConnect(url); reachable = !!c; await c?.end(); }
  const hookApps = HOOK_APP_KEYS.filter(k => HOOK_APPS[k].marks(HOME, process.env).some(existsSync) || !!findCli(HOOK_APPS[k].bin));
  return { clis, notchtrader: existsSync('/Applications/NotchTrader.app'), postgres: { found: reachable || !!findPgBin(), reachable }, envExists, state, captureSources: detectSources(), hookApps };
}

// ---------------------------------------------------------------- the setup engine

export interface StepRecord { id: string; label: string; status: 'running' | 'ok' | 'skipped' | 'failed'; note?: string }
export interface SetupSummary {
  dry: boolean; ok: boolean; error?: string;
  agents: string[]; workers: string[]; sharing: string[];
  /** Poll-captured sources and hook apps that are on (additive; absent in older summaries). */
  captured?: string[]; hookApps?: string[];
  projects: ScopeRoot[]; serviceUrl: string;
  mcpUrl?: string; remote?: { hostname: string; ok: boolean };
  steps: StepRecord[]; warnings: string[]; nextSteps: string[];
}
export interface RunOpts { dry: boolean; log: (line: string) => void; onStep?: (s: StepRecord) => void; root?: string; detected?: Detected }

class Abort extends Error {}
const errText = (e: unknown) => /not implemented yet/i.test((e as Error).message) ? 'not available yet' : (e as Error).message;

/** Runs every setup step for a validated plan. Never throws: failures are in the returned summary. */
export async function runSetup(plan: SetupPlan, opts: RunOpts): Promise<SetupSummary> {
  const { dry } = opts;
  const root = opts.root ?? ROOT;
  const PGDATA = join(root, '.local/pg'), PGLOG = join(root, '.local/pg.log'), LOGS = join(root, '.local/logs');
  const LAUNCHER = join(root, 'clients/macos/swarma-mcp.sh');
  const bundledNode = existsSync(join(root, 'node')) ? join(root, 'node') : undefined; // runtime layout ships its own node
  const det = opts.detected ?? await detect(root);
  const state = det.state;
  const say = (s = '') => { for (const l of s.split('\n')) opts.log(l); };
  const pl = (s: string) => say(`  [dry-run] ${s}`);

  interface Result { status: number; stderr: string }
  /** Mutating commands are only printed under dry; pass mutating:false for read-only probes. */
  const run = (cmd: string, args: string[], o: { mutating?: boolean; env?: Record<string, string> } = {}): Result => {
    if (dry && o.mutating !== false) { pl([cmd, ...args].map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' ')); return { status: 0, stderr: '' }; }
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...o.env }, timeout: 600_000 });
    return { status: r.status ?? 1, stderr: r.stderr ?? '' };
  };
  const tail = (r: Result) => r.stderr.trim().split('\n').slice(-5).join('\n');
  const admin = (...a: string[]) => run(NODE, [...scriptCommand(root, 'scripts/admin', { envFile: true }), ...a]);
  const put = (file: string, data: string, mode = 0o600): void => {
    if (dry) { pl(`write ${file} (mode ${mode.toString(8)})`); return; }
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data, { mode }); chmodSync(file, mode);
  };
  const mkdirp = (dir: string, mode = 0o700) => { if (dry) pl(`mkdir -p ${dir}`); else mkdirSync(dir, { recursive: true, mode }); };
  const die: (s: string) => never = s => { throw new Error(s); };

  const summary: SetupSummary = { dry, ok: true, agents: [], workers: [], sharing: [], captured: [], hookApps: [], projects: [], serviceUrl: '', steps: [], warnings: [], nextSteps: [] };
  async function step(id: string, label: string, fn: () => Promise<string | { skipped: string } | void>, fatal = false): Promise<void> {
    const rec: StepRecord = { id, label, status: 'running' };
    summary.steps.push(rec); opts.onStep?.({ ...rec });
    say(`\n${label}`);
    try {
      const r = await fn();
      if (typeof r === 'string') { rec.status = 'ok'; rec.note = r; } else if (r) { rec.status = 'skipped'; rec.note = r.skipped; say(`  skipped: ${r.skipped}`); } else rec.status = 'ok';
    } catch (e) {
      rec.status = 'failed'; rec.note = errText(e);
      say(`  failed: ${rec.note}`);
      if (fatal) { summary.ok = false; summary.error = `${label}: ${rec.note}`; opts.onStep?.({ ...rec }); throw new Abort(); }
      summary.warnings.push(`${label}: ${rec.note}`);
    }
    opts.onStep?.({ ...rec });
  }

  let env: Record<string, string> = {};
  let port = '8787';
  let pgPort = '54329';
  let managed = false;
  let bin: string | undefined;
  let built = false;
  const build = () => { if (built) return true;
    if (isCompiled(root) && !existsSync(join(root, 'tsconfig.json'))) return built = true; // compiled runtime: nothing to build
    say('Building (npm run build) ...'); const r = run('npm', ['run', 'build']); if (r.status !== 0) say(`  build failed:\n${tail(r)}`); return built = r.status === 0; };

  try {
    if (Number(process.versions.node.split('.')[0]) < 22) die('Swarmaa needs Node >= 22.');

    await step('env', 'Local credentials', async () => {
      if (existsSync(join(root, '.env'))) return;
      say('Creating .env with unique local credentials...');
      const r = run(NODE, scriptCommand(root, 'scripts/init-local'));
      if (r.status !== 0) die(`init-local failed:\n${tail(r)}`);
    }, true);
    env = existsSync(join(root, '.env')) ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : {};
    port = env.PORT || '8787';
    pgPort = env.PG_PORT || '54329';
    summary.serviceUrl = `http://127.0.0.1:${port}`;

    await step('db', 'Database', async () => {
      const url = env.DATABASE_URL;
      const u = url ? new URL(url) : undefined;
      managed = !!u && u.hostname === '127.0.0.1' && u.port === pgPort;
      if (!url || !u) {
        if (!dry) die('DATABASE_URL is missing from .env.');
        pl('.env would be created first; database steps are skipped in this dry run');
        return;
      }
      if (await pgConnect(url).then(async c => { await c?.end(); return !!c; })) { say('Database reachable.'); return; }
      if (!managed) die(`Cannot reach the database at ${u.hostname}:${u.port || 5432}. Start it or fix DATABASE_URL in .env.`);
      const pgb = bin = findPgBin();
      if (!pgb) die('PostgreSQL was not found. Install it, then re-run setup: brew install postgresql@17');
      const pgctl = join(pgb, 'pg_ctl');
      if (!existsSync(PGDATA)) {
        const pw = env.POSTGRES_PASSWORD || die('POSTGRES_PASSWORD is missing from .env.');
        const pwfile = join(root, '.local/.pgpw.tmp');
        say('Initializing the local PostgreSQL cluster in .local/pg ...');
        if (!dry) { mkdirSync(dirname(pwfile), { recursive: true, mode: 0o700 }); writeFileSync(pwfile, `${pw}\n`, { mode: 0o600 }); }
        try {
          const r = run(join(pgb, 'initdb'), ['-D', PGDATA, '-U', 'collective', `--pwfile=${pwfile}`, '-A', 'scram-sha-256'], { env: PGENV });
          if (r.status !== 0) die(`initdb failed:\n${tail(r)}`);
        } finally { rmSync(pwfile, { force: true }); }
      }
      if (run(pgctl, ['-D', PGDATA, 'status'], { mutating: false, env: PGENV }).status !== 0) {
        say(`Starting PostgreSQL on 127.0.0.1:${pgPort} ...`);
        const r = run(pgctl, ['-D', PGDATA, '-o', `-p ${pgPort} -k /tmp -h 127.0.0.1`, '-l', PGLOG, '-w', 'start'], { env: PGENV });
        if (r.status !== 0) die(`pg_ctl start failed (see .local/pg.log):\n${tail(r)}`);
      }
      const name = u.pathname.slice(1);
      if (!/^[a-z][a-z0-9_]*$/.test(name)) die('DATABASE_URL database name must be lowercase letters, digits and underscore.');
      if (dry) { pl(`CREATE DATABASE ${name} if missing`); return; }
      const admin0 = new URL(url); admin0.pathname = '/postgres';
      const c = await pgConnect(admin0.toString()) ?? die('Cannot connect to the postgres database after starting the cluster.');
      try {
        if (!(await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await c.query(`CREATE DATABASE "${name}"`);
      } finally { await c.end(); }
    }, true);

    await step('migrate', 'Database migrations', async () => {
      const m = run(NODE, scriptCommand(root, 'scripts/migrate', { envFile: true }));
      if (m.status !== 0) die(`migrate failed:\n${tail(m)}`);
    }, true);

    // Projects: demo sandbox + the real folders. project:general has no folder and is interactive-only.
    const demo = join(root, '.local/demo-project');
    await step('projects', 'Project folders', async () => {
      if (!existsSync(demo)) { mkdirp(demo); put(join(demo, 'README.md'), '# Swarmaa demo project\n\nA scratch folder for trying the swarm without touching real code.\n', 0o644); }
      return `${plan.folders.length} folder${plan.folders.length === 1 ? '' : 's'} plus the demo sandbox`;
    });
    const projects: ScopeRoot[] = [{ scope: 'project:demo', root: demo }, ...slugScopes(plan.folders, ['demo'])];
    summary.projects = projects;
    const interactive = identityScopes('interactive', projects).join(',');
    const workerScopes = identityScopes('worker', projects).join(',');
    for (const p of projects) say(`  ${p.scope} -> ${p.root}`);

    const ensureIdentity = (name: string, role: string, file: string, scopes: string): boolean => {
      const exists = existsSync(file);
      const r = exists ? admin('set-scopes', '--name', name, '--scopes', scopes) : admin('create', '--name', name, '--role', role, '--scopes', scopes, '--out', file);
      if (r.status === 0) { say(`  ${exists ? 'updated scopes of' : 'created'} ${name}`); return true; }
      if (!exists && /already exists|duplicate|unique/i.test(r.stderr)) say(`  ${name} already exists but ${file} is missing. Rotate it into place with:\n    npm run admin -- rotate --name ${name} --out ${file}\n  (or revoke it and use another name), then re-run setup.`);
      else say(`  could not ${exists ? 'update' : 'create'} ${name}:\n${tail(r)}`);
      return false;
    };

    for (const key of HARNESS_KEYS) {
      const hp = plan.harnesses[key];
      if (!hp?.connect) continue;
      const m = META[key];
      await step(`svc:${key}`, m.label, async () => {
        const cli = (CLI_KEYS as readonly string[]).includes(key) ? det.clis[key as typeof CLI_KEYS[number]] : undefined;
        if ((CLI_KEYS as readonly string[]).includes(key) && !cli) return { skipped: `${m.label} was not found on this Mac` };
        if (key === 'notchtrader' && !det.notchtrader) return { skipped: 'NotchTrader.app is not installed' };
        if (cli && !existsSync(join(root, 'dist/src/stdio-proxy.js'))) build();
        if (!ensureIdentity(m.ident, 'frontend', join(root, `.local/${m.stem}.json`), interactive)) throw new Error(`could not create or update the ${m.ident} identity`);
        if (key === 'claude') { run(cli!, ['mcp', 'remove', '-s', 'user', 'swarma']); run(cli!, ['mcp', 'add', '-s', 'user', 'swarma', '--', '/bin/sh', LAUNCHER, m.stem]); }
        else if (key === 'codex') { run(cli!, ['mcp', 'remove', 'swarma']); run(cli!, ['mcp', 'add', 'swarma', '--', '/bin/sh', LAUNCHER, m.stem]); }
        else if (key === 'agy') {
          run(cli!, ['mcp', 'add', 'swarma', '/bin/sh', LAUNCHER, m.stem]);
          const f = join(HOME, '.gemini/antigravity-cli/settings.json');
          let cur: unknown = {}, ok = true;
          if (existsSync(f)) try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch { ok = false; say(`  ${f} is not valid JSON; left untouched. Add mcp(swarma/<tool>) allow entries yourself.`); }
          if (ok) {
            if (dry) pl(`merge permissions.allow mcp(swarma/{${AGY_TOOLS.join(',')}}) into ${f}`);
            else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(mergeAgyPermissions(cur, AGY_TOOLS), null, 2)}\n`); }
          }
        } else if ((HOSTED as readonly string[]).includes(key)) say(`  ${m.label} reaches Swarmaa over HTTPS and needs remote access (below).`);
        summary.agents.push(key);
        // Background worker: its own worker identity (project scopes only) and read-only bridge config.
        if (hp.worker && WORKER_HARNESSES.includes(key)) {
          const tokenFile = join(root, `.local/worker-${key}.json`);
          if (!ensureIdentity(`worker-${key}`, 'worker', tokenFile, workerScopes)) throw new Error(`could not create or update worker-${key}`);
          put(join(root, `.local/bridge-${key}.json`), `${JSON.stringify(bridgeConfig({ port, tokenFile, agent: { id: m.agent ?? key, provider: m.agent ?? key, binary: cli!, model: m.model }, projects }), null, 2)}\n`);
          summary.workers.push(key);
        }
      });
    }

    // Chat sharing: install the journal hooks, or remove them when switched off on a re-run.
    const hooks = SHARING_HARNESSES.filter(k => det.clis[k as typeof CLI_KEYS[number]]);
    if (hooks.some(k => plan.harnesses[k]?.connect || state.sharing?.includes(k))) await step('sharing', 'Share chats across harnesses', async () => {
      for (const k of hooks) {
        const want = !!plan.harnesses[k]?.connect && plan.harnesses[k]!.share && summary.agents.includes(k);
        if (!want && !state.sharing?.includes(k)) continue;
        try {
          const o = { root, dry, node: bundledNode, log: (l: string) => say(`  ${l}`) };
          if (want) { await installJournalHooks(k as Harness, o); summary.sharing.push(k); say(`  ${META[k].label}: chats are shared`); }
          else { await removeJournalHooks(k as Harness, o); say(`  ${META[k].label}: chat sharing removed`); }
        } catch (e) {
          const msg = `${META[k].label} chat sharing: ${errText(e)}`;
          say(`  ${msg}`); summary.warnings.push(msg);
        }
      }
    });

    // Hook-based apps (Kiro, Windsurf, Qwen): their own identity plus journal hooks; hooks are removed when switched off on a re-run.
    const foundApps = det.hookApps ?? [];
    for (const k of HOOK_APP_KEYS) {
      const want = !!plan.hookApps[k]?.share && foundApps.includes(k);
      if (!want && !state.hookApps?.includes(k)) continue;
      await step(`hookapp:${k}`, HOOK_APPS[k].label, async () => {
        const o = { root, dry, node: bundledNode, log: (l: string) => say(`  ${l}`) };
        if (!want) { await removeJournalHooks(k, o); return 'chat sharing removed'; }
        if (!ensureIdentity(k, 'frontend', join(root, `.local/${k}.json`), interactive)) throw new Error(`could not create or update the ${k} identity`);
        const r = await installJournalHooks(k, o);
        if (r.skipped) throw new Error(r.skipped);
        summary.hookApps!.push(k);
        return 'chats are shared';
      });
    }

    // Poll-captured apps (Cursor, OpenCode, ...): one `capture` identity; the capture LaunchAgent is created with autostart.
    const found = det.captureSources ?? [];
    const captureOn = plan.capture.enabled && found.length > 0;
    if (captureOn || state.capture) await step('capture', 'Capture chats from other apps', async () => {
      if (!captureOn) return 'switched off';
      if (!ensureIdentity('capture', 'frontend', join(root, '.local/capture.json'), interactive)) throw new Error('could not create or update the capture identity');
      summary.captured = found;
      say(`  apps: ${found.map(id => SOURCES.find(x => x.id === id)?.label ?? id).join(', ')}`);
      return found.join(', ');
    });

    // Remote access for hosted agents (Grok, Dot).
    const hosted = HOSTED.filter(k => summary.agents.includes(k));
    if (plan.remote && hosted.length) await step('remote', 'Remote access', async () => {
      summary.remote = { hostname: plan.remote!.hostname, ok: false };
      try {
        await setupTunnel({ hostname: plan.remote!.hostname, root, dry, log: l => say(`  ${l}`) });
        summary.remote.ok = true; summary.mcpUrl = `https://${plan.remote!.hostname}/mcp`;
        return `${summary.mcpUrl}`;
      } catch (e) { throw new Error(`tunnel setup: ${errText(e)}`); }
    });
    // An earlier run may already have published the service; reuse its public URL.
    if (!summary.mcpUrl && /^https:\/\//.test(env.PUBLIC_URL ?? '')) summary.mcpUrl = `${env.PUBLIC_URL!.replace(/\/$/, '')}/mcp`;
    for (const k of hosted) summary.nextSteps.push(`${META[k].label}: add ${summary.mcpUrl ?? 'https://<your-hostname>/mcp'} as a remote MCP server (see clients/${k}/README.md).${summary.mcpUrl ? '' : ' Remote access is not set up yet; re-run setup and enable it.'}`);

    // Autostart.
    const autostart = plan.autostart;
    await step('autostart', autostart ? 'Start at login' : 'Manual start', async () => {
      const uid = process.getuid?.() ?? 501, label = (s: string) => `com.swarma.${s}`;
      if (!autostart) {
        say('Manual start commands (from the repo root):');
        if (managed) say(`  LC_ALL=en_US.UTF-8 ${join(findPgBin() ?? '<pgbin>', 'pg_ctl')} -D .local/pg -o "-p ${pgPort} -k /tmp -h 127.0.0.1" -l .local/pg.log -w start`);
        say('  npm run dev');
        for (const k of summary.workers) say(`  npm run bridge -- --config .local/bridge-${k}.json`);
        if (captureOn) say('  npm run capture -- --once   (captures chats from the other apps; run it now and then, or switch autostart on)');
        summary.nextSteps.push('Start the service: npm run dev (autostart is off).');
        return;
      }
      if (!build()) throw new Error('build failed; LaunchAgents were not changed');
      mkdirp(LOGS); mkdirp(LA, 0o755);
      const baseEnv = { PATH: `${dirname(NODE)}:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin`, HOME };
      const pgbin = managed ? (bin ?? findPgBin()) : undefined;
      if (managed && !pgbin) say('  PostgreSQL binaries not found; not creating a postgres LaunchAgent.');
      const jobs: { id: string; args: string[]; extra?: Record<string, string>; wd?: string; log?: string; interval?: number; calendar?: { hour: number; minute: number }; script?: string }[] = [
        ...(pgbin ? [{ id: 'postgres', args: [join(pgbin, 'postgres'), '-D', PGDATA, '-p', pgPort, '-k', '/tmp', '-h', '127.0.0.1'], extra: PGENV }] : []),
        { id: 'service', args: [NODE, `--env-file=${join(root, '.env')}`, join(root, 'dist/src/server.js')], wd: root },
        ...summary.workers.map(k => ({ id: `bridge.${k}`, args: [NODE, join(root, 'dist/src/bridge.js'), '--config', join(root, `.local/bridge-${k}.json`)], wd: root })),
        // One-shot jobs: no KeepAlive. Their own *.log (status words) is written by the scripts; launchd output goes to *.launchd.log.
        ...(captureOn ? [{ id: 'capture', args: [NODE, ...scriptCommand(root, 'scripts/capture'), '--once'], wd: root, log: 'capture.launchd.log', interval: 120 }] : []),
        { id: 'distill', args: [NODE, ...scriptCommand(root, 'scripts/distill', { envFile: true }), '--once'], wd: root, log: 'distill.launchd.log', calendar: { hour: 3, minute: 30 }, script: 'scripts/distill' },
      ];
      for (const j of jobs) {
        if (j.script && !dry && !existsSync(scriptCommand(root, j.script).at(-1)!)) { say(`  ${j.script} is not present yet; not creating the ${j.id} LaunchAgent.`); continue; }
        const file = join(LA, `${label(j.id)}.plist`), log = join(LOGS, j.log ?? `${j.id}.log`);
        const xml = plist(label(j.id), j.args, { workingDirectory: j.wd, env: { ...baseEnv, ...j.extra }, stdout: log, stderr: log, startInterval: j.interval, calendar: j.calendar, ...(j.calendar ? { runAtLoad: false } : {}) });
        if (dry) { pl(`write ${file}`); say(xml.replace(/^/gm, '      ')); } else writeFileSync(file, xml, { mode: 0o644 });
        if (j.id === 'postgres' && run(join(pgbin!, 'pg_ctl'), ['-D', PGDATA, 'status'], { mutating: false, env: PGENV }).status === 0) {
          const r = run(join(pgbin!, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', 'stop'], { env: PGENV });
          if (r.status !== 0) say(`  could not stop the pg_ctl cluster:\n${tail(r)}`);
        }
        run('launchctl', ['bootout', `gui/${uid}/${label(j.id)}`]);
        // bootout returns before launchd releases the job; bootstrapping too early fails with EIO.
        for (let i = 0; !dry && i < 20 && spawnSync('launchctl', ['print', `gui/${uid}/${label(j.id)}`]).status === 0; i++) spawnSync('sleep', ['0.25']);
        let r = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
        if (r.status !== 0 && !dry) { spawnSync('sleep', ['1']); r = run('launchctl', ['bootstrap', `gui/${uid}`, file]); }
        if (r.status === 0) say(`  loaded ${label(j.id)}`); else { say(`  launchctl bootstrap ${label(j.id)} failed:\n${tail(r)}`); summary.warnings.push(`launchctl bootstrap ${label(j.id)} failed`); }
      }
      for (const [id, keep] of [['bridge.claude', summary.workers.includes('claude')], ['bridge.codex', summary.workers.includes('codex')], ['bridge.agy', summary.workers.includes('agy')], ['capture', captureOn]] as const) {
        const file = join(LA, `${label(id)}.plist`);
        if (keep || !existsSync(file)) continue;
        run('launchctl', ['bootout', `gui/${uid}/${label(id)}`]);
        if (dry) pl(`rm ${file}`); else rmSync(file, { force: true });
      }
    });

    // Passkey for the OAuth approval page (hosted agents). Only over the public HTTPS address, and only until the first passkey exists.
    // The signup link is a secret: it goes to the browser, never to the log, summary or next steps.
    await step('passkey', 'Owner passkey', async () => {
      const current = existsSync(join(root, '.env')) ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : env;
      const publicUrl = (current.PUBLIC_URL ?? '').replace(/\/$/, '');
      if (!/^https:\/\//.test(publicUrl)) return { skipped: 'passkeys need the public HTTPS address (enable remote access first)' };
      if (dry) { pl(`create a one-time passkey signup link and open ${publicUrl}/account?code=<hidden> in your browser`); summary.nextSteps.push(`Create your passkey at ${publicUrl}/account`); return; }
      const pool = createPool(current.DATABASE_URL ?? die('DATABASE_URL is missing from .env.'));
      try {
        const passkeys = new PasskeyService(pool, loadConfig({ ...current, PUBLIC_URL: publicUrl }));
        if (!passkeys.rp) return { skipped: 'PUBLIC_URL host does not support passkeys' };
        if (await passkeys.hasPasskeys()) return { skipped: 'a passkey already exists' };
        const code = await passkeys.createInvite(30);
        spawn('open', [`${publicUrl}/account?code=${code}`], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
        summary.nextSteps.push(`Create your passkey at ${publicUrl}/account (the signup link opened in your browser and expires in 30 minutes; run "npm run admin -- passkey-invite" for a new one).`);
        return 'signup link opened in your browser';
      } finally { await pool.end(); }
    });

    await step('save', 'Save settings', async () => {
      put(join(root, '.local/setup.json'), `${JSON.stringify(stateFile({ folders: plan.folders, projects, agents: summary.agents, workers: summary.workers, sharing: summary.sharing, capture: captureOn, hookApps: summary.hookApps, autostart, remote: plan.remote }), null, 2)}\n`);
    });
    if (summary.agents.some(a => (CLI_KEYS as readonly string[]).includes(a))) summary.nextSteps.push('Restart Claude Code, Codex or Antigravity so they pick up the swarma MCP server.');
    if (!summary.agents.length) summary.nextSteps.push('Nothing was connected. Re-run setup and switch a service on.');
  } catch (e) {
    if (!(e instanceof Abort)) { summary.ok = false; summary.error = (e as Error).message; }
  }
  return summary;
}

export function printSummary(s: SetupSummary, say: (l?: string) => void): void {
  say(s.ok ? `\nSetup ${s.dry ? 'dry run ' : ''}complete.` : `\nSetup failed: ${s.error}`);
  say(`  Agents connected: ${s.agents.join(', ') || 'none'}`);
  say(`  Background workers: ${s.workers.join(', ') || 'none'}`);
  say(`  Chats shared across harnesses: ${s.sharing.join(', ') || 'none'}`);
  say(`  Chats captured from other apps: ${(s.captured ?? []).join(', ') || 'none'}`);
  say(`  Hook apps (Kiro / Windsurf / Qwen): ${(s.hookApps ?? []).join(', ') || 'none'}`);
  say('  Scopes:');
  for (const p of s.projects) say(`    ${p.scope} -> ${p.root}`);
  say('    project:general -> (no folder; interactive agents only)');
  say(`  Service URL: ${s.serviceUrl}`);
  if (s.mcpUrl) say(`  Remote MCP URL (Grok / Dot): ${s.mcpUrl}`);
  for (const w of s.warnings) say(`  warning: ${w}`);
  for (const n of s.nextSteps) say(`  next: ${n}`);
}

// ---------------------------------------------------------------- browser onboarding server

const MAX_BODY = 64 * 1024;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface OnboardingOptions {
  dry: boolean; idleMs?: number; root?: string;
  run?: typeof runSetup; detectFn?: typeof detect; html?: string;
}

/** The page is the only client: every request needs the random token (header), a loopback Host and a same-origin Origin. */
export function createOnboarding(o: OnboardingOptions) {
  const root = o.root ?? ROOT;
  const token = randomBytes(32).toString('base64url');
  const html = o.html ?? readFileSync(join(ROOT, 'scripts/onboarding.html'), 'utf8');
  const runner = o.run ?? runSetup, detector = o.detectFn ?? detect;
  const idleMs = o.idleMs ?? 15 * 60_000;
  let port = 0;
  let idle: NodeJS.Timeout | undefined;
  interface Job { id: number; running: boolean; lines: string[]; steps: StepRecord[]; summary?: SetupSummary; dry: boolean }
  let job: Job | undefined, seq = 0;

  // Never show .env secrets to the page, even inside an error message.
  const secrets = (() => { try { return Object.entries(parseEnv(readFileSync(join(root, '.env'), 'utf8'))).filter(([k, v]) => v.length >= 8 && /PASSWORD|KEY|TOKEN|SECRET|^DATABASE_URL$/i.test(k)).map(([, v]) => v); } catch { return []; } })();
  const redact = (s: string) => secrets.reduce((a, v) => a.split(v).join('[redacted]'), s);

  const server: Server = createServer((req, res) => { void handle(req, res); });
  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP, 'cross-origin-resource-policy': 'same-origin' });
    res.end(data);
  };
  const tokenOk = (given: unknown) => typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const readJson = (req: IncomingMessage): Promise<unknown> => new Promise((ok, fail) => {
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(new HttpError(415, 'JSON body required'));
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return fail(new HttpError(413, 'body too large'));
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { fail(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new HttpError(400, 'invalid JSON')); } });
    req.on('error', () => fail(new HttpError(400, 'read error')));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (idle) clearTimeout(idle);
      if (idleMs > 0) { idle = setTimeout(() => close(), idleMs); idle.unref(); }
      const origin = `http://127.0.0.1:${port}`;
      const url = new URL(req.url ?? '/', origin);
      // DNS-rebinding and cross-site guards come first.
      if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, 'bad host');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'bad origin');
      if (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new HttpError(403, 'cross-site request');
      const isPage = req.method === 'GET' && url.pathname === '/';
      if (!tokenOk(isPage ? url.searchParams.get('t') : req.headers['x-swarmaa-token'])) throw new HttpError(403, 'forbidden');
      if (isPage) return send(res, 200, html, 'text/html; charset=utf-8');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/detect') {
        const d = await detector(root);
        return send(res, 200, {
          dry: o.dry, defaultHostname: DEFAULT_HOSTNAME, state: d.state,
          installed: { claude: !!d.clis.claude, codex: !!d.clis.codex, agy: !!d.clis.agy, notchtrader: d.notchtrader },
          captureSources: d.captureSources ?? [], hookApps: d.hookApps ?? [],
          postgres: d.postgres,
        });
      }
      if (route === 'POST /api/run') {
        const body = await readJson(req);
        if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object');
        let plan: SetupPlan;
        try { plan = validatePlan((body as { plan?: unknown }).plan); } catch (e) { if (e instanceof PlanError) return send(res, 400, { error: 'invalid plan', details: e.errors }); throw e; }
        if (job?.running) throw new HttpError(409, 'setup is already running');
        const dry = o.dry || (body as { dry?: unknown }).dry === true;
        const j: Job = { id: ++seq, running: true, lines: [], steps: [], dry };
        job = j;
        const log = (l: string) => { if (j.lines.length < 5000) j.lines.push(redact(l)); };
        const onStep = (s: StepRecord) => { const i = j.steps.findIndex(x => x.id === s.id); const r = { ...s, ...(s.note ? { note: redact(s.note) } : {}) }; if (i < 0) j.steps.push(r); else j.steps[i] = r; };
        runner(plan, { dry, log, onStep, root }).then(
          s => { j.summary = JSON.parse(redact(JSON.stringify(s))) as SetupSummary; },
          e => { j.summary = { dry, ok: false, error: redact((e as Error).message), agents: [], workers: [], sharing: [], captured: [], hookApps: [], projects: [], serviceUrl: '', steps: j.steps, warnings: [], nextSteps: [] }; },
        ).finally(() => { j.running = false; });
        return send(res, 202, { id: j.id, dry });
      }
      if (route === 'GET /api/job') {
        if (!job) throw new HttpError(404, 'no job');
        const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
        return send(res, 200, { id: job.id, running: job.running, dry: job.dry, lines: job.lines.slice(after), next: job.lines.length, steps: job.steps, summary: job.summary });
      }
      if (route === 'POST /api/close') {
        if (job?.running) throw new HttpError(409, 'setup is still running');
        send(res, 200, { ok: true });
        setTimeout(() => close(), 100).unref();
        return;
      }
      if (['/api/detect', '/api/run', '/api/job', '/api/close'].includes(url.pathname)) throw new HttpError(405, 'method not allowed');
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader('connection', 'close');
        send(res, e.status, { error: e.message });
        if (e.status === 413) res.once('finish', () => req.socket.destroySoon());
      }
      else send(res, 500, { error: 'internal error' });
    }
  }

  function close(): void {
    if (idle) clearTimeout(idle);
    server.close();
    server.closeAllConnections();
  }
  const listen = () => new Promise<string>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      if (idleMs > 0) { idle = setTimeout(() => close(), idleMs); idle.unref(); }
      ok(`http://127.0.0.1:${port}/?t=${token}`);
    });
  });
  return { server, listen, close, token, closed: new Promise<void>(r => server.once('close', () => r())) };
}

// ---------------------------------------------------------------- terminal front end

async function cliMain(dry: boolean): Promise<number> {
  const say = (s = '') => console.log(s);
  say(dry ? 'Swarmaa setup (dry run: nothing will be changed)\n' : 'Swarmaa setup\n');
  const det = await detect();
  const state = det.state;
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string): Promise<string> => {
    process.stdout.write(`${q} `);
    const r = await lines.next();
    const a = r.done ? '' : String(r.value).trim();
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`); // piped answers are not echoed by a terminal
    return a;
  };
  const askYes = async (q: string, d: boolean) => yes(await ask(`${q} [${d ? 'Y/n' : 'y/N'}]`), d);
  try {
    const def = state.folders ?? [];
    const ans = await ask(`Project folders the swarm may work on (comma-separated absolute paths, optionally name=path, blank = demo only${def.length ? `; Enter keeps ${def.join(',')}, - clears` : ''}):`);
    const folders: string[] = [];
    for (const raw of (ans === '-' ? '' : ans || def.join(',')).split(',').map(s => s.trim()).filter(Boolean)) {
      const { name, path } = splitFolder(raw.replace(/^([a-z][a-z0-9-]*=)?~\//, (_m, n: string | undefined) => `${n ?? ''}${HOME}/`));
      const p = path;
      if (!isAbsolute(p)) { say(`  skipped ${raw}: not an absolute path`); continue; }
      try { if (statSync(p).isDirectory()) { folders.push(name ? `${name}=${resolve(p)}` : resolve(p)); continue; } } catch { /* fallthrough */ }
      say(`  skipped ${raw}: not an existing directory`);
    }
    const harnesses: Record<string, { connect: boolean; worker: boolean; share: boolean }> = {};
    for (const k of HARNESS_KEYS) {
      const m = META[k];
      const was = state.agents ? state.agents.includes(k) : !(HOSTED as readonly string[]).includes(k);
      if ((CLI_KEYS as readonly string[]).includes(k) && !det.clis[k as typeof CLI_KEYS[number]]) { say(`${m.label} not found; skipping.`); continue; }
      if (k === 'notchtrader') { if (!det.notchtrader) continue; }
      const q = k === 'notchtrader' ? 'Show Swarmaa agents and swarms in NotchTrader?' : (HOSTED as readonly string[]).includes(k) ? `Connect ${m.label} (hosted; needs remote access)?` : `Connect ${m.label} to Swarmaa shared memory?`;
      if (!await askYes(q, k === 'notchtrader' ? true : was)) continue;
      const worker = WORKER_HARNESSES.includes(k) && await askYes(`Run ${k} as a background worker (read-only tasks${k === 'agy' ? ', sandboxed' : ''})?`, state.workers?.includes(k) ?? false);
      const share = SHARING_HARNESSES.includes(k) && await askYes(`Share ${m.label} chats across harnesses?`, state.sharing ? state.sharing.includes(k) : true);
      harnesses[k] = { connect: true, worker, share };
    }
    const found = det.captureSources ?? [];
    const capture = { enabled: found.length > 0 && await askYes(`Capture chats from other apps (${found.map(id => SOURCES.find(x => x.id === id)?.label ?? id).join(', ')}) so your agents can recall them?`, state.capture ?? true) };
    const hookApps: Record<string, { share: boolean }> = {};
    for (const k of det.hookApps ?? []) if (await askYes(`Share ${HOOK_APPS[k].label} chats across harnesses?`, state.hookApps ? state.hookApps.includes(k) : true)) hookApps[k] = { share: true };
    let remote: { hostname: string } | undefined;
    if (HOSTED.some(k => harnesses[k]) && await askYes('Set up remote access with a Cloudflare Tunnel (opens Cloudflare in your browser to authorize)?', true)) {
      const h = validHostname(await ask(`Hostname [${state.remote?.hostname ?? DEFAULT_HOSTNAME}]:`) || state.remote?.hostname || DEFAULT_HOSTNAME);
      if (h) remote = { hostname: h }; else say('  that is not a valid hostname; skipping remote access.');
    }
    const autostart = await askYes('Start Swarmaa automatically at login?', state.autostart ?? true);
    const s = await runSetup(validatePlan({ harnesses, capture, hookApps, folders, remote, autostart }), { dry, log: say, detected: det });
    printSummary(s, say);
    return s.ok ? 0 : 1;
  } finally { rl.close(); }
}

// ---------------------------------------------------------------- browser front end

async function webMain(dry: boolean, open: boolean): Promise<number> {
  const ob = createOnboarding({ dry });
  const url = await ob.listen();
  console.log(`Swarmaa setup${dry ? ' (dry run: nothing will be changed)' : ''} is running at:\n  ${url}`);
  if (open) {
    console.log('Opening it in your browser ...');
    const c = spawn('open', [url], { stdio: 'ignore', detached: true });
    c.on('error', () => console.log('Could not open a browser; open the address above yourself.'));
    c.unref();
  } else console.log('Open the address above in your browser.');
  console.log('This page closes itself when you finish, or after 15 idle minutes. Ctrl-C to cancel.');
  process.once('SIGINT', () => ob.close());
  await ob.closed;
  return 0;
}

/** --detect-json: one JSON object on stdout, for the native app's onboarding. */
async function detectJson(): Promise<number> {
  process.stdout.write(`${JSON.stringify(await detect())}\n`);
  return 0;
}

/** --run-json: plan JSON on stdin; NDJSON step/log events and a final summary on stdout, for the native app. */
async function runJson(dry: boolean): Promise<number> {
  const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let plan: SetupPlan;
  try { plan = validatePlan(JSON.parse(input)); }
  catch (e) { emit({ type: 'error', errors: e instanceof PlanError ? e.errors : [(e as Error).message] }); return 1; }
  const summary = await runSetup(plan, { dry, log: line => emit({ type: 'log', line }), onStep: step => emit({ type: 'step', step }) });
  emit({ type: 'summary', summary });
  return summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const code = await (args.includes('--detect-json') ? detectJson() : args.includes('--run-json') ? runJson(dry)
    : args.includes('--cli') ? cliMain(dry) : webMain(dry, !args.includes('--no-open'))).catch(e => { console.error(`\nSetup failed: ${(e as Error).message}`); return 1; });
  process.exitCode = code;
}
