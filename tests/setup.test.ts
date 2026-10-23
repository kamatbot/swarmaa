import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { projectCapabilities } from '../src/bridge/adapters.js';
import { createOnboarding, runSetup, type Detected, type SetupSummary } from '../scripts/setup.js';
import { AGY_TOOLS, DEFAULT_HOSTNAME, GENERAL_SCOPE, PlanError, WORKER_HARNESSES, bridgeConfig, identityScopes, mergeAgyPermissions, parseEnv, plist, slugScopes, stateFile, validHostname, validatePlan, yes } from '../scripts/setup-lib.js';
import { setupTunnel, validHostname as validTunnelHostname } from '../scripts/tunnel.js';

test('slugScopes normalizes basenames and suffixes collisions', () => {
  assert.deepEqual(slugScopes(['/a/My App!', '/b/my-app', '/c/My App!', '/a/My App!', '/d/Demo']).map(s => s.scope),
    ['project:my-app', 'project:my-app-2', 'project:my-app-3', 'project:demo']);
  assert.deepEqual(slugScopes(['/x/demo', '/y/Demo'], ['demo']).map(s => s.scope), ['project:demo-2', 'project:demo-3']);
  assert.equal(slugScopes(['/x/___'])[0]!.scope, 'project:project');
});

test('plist escapes strings and sets launchd keys', () => {
  const x = plist('com.swarma.t', ['/bin/node', 'a&b<c>"\''], { workingDirectory: '/r', env: { PATH: '/a:/b', HOME: '/h' }, stdout: '/l/o.log', stderr: '/l/o.log' });
  assert.match(x, /a&amp;b&lt;c&gt;&quot;&apos;/);
  for (const k of ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'ProcessType', 'Standard', 'WorkingDirectory', 'StandardOutPath']) assert.ok(x.includes(k), k);
  assert.ok(!x.includes('a&b<'));
  assert.ok(!plist('l', ['x']).includes('EnvironmentVariables'));
});

test('mergeAgyPermissions preserves keys, de-duplicates and tolerates junk', () => {
  const s = { theme: 'dark', permissions: { allow: ['shell(ls)', 'mcp(swarma/task_get)'], deny: ['x'] } };
  const out = mergeAgyPermissions(s, AGY_TOOLS) as { theme: string; permissions: { allow: string[]; deny: string[] } };
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.permissions.deny, ['x']);
  assert.equal(out.permissions.allow.length, 1 + AGY_TOOLS.length);
  assert.equal(out.permissions.allow.filter(a => a === 'mcp(swarma/task_get)').length, 1);
  assert.deepEqual(mergeAgyPermissions(mergeAgyPermissions(s, AGY_TOOLS), AGY_TOOLS), out);
  assert.ok((mergeAgyPermissions(null, ['a']) as any).permissions.allow.includes('mcp(swarma/a)'));
  assert.ok(!AGY_TOOLS.some(t => t.includes('*')));
  assert.equal(s.permissions.allow.length, 2);
});

test('bridgeConfig matches the example shape with token_file', () => {
  const c = bridgeConfig({ port: '8787', tokenFile: '/r/.local/worker-claude.json', agent: { id: 'claude', binary: '/b/claude', model: 'sonnet' }, projects: [{ scope: 'project:demo', root: '/r/demo' }] }) as any;
  assert.equal(c.service_url, 'http://127.0.0.1:8787');
  assert.equal(c.token_file, '/r/.local/worker-claude.json');
  assert.equal(c.token_env, undefined);
  assert.deepEqual(c.agents, [{ id: 'claude', provider: 'claude', binary: '/b/claude', model: 'sonnet', enable_patch: false }]);
  assert.deepEqual(c.projects, [{ scope: 'project:demo', root: '/r/demo', agents: ['claude'], allow_patch: false }]);
  assert.equal(c.reason, null);
  const agy = bridgeConfig({ port: 1, tokenFile: '/t', agent: { id: 'antigravity', provider: 'antigravity', binary: '/b/agy' }, projects: [{ scope: 'project:demo', root: '/r/demo' }], edit: true }) as any;
  assert.deepEqual(agy.agents, [{ id: 'antigravity', provider: 'antigravity', binary: '/b/agy', enable_patch: true, sandbox: true }]);
  assert.deepEqual(agy.projects[0].agents, ['antigravity']);
  assert.ok(WORKER_HARNESSES.includes('agy'));
  const codex = bridgeConfig({ port: 1, tokenFile: '/t', agent: { id: 'codex', binary: '/b/codex' }, projects: [] }) as any;
  assert.equal('model' in codex.agents[0], false);
});

