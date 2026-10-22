import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOnboarding, runSetup, type Detected, type SetupSummary } from '../scripts/setup.js';
import { AGY_TOOLS, GENERAL_SCOPE, PlanError, WORKER_HARNESSES, bridgeConfig, identityScopes, mergeAgyPermissions, parseEnv, plist, slugScopes, stateFile, validHostname, validatePlan, yes } from '../scripts/setup-lib.js';

test('slugScopes normalizes basenames and suffixes collisions', () => {
  assert.deepEqual(slugScopes(['/a/My App!', '/b/my-app', '/c/My App!', '/a/My App!', '/d/Demo']).map(s => s.scope),
    ['project:my-app', 'project:my-app-2', 'project:my-app-3', 'project:demo']);
  assert.deepEqual(slugScopes(['/x/demo', '/y/Demo'], ['demo']).map(s => s.scope), ['project:demo-2', 'project:demo-3']);
  assert.equal(slugScopes(['/x/___'])[0]!.scope, 'project:project');
});

test('plist escapes strings and sets launchd keys', () => {
  const x = plist('com.swarma.t', ['/bin/node', 'a&b<c>"\''], { workingDirectory: '/r', env: { PATH: '/a:/b', HOME: '/h' }, stdout: '/l/o.log', stderr: '/l/o.log' });
  assert.match(x, /a&amp;b&lt;c&gt;&quot;&apos;/);
  for (const k of ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'ProcessType', 'Background', 'WorkingDirectory', 'StandardOutPath']) assert.ok(x.includes(k), k);
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
  assert.deepEqual(c.agents, [{ id: 'claude', provider: 'claude', binary: '/b/claude', model: 'sonnet', enable_patch: true }]);
  assert.deepEqual(c.projects, [{ scope: 'project:demo', root: '/r/demo', agents: ['claude'], allow_patch: true }]);
  assert.equal(c.reason, null);
  const agy = bridgeConfig({ port: 1, tokenFile: '/t', agent: { id: 'antigravity', provider: 'antigravity', binary: '/b/agy' }, projects: [{ scope: 'project:demo', root: '/r/demo' }] }) as any;
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

test('validatePlan accepts a good plan and fills defaults', () => {
  const p = validatePlan({ ...okPlan(), harnesses: { claude: { connect: true, worker: true }, agy: { connect: true }, grok: { connect: true }, codex: { connect: false, worker: true } }, remote: { hostname: ' API.Example.com ' } });
  assert.deepEqual(p.folders, [dir]);
  assert.deepEqual(p.harnesses.claude, { connect: true, worker: true, share: true });
  assert.deepEqual(p.harnesses.agy, { connect: true, worker: false, share: true });
  assert.deepEqual(p.harnesses.grok, { connect: true, worker: false, share: false });
  assert.deepEqual(p.harnesses.codex, { connect: false, worker: false, share: false });
  assert.deepEqual(p.remote, { hostname: 'api.example.com' });
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
  assert.equal(validHostname('api.swarmaa.com'), 'api.swarmaa.com');
  assert.equal(validHostname('xn--bcher-kva.example'), 'xn--bcher-kva.example');
});

test('interactive identities get project:general, workers never do', () => {
  const projects = [{ scope: 'project:demo', root: '/d' }, { scope: 'project:app', root: '/a' }];
  assert.deepEqual(identityScopes('interactive', projects), ['project:demo', 'project:app', GENERAL_SCOPE]);
  assert.deepEqual(identityScopes('worker', projects), ['project:demo', 'project:app']);
  assert.equal(GENERAL_SCOPE, 'project:general');
});

test('setup.json carries projects as [{scope, root}] including project:demo', () => {
  const projects = [{ scope: 'project:demo', root: '/d' }, ...slugScopes(['/x/App'], ['demo'])];
  const s = stateFile({ folders: ['/x/App'], projects, agents: ['claude'], workers: [], sharing: ['claude'], autostart: true, remote: { hostname: 'api.swarmaa.com' } });
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
  assert.deepEqual(s.agents, ['claude', 'codex', 'grok', 'dot']);
  assert.deepEqual(s.workers, ['claude']);
  const cmd = (name: string) => lines.find(l => l.includes('admin.ts') && l.includes(`--name ${name}`)) ?? '';
  for (const n of ['claude-interactive', 'codex-interactive', 'grok', 'dot']) assert.match(cmd(n), /--scopes \S*project:general\b/, n);
  assert.match(cmd('worker-claude'), /--role worker/);
  assert.doesNotMatch(cmd('worker-claude'), /project:general/);
  assert.match(cmd('worker-claude'), /project:demo,project:/);
  assert.match(text, /write .*setup\.json/);
  assert.match(text, /\[dry-run\]/);
  assert.deepEqual(s.projects.map(p => p.scope)[0], 'project:demo');
  assert.ok(s.nextSteps.some(n => /Grok/.test(n) && /clients\/grok\/README\.md/.test(n)));
  assert.equal(s.mcpUrl, undefined);
  // dry run wrote nothing into the fresh root
  assert.throws(() => readFileSync(join(root, '.local/setup.json')));
});

test('runSetup reports a failing tunnel or hook per item instead of aborting', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-root-')));
  const plan = validatePlan({ harnesses: { claude: { connect: true }, grok: { connect: true } }, folders: [], remote: { hostname: 'api.example.com' }, autostart: false });
  const s = await runSetup(plan, { dry: true, log: () => undefined, root, detected: fakeDetected() });
  assert.equal(s.ok, true);
  assert.ok(s.steps.some(x => x.id === 'remote'), 'remote step recorded');
  assert.equal(s.steps.at(-1)!.id, 'save');
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
  const fakeRun = (async (_p, o) => { calls.push({ dry: o.dry }); o.log('hello'); o.onStep?.({ id: 'db', label: 'Database', status: 'ok' }); return { dry: o.dry, ok: true, agents: [], workers: [], sharing: [], projects: [], serviceUrl: 'http://127.0.0.1:8787', steps: [], warnings: [], nextSteps: [] } satisfies SetupSummary; }) as typeof runSetup;
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
  assert.match(html, /api\.swarmaa\.com|defaultHostname/);
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