test('parseEnv handles comments, quotes, export and values with =', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two"\n\nC=x=y\nD=\n bad\n'), { A: '1', B: 'two', C: 'x=y', D: '' });
});

test('yes honours defaults', () => {
  assert.equal(yes('', true), true);
  assert.equal(yes('', false), false);
  assert.equal(yes('Y', false), true);
  assert.equal(yes(' no ', true), false);
  assert.equal(yes('maybe', true), true);
});

// ---- plan validation, scopes, state shape ----

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-setup-')));
const okPlan = () => ({ harnesses: { claude: { connect: true, worker: true } }, folders: [dir], autostart: true });
const rejects = (input: unknown, re: RegExp) => assert.throws(() => validatePlan(input), (e: unknown) => e instanceof PlanError && re.test(e.message));

test('validatePlan defaults to local-only and accepts a user-owned remote domain', () => {
  assert.equal(DEFAULT_HOSTNAME, '');
  assert.equal(validatePlan(okPlan()).remote, undefined);
  const p = validatePlan({ ...okPlan(), harnesses: { claude: { connect: true, worker: true }, agy: { connect: true }, grok: { connect: true }, codex: { connect: false, worker: true } }, remote: { hostname: ' SWARM.Example.com ' } });
  assert.deepEqual(p.folders, [dir]);
  assert.deepEqual(p.harnesses.claude, { connect: true, worker: true, edit: false, share: true });
  assert.deepEqual(p.harnesses.agy, { connect: true, worker: false, edit: false, share: true });
  assert.deepEqual(p.harnesses.grok, { connect: true, worker: false, edit: false, share: false });
  assert.deepEqual(p.harnesses.codex, { connect: false, worker: false, edit: false, share: false });
  assert.deepEqual(p.remote, { hostname: 'swarm.example.com' });
  assert.deepEqual(validatePlan({ ...okPlan(), folders: [dir, dir] }).folders, [dir]);
});

test('validatePlan rejects unknown harnesses, bad folders, bad hostnames and junk', () => {
  rejects({ ...okPlan(), harnesses: { evil: { connect: true } } }, /unknown harness/);
  rejects({ ...okPlan(), harnesses: { claude: { connect: true, exec: 'rm -rf /' } } }, /unknown field/);
  rejects({ ...okPlan(), harnesses: { grok: { connect: true, worker: true } } }, /cannot run as a background worker/);
  rejects({ ...okPlan(), harnesses: { grok: { connect: true, share: true } } }, /does not support chat sharing/);
  rejects({ ...okPlan(), folders: ['relative/dir'] }, /not an absolute path/);
  rejects({ ...okPlan(), folders: [join(dir, 'missing')] }, /not an existing directory/);
  writeFileSync(join(dir, 'file.txt'), 'x');
  rejects({ ...okPlan(), folders: [join(dir, 'file.txt')] }, /not an existing directory/);
  rejects({ ...okPlan(), folders: [42] }, /path string/);
  rejects({ ...okPlan(), folders: 'nope' }, /list/);
  for (const bad of ['localhost', '1.2.3.4', 'a b.com', 'x.com/path', '-a.example.com', 'a..com', 'https://x.com', 'x.c', '', 5, 'a'.repeat(64) + '.com']) rejects({ ...okPlan(), remote: { hostname: bad } }, /hostname/);
  rejects({ ...okPlan(), autostart: 'yes' }, /autostart/);
  rejects({ ...okPlan(), extra: 1 }, /unknown field/);
  rejects(null, /object/);
  rejects([], /object/);
  assert.equal(validHostname('swarm.example.com'), 'swarm.example.com');
  assert.equal(validHostname('xn--bcher-kva.example'), 'xn--bcher-kva.example');
});

test('every identity gets project:general; workers run it read-only in an empty folder', () => {
  const projects = [{ scope: 'project:demo', root: '/d' }, { scope: 'project:app', root: '/a' }];
  assert.deepEqual(identityScopes('interactive', projects), ['project:demo', 'project:app', GENERAL_SCOPE]);
  assert.deepEqual(identityScopes('worker', projects), ['project:demo', 'project:app', GENERAL_SCOPE]);
  const c = bridgeConfig({ port: 1, tokenFile: '/t', agent: { id: 'claude', binary: '/b/claude' }, projects, edit: true, generalRoot: '/g' }) as any;
  assert.deepEqual(c.projects.at(-1), { scope: GENERAL_SCOPE, root: '/g', agents: ['claude'], allow_patch: false });
  assert.equal(GENERAL_SCOPE, 'project:general');
});

test('setup.json carries projects as [{scope, root}] including project:demo', () => {
  const projects = [{ scope: 'project:demo', root: '/d' }, ...slugScopes(['/x/App'], ['demo'])];
  const s = stateFile({ folders: ['/x/App'], projects, agents: ['claude'], workers: [], sharing: ['claude'], autostart: true, remote: { hostname: 'swarm.example.com' } });
  assert.deepEqual(s.projects, [{ scope: 'project:demo', root: '/d' }, { scope: 'project:app', root: '/x/App' }]);
  assert.deepEqual(s.folders, ['/x/App']);
  assert.deepEqual(s.sharing, ['claude']);
  assert.ok(!s.projects!.some(p => p.scope === GENERAL_SCOPE));
});

const fakeDetected = (): Detected => ({ clis: { claude: '/bin/claude-fake', codex: '/bin/codex-fake' }, notchtrader: false, postgres: { found: true, reachable: true }, envExists: false, state: {} });

test('runSetup dry-run assigns scopes by identity kind and only plans', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-root-')));
  const lines: string[] = [];
  const plan = validatePlan({ harnesses: { claude: { connect: true, worker: true, share: false }, codex: { connect: true }, grok: { connect: true }, dot: { connect: true } }, folders: [dir], autostart: false });
  const s = await runSetup(plan, { dry: true, log: l => lines.push(l), root, detected: fakeDetected() });
  const text = lines.join('\n');
  assert.equal(s.ok, true, String(s.error));
  assert.deepEqual(s.agents, ['claude', 'codex']);
  assert.deepEqual(s.workers, ['claude']);
  const cmd = (name: string) => lines.find(l => l.includes('admin.ts') && l.includes(`--name ${name}`)) ?? '';
  for (const n of ['claude-interactive', 'codex-interactive']) assert.match(cmd(n), /--scopes \S*project:general\b/, n);
  for (const n of ['grok', 'dot']) {
    assert.equal(cmd(n), '');
    assert.equal(s.steps.find(x => x.id === `svc:${n}`)?.status, 'skipped');
  }
  assert.match(cmd('worker-claude'), /--role worker/);
  assert.match(cmd('worker-claude'), /project:general/);
  assert.match(cmd('worker-claude'), /project:demo,project:/);
  assert.match(text, /write .*setup\.json/);
  assert.match(text, /\[dry-run\]/);
  assert.deepEqual(s.projects.map(p => p.scope)[0], 'project:demo');
  assert.ok(s.nextSteps.some(n => /Grok and Dot/.test(n) && /re-run npm run setup/.test(n)));
  assert.ok(!s.steps.some(x => x.id === 'remote'));
  assert.doesNotMatch(text, /cloudflared|https:\/\//);
  assert.match(text, /The hosted gateway at swarmaa\.com is invite-only/);
  assert.equal(s.mcpUrl, undefined);
  // dry run wrote nothing into the fresh root
  assert.throws(() => readFileSync(join(root, '.local/setup.json')));
});

test('runSetup dry-run accepts an explicitly requested tunnel on the user domain', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-root-')));
  const plan = validatePlan({ harnesses: { grok: { connect: true }, dot: { connect: true } }, folders: [], remote: { hostname: 'swarm.example.com' }, autostart: false });
  const s = await runSetup(plan, { dry: true, log: () => undefined, root, detected: fakeDetected() });
  assert.equal(s.ok, true);
  assert.equal(s.steps.find(x => x.id === 'remote')?.status, 'ok');
  assert.deepEqual(s.agents, ['grok', 'dot']);
  assert.equal(s.mcpUrl, 'https://swarm.example.com/mcp');
  assert.ok(s.nextSteps.some(n => /clients\/grok\/README\.md/.test(n)));
  assert.equal(s.steps.at(-1)!.id, 'save');
});

test('no-hostname setup generates only local config and plists', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-local-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/init-local.ts', import.meta.url))], { cwd: root, env: { PATH: process.env.PATH, SWARMAA_PORT: '9876' }, timeout: 60_000 });
  const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  assert.equal(env.PUBLIC_URL, 'http://127.0.0.1:9876');
  assert.equal(env.ALLOWED_ORIGINS, env.PUBLIC_URL);
  assert.ok(!JSON.stringify(env).includes('swarmaa.com'), 'generated environment has no gateway URL');
  // Keep only non-secret settings; the dry run must not probe a real database.
  writeFileSync(join(root, '.env'), `PORT=${env.PORT}\nPUBLIC_URL=${env.PUBLIC_URL}\n`);
  const files = new Map<string, string>();
  const local = { connect: true, worker: true, share: false };
  const plan = validatePlan({ harnesses: { claude: local, codex: local, grok: { connect: true }, dot: { connect: true } }, folders: [], autostart: true });
  const s = await runSetup(plan, { dry: true, root, detected: fakeDetected(), log: () => undefined, onFile: (file, data) => files.set(file, data) });
  assert.equal(s.ok, true, String(s.error));
  assert.deepEqual(s.warnings, []);
  assert.equal(s.serviceUrl, env.PUBLIC_URL);
  assert.equal(s.remote, undefined);
  assert.equal(s.mcpUrl, undefined);
  for (const k of ['claude', 'codex']) {
    const config = JSON.parse(files.get(join(root, `.local/bridge-${k}.json`))!);
    assert.equal(config.service_url, env.PUBLIC_URL);
    assert.ok([...files.keys()].some(f => f.endsWith(`com.swarma.bridge.${k}.plist`)));
  }
  assert.ok([...files.keys()].some(f => f.endsWith('com.swarma.service.plist')));
  assert.equal(JSON.parse(files.get(join(root, '.local/setup.json'))!).remote, undefined);
  assert.ok(!JSON.stringify([...files]).includes('swarmaa.com'), 'all generated config and plists have no gateway URL');
  assert.deepEqual(readdirSync(join(root, '.local')), [], 'dry run writes no config');
});

test('tunnel requires a valid hostname and dry-runs a user domain without side effects', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-tunnel-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const options = { root, home: root, dry: true, log: (l: string) => lines.push(l) };
  for (const hostname of ['', 'localhost', 'https://swarm.example.com', 'bad host.com', '-bad.example.com']) {
    assert.equal(validTunnelHostname(hostname), false);
    await assert.rejects(setupTunnel({ ...options, hostname }), /hostname/);
  }
  assert.equal(lines.length, 0, 'invalid hostnames fail before any tunnel work');
  assert.equal(validTunnelHostname('swarm.example.com'), true);
  const result = await setupTunnel({ ...options, hostname: 'swarm.example.com' });
  assert.equal(result.publicUrl, 'https://swarm.example.com');
  assert.match(lines.join('\n'), /approve your domain/);
  assert.match(lines.join('\n'), /\[dry-run\] cloudflared tunnel route dns swarmaa swarm\.example\.com/);
  assert.deepEqual(readdirSync(root), [], 'dry run writes nothing');
});

// ---- onboarding server ----

interface Res { status: number; body: string; json: () => any }
function req(base: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Res> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: u.port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${u.port}`, ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => ok({ status: res.statusCode!, body: b, json: () => JSON.parse(b) }));
    });
    r.on('error', fail);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

async function withServer(fn: (ctx: { base: string; token: string; t: (extra?: Record<string, string>) => Record<string, string>; calls: { dry: boolean }[] }) => Promise<void>, idleMs = 0) {
  const calls: { dry: boolean }[] = [];
  const fakeRun = (async (_p, o) => { calls.push({ dry: o.dry }); o.log('hello'); o.onStep?.({ id: 'db', label: 'Database', status: 'ok' }); return { dry: o.dry, ok: true, agents: [], workers: [], edits: [], sharing: [], projects: [], serviceUrl: 'http://127.0.0.1:8787', steps: [], warnings: [], nextSteps: [] } satisfies SetupSummary; }) as typeof runSetup;
  const ob = createOnboarding({ dry: true, idleMs, run: fakeRun, detectFn: async () => fakeDetected(), html: '<!doctype html><title>Swarmaa</title>' });
  const url = await ob.listen();
  const base = new URL(url).origin;
  try { await fn({ base, token: ob.token, t: (extra = {}) => ({ 'x-swarmaa-token': ob.token, ...extra }), calls }); } finally { ob.close(); await ob.closed; }
}
const json = { 'content-type': 'application/json' };

test('server: page needs the token, Host and Origin are enforced', async () => {
  await withServer(async ({ base, token, t }) => {
    assert.equal((await req(base, `/?t=${token}`)).status, 200);
    assert.equal((await req(base, '/')).status, 403);
    assert.equal((await req(base, '/?t=wrong')).status, 403);
    assert.equal((await req(base, `/?t=${token.slice(1)}`)).status, 403);
    assert.equal((await req(base, `/?t=${token}`, { host: 'evil.example:80' })).status, 403);
    assert.equal((await req(base, `/?t=${token}`, { host: 'localhost' })).status, 403);
    assert.equal((await req(base, '/api/detect')).status, 403);
    assert.equal((await req(base, `/api/detect?t=${token}`)).status, 403, 'query token only works for the page');
    assert.equal((await req(base, '/api/detect', { headers: t({ origin: 'http://evil.example' }) })).status, 403);
    assert.equal((await req(base, '/api/detect', { headers: t({ origin: 'null' }) })).status, 403);
    assert.equal((await req(base, '/api/detect', { headers: t({ 'sec-fetch-site': 'cross-site' }) })).status, 403);
    const ok = await req(base, '/api/detect', { headers: t({ origin: base }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().installed, { claude: true, codex: true, agy: false, notchtrader: false });
    assert.equal(ok.json().defaultHostname, '');
    assert.equal(ok.body.includes('/bin/claude-fake'), false, 'binary paths are not sent to the page');
  });
});

test('server: actions are JSON POST only, bounded, validated', async () => {
  await withServer(async ({ base, t, calls }) => {
    assert.equal((await req(base, '/api/run', { headers: t() })).status, 405);
    assert.equal((await req(base, '/api/detect', { method: 'POST', headers: t(json), body: '{}' })).status, 405);
    assert.equal((await req(base, '/api/nope', { headers: t() })).status, 404);
    assert.equal((await req(base, '/api/run', { method: 'POST', headers: t({ 'content-type': 'text/plain' }), body: '{}' })).status, 415);
    assert.equal((await req(base, '/api/run', { method: 'POST', headers: t(json), body: '{not json' })).status, 400);
    assert.equal((await req(base, '/api/run', { method: 'POST', headers: t(json), body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) }).catch(() => ({ status: 413 }))).status, 413);
    const bad = await req(base, '/api/run', { method: 'POST', headers: t(json), body: JSON.stringify({ plan: { harnesses: { evil: {} }, folders: ['rel'], autostart: true, remote: { hostname: 'x' } } }) });
    assert.equal(bad.status, 400);
    assert.ok(bad.json().details.length >= 3);
    assert.equal(calls.length, 0, 'nothing ran for invalid plans');
  });
});

test('server: a dry plan runs, is forced dry, and the job is readable', async () => {
  await withServer(async ({ base, t, calls }) => {
    const r = await req(base, '/api/run', { method: 'POST', headers: t(json), body: JSON.stringify({ dry: false, plan: { ...okPlan(), harnesses: { claude: { connect: true } } } }) });
    assert.equal(r.status, 202);
    assert.equal(r.json().dry, true, 'server started with --dry-run ignores dry:false');
    let job: any;
    for (let i = 0; i < 50; i++) { job = (await req(base, '/api/job?after=0', { headers: t() })).json(); if (!job.running && job.summary) break; await new Promise(r => setTimeout(r, 20)); }
    assert.deepEqual(calls, [{ dry: true }]);
    assert.deepEqual(job.lines, ['hello']);
    assert.equal(job.summary.ok, true);
    assert.equal(job.steps[0].id, 'db');
    assert.deepEqual((await req(base, '/api/job?after=1', { headers: t() })).json().lines, []);
    assert.equal((await req(base, '/api/close', { method: 'POST', headers: t(json), body: '{}' })).status, 200);
  });
});

test('server: shuts down after the idle timeout', async () => {
  const ob = createOnboarding({ dry: true, idleMs: 30, html: 'x' });
  await ob.listen();
  await ob.closed;
});

test('onboarding page contains no secrets and no inline token', () => {
  const html = readFileSync(new URL('../scripts/onboarding.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /[A-Za-z0-9_-]{32,}/, 'no long opaque strings');
  assert.doesNotMatch(html, /Bearer|password\s*[:=]|api[_-]?key/i);
  try {
    const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
    for (const v of Object.values(env)) if (v.length >= 8) assert.ok(!html.includes(v), 'an .env value appears in the page');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  assert.match(html, /Set up your swarm/);
  assert.match(html, /swarm\.example\.com/);
  assert.doesNotMatch(html, /<input[^>]*id="remoteOn"[^>]*checked/);
  assert.doesNotMatch(html, /swarmaa\.com/);
});

test('folder entries can name their scope', async () => {
  const { slugScopes, splitFolder } = await import('../scripts/setup-lib.js');
  assert.deepEqual(splitFolder('fametc=/x/Planner'), { name: 'fametc', path: '/x/Planner' });
  assert.deepEqual(slugScopes(['fametc=/x/Planner', '/y/Futuremap']).map(s => s.scope), ['project:fametc', 'project:futuremap']);
});

test('scriptCommand picks compiled dist/*.js without tsx and tsx otherwise', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { scriptCommand, isCompiled, packageRoot } = await import('../scripts/setup-lib.js');
  const root = mkdtempSync(join(tmpdir(), 'swarmaa-cmd-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'dist/scripts'), { recursive: true });
    assert.equal(isCompiled(root), true);
    assert.deepEqual(scriptCommand(root, 'scripts/admin', { envFile: true }), [`--env-file=${join(root, '.env')}`, join(root, 'dist/scripts/admin.js')]);
    assert.equal(packageRoot(join(root, 'dist/scripts')), root);
    mkdirSync(join(root, 'node_modules/tsx'), { recursive: true });
    assert.equal(isCompiled(root), false);
    assert.deepEqual(scriptCommand(root, 'scripts/migrate'), ['--import', 'tsx', join(root, 'scripts/migrate.ts')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- worker edit opt-in: config and grant are provisioned together ----

/** Setup-built bridge config -> parser -> capabilities -> claim kinds (the rule in BridgeWorker.claimAndRun). */
function claimFor(edit: boolean) {
  const cfg = parseBridgeConfig(bridgeConfig({ port: 8787, tokenFile: '/t', agent: { id: 'claude', binary: '/b/claude' }, projects: [{ scope: 'project:demo', root: '/r/demo' }], edit }));
  const capabilities = projectCapabilities(cfg.projects[0]!, cfg.agents);
  return { capabilities, kinds: capabilities.some(c => c.endsWith('.patch')) ? ['research', 'review', 'patch'] : ['research', 'review'] };
}

test('edit requires worker; default is read-only', () => {
  rejects({ ...okPlan(), harnesses: { claude: { connect: true, edit: true } } }, /edit requires worker/);
  assert.equal(validatePlan(okPlan()).harnesses.claude!.edit, false);
  assert.equal(validatePlan({ ...okPlan(), harnesses: { claude: { connect: true, worker: true, edit: true } } }).harnesses.claude!.edit, true);
});

test('setup-to-claim: read-only requests research/review only, edit requests patch and provisions task:patch', async () => {
  const ro = claimFor(false), rw = claimFor(true);
  assert.deepEqual(ro.kinds, ['research', 'review']);
  assert.deepEqual(ro.capabilities, ['claude.read', 'auto.read']);
  assert.ok(rw.kinds.includes('patch') && rw.capabilities.includes('claude.patch') && rw.capabilities.includes('auto.patch'));
  const dry = async (edit: boolean, root: string) => {
    const lines: string[] = [];
    const plan = validatePlan({ harnesses: { claude: { connect: true, worker: true, edit } }, folders: [dir], autostart: false });
    const s = await runSetup(plan, { dry: true, log: l => lines.push(l), root, detected: fakeDetected() });
    assert.equal(s.ok, true, String(s.error));
    assert.deepEqual(s.edits, edit ? ['claude'] : []);
    return lines.filter(l => l.includes('admin.ts') && l.includes('worker-claude'));
  };
  const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-root-')));
  const [ro1] = await dry(false, fresh()), [rw1] = await dry(true, fresh());
  assert.doesNotMatch(ro1!, /task:patch/);
  assert.match(rw1!, /--grant task:patch/);
  // re-run on an existing worker reconciles the grant either way
  const existing = fresh();
  mkdirSync(join(existing, '.local'));
  writeFileSync(join(existing, '.local/worker-claude.json'), '{}');
  assert.match((await dry(true, existing)).join('\n'), /\bgrant --name worker-claude --permission task:patch/);
  assert.match((await dry(false, existing)).join('\n'), /revoke-grant --name worker-claude --permission task:patch/);
});

test('demo project is planned as a standalone git repo', async () => {
  const lines: string[] = [];
  await runSetup(validatePlan({ harnesses: {}, folders: [], autostart: false }), { dry: true, log: l => lines.push(l), root: realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-root-'))), detected: fakeDetected() });
  assert.ok(lines.some(l => /git -C \S*demo-project init -q -b main/.test(l)));
  assert.ok(lines.some(l => /demo-project -c commit\.gpgsign=false commit/.test(l)));
});
