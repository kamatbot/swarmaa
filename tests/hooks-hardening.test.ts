import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { codingCliToolNames } from '../src/core/tools.js';
import { guardedPostToolUseCommand, guardedTurnCommand, installInboxHooks, installJournalHooks } from '../scripts/hooks-install.js';
import { deployLocal, type DeployIO } from '../scripts/deploy-local.js';
import { checkNodeVersion, createOnboarding, runSetup, type Detected, type SetupSummary } from '../scripts/setup.js';
import { AGY_TOOLS, NATIVE_APP_PERMISSIONS, validatePlan } from '../scripts/setup-lib.js';
import { validHostname as validTunnelHostname } from '../scripts/tunnel.js';

const INBOX: Record<string, any> = await import(resolve('clients/hooks/swarmaa-inbox.mjs'));
const MEMORY: Record<string, any> = await import(resolve('clients/hooks/swarmaa-memory.mjs'));
const JOURNAL: Record<string, any> = await import(resolve('clients/hooks/swarmaa-journal.mjs'));
const temp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `${p}-`)));

test('acquireLock recovers stale .guard directories (>5s) and pruneStaleState removes >7d idle dirs only', t => {
  const base = temp('lock-prune');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'sess-a');
  mkdirSync(join(dir, 'waiter.guard'), { recursive: true });
  const staleTime = new Date(Date.now() - 10_000);
  utimesSync(join(dir, 'waiter.guard'), staleTime, staleTime);
  const release = INBOX.acquireLock(dir, 'waiter', { staleGuardMs: 5000, retries: 1 });
  assert.ok(release, 'stale guard should be reclaimed');
  release();

  const oldDir = join(base, 'old-session');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'accepted.json'), '[]');
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(join(oldDir, 'accepted.json'), tenDaysAgo, tenDaysAgo);
  utimesSync(oldDir, tenDaysAgo, tenDaysAgo);

  const liveDir = join(base, 'live-session');
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, 'waiter.json'), JSON.stringify({ pid: process.pid, nonce: 'x' }));
  utimesSync(join(liveDir, 'waiter.json'), tenDaysAgo, tenDaysAgo);
  utimesSync(liveDir, tenDaysAgo, tenDaysAgo);

  const removed = INBOX.pruneStaleState(base, 7 * 24 * 60 * 60 * 1000, { force: true });
  assert.equal(removed, 1);
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(liveDir), true);
});

test('Claude Stop waiter retries transient errors with exponential backoff and logs status words without secrets', async t => {
  const root = temp('wait-retry-root'), home = temp('wait-retry-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, '.local'), { recursive: true });
  const secretToken = 'cn_secret_token_never_logged_123456';
  writeFileSync(join(root, '.local', 'claude.json'), JSON.stringify({ id: randomUUID(), token: secretToken }));
  let attempts = 0;
  const delivery_id = randomUUID();
  const server = createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.statusCode = 503;
      res.end('restarting');
      return;
    }
    res.end(JSON.stringify({ result: { items: [{ delivery_id, body: 'Recovered wake body' }] } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(root, '.env'), `PORT=${(server.address() as { port: number }).port}\n`);

  const out = await INBOX.run('claude', 'Stop', { session_id: 'retry-s' }, { root, home, waitMs: 5000, backoffMs: [10, 20, 40] });
  assert.equal(attempts, 3);
  assert.match(out.wake, /Recovered wake body/);
  const log = readFileSync(join(root, '.local', 'logs', 'inbox.log'), 'utf8');
  assert.match(log, /wait-http-503/);
  assert.equal(log.includes(secretToken), false);
  assert.equal(log.includes('Recovered wake body'), false);
});

test('agy hooks always emit {} on stdout on no-op, already-injected, and error', async t => {
  const root = temp('agy-contract-root'), home = temp('agy-contract-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, 'clients', 'hooks'), { recursive: true });
  mkdirSync(join(root, '.local'), { recursive: true });
  for (const f of ['swarmaa-inbox.mjs', 'swarmaa-memory.mjs', 'swarmaa-journal.mjs']) {
    copyFileSync(resolve('clients/hooks', f), join(root, 'clients', 'hooks', f));
  }
  const execHook = (file: string, args: string[], stdin: string) => new Promise<{ code: number | null; out: string; err: string }>(res => {
    const child = spawn(process.execPath, [join(root, 'clients', 'hooks', file), ...args], { env: { PATH: process.env.PATH, HOME: home }, timeout: 4000 });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => res({ code, out, err }));
    child.stdin.end(stdin);
  });

  // No token -> no-op; malformed JSON -> error; both must emit "{}\n" for agy
  for (const [file, args, stdin] of [
    ['swarmaa-inbox.mjs', ['agy', 'PreInvocation'], JSON.stringify({ conversationId: 'c1' })],
    ['swarmaa-inbox.mjs', ['agy', 'Stop'], '{bad json'],
    ['swarmaa-memory.mjs', ['agy', 'PreInvocation'], JSON.stringify({ conversationId: 'c1', workspacePaths: ['/tmp'] })],
    ['swarmaa-memory.mjs', ['agy', 'PreInvocation'], '{bad json'],
    ['swarmaa-journal.mjs', ['agy'], '{bad json'],
  ] as const) {
    const r = await execHook(file, [...args], stdin);
    assert.equal(r.code, 0, `${file} ${args.join(' ')}`);
    assert.equal(r.out, '{}\n', `${file} ${args.join(' ')} stdout`);
  }
});

test('swarmaa-memory uses harness-appropriate tool names and prunes >14d markers', async t => {
  const root = temp('mem-names-root'), home = temp('mem-names-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, '.local'), { recursive: true });
  for (const n of ['claude', 'codex', 'antigravity']) writeFileSync(join(root, '.local', `${n}.json`), JSON.stringify({ token: 'tok' }));
  writeFileSync(join(root, '.local', 'bridge-claude.json'), JSON.stringify({ projects: [{ scope: 'project:extra', root: '/work/extra' }] }));
  const server = createServer((_req, res) => res.end(JSON.stringify({ result: { memories: [{ key: 'k', content: 'v' }], lessons: [] } })));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(root, '.env'), `PORT=${(server.address() as { port: number }).port}\n`);

  const claudeOut = await MEMORY.run('claude', 'SessionStart', { cwd: '/work/extra/src' }, { root, home });
  assert.match(claudeOut.hookSpecificOutput.additionalContext, /mcp__swarma__memory_search/);
  const codexOut = await MEMORY.run('codex', 'SessionStart', { cwd: '/work/extra/src' }, { root, home });
  assert.match(codexOut.hookSpecificOutput.additionalContext, /More: memory_search \/ context_get/);
  assert.doesNotMatch(codexOut.hookSpecificOutput.additionalContext, /mcp__swarma__/);
  const agyOut = await MEMORY.run('agy', 'PreInvocation', { conversationId: 'conv-tools', workspacePaths: ['/work/extra'] }, { root, home });
  assert.match(agyOut.injectSteps[0].ephemeralMessage, /More: memory_search \/ context_get/);
  assert.doesNotMatch(agyOut.injectSteps[0].ephemeralMessage, /mcp__swarma__/);

  // loadProjectRoots merges setup.json and bridge-*.json (used by swarmaa-journal too)
  assert.equal(JOURNAL.resolveScope('/work/extra/sub', JOURNAL.loadProjectRoots(root)), 'project:extra');

  // Marker pruning (>14d)
  const mdir = join(home, '.swarma', 'memory-hook');
  const stale = join(mdir, 'stale-marker');
  writeFileSync(stale, '');
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.equal(MEMORY.pruneMemoryMarkers(mdir, 14 * 24 * 60 * 60 * 1000, { force: true }), 1);
  assert.equal(existsSync(stale), false);
});

test('PostToolUse dirty-flag POSIX guard skips node cold start when clean and falls back when dirty, pending, or inactive', t => {
  const root = temp('guard-root'), home = temp('guard-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const id = randomUUID();
  mkdirSync(join(root, '.local'), { recursive: true });
  writeFileSync(join(root, '.local', 'claude.json'), JSON.stringify({ id, token: 't' }));
  const ranMarker = join(root, 'node-ran');
  const fakeNode = join(root, 'fake-node.sh');
  writeFileSync(fakeNode, `#!/bin/sh\necho ran > "${ranMarker}"\n`, { mode: 0o755 });

  const cmd = guardedPostToolUseCommand('claude', root, `'${fakeNode}' arg1`);
  const runGuard = () => {
    rmSync(ranMarker, { force: true });
    const r = spawnSync('/bin/sh', ['-c', cmd], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return existsSync(ranMarker);
  };

  // 1. .active absent -> falls back to running node
  assert.equal(runGuard(), true);

  // 2. .active present, no flag, no accepted/pending -> exits 0 with ZERO node spawn
  mkdirSync(join(home, '.swarmaa', 'inbox-dirty'), { recursive: true });
  writeFileSync(join(home, '.swarmaa', 'inbox-dirty', '.active'), '');
  assert.equal(runGuard(), false);

  // 3. dirty flag present -> runs node
  const flag = join(home, '.swarmaa', 'inbox-dirty', `${id}.flag`);
  writeFileSync(flag, '');
  assert.equal(runGuard(), true);
  rmSync(flag);

  // 4. pending local ack journal present -> runs node
  mkdirSync(join(home, '.swarma', 'inbox', 'sesshash'), { recursive: true });
  writeFileSync(join(home, '.swarma', 'inbox', 'sesshash', 'accepted.json'), '["d1"]');
  assert.equal(runGuard(), true);
});

test('turn hook POSIX fast-path guard skips node when no state.json exists, passes /swarm and $swarm prompts, and emits {} for agy', t => {
  const root = temp('turn-guard-root'), home = temp('turn-guard-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const captured = join(root, 'captured-stdin');
  const fakeNode = join(root, 'fake-node.sh');
  writeFileSync(fakeNode, `#!/bin/sh\ncat > "${captured}"\nprintf '{"ok":true}\\n'\n`, { mode: 0o755 });

  const runCmd = (cmd: string, input: string) => {
    rmSync(captured, { force: true });
    const r = spawnSync('/bin/sh', ['-c', cmd], { input, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { ran: existsSync(captured), stdin: existsSync(captured) ? readFileSync(captured, 'utf8').trim() : '', stdout: r.stdout };
  };

  const stopClaude = guardedTurnCommand('claude', 'Stop', `'${fakeNode}' claude Stop`);
  const stopAgy = guardedTurnCommand('agy', 'Stop', `'${fakeNode}' agy Stop`);
  const promptClaude = guardedTurnCommand('claude', 'UserPromptSubmit', `'${fakeNode}' claude UserPromptSubmit`);
  const promptAgy = guardedTurnCommand('agy', 'UserPromptSubmit', `'${fakeNode}' agy UserPromptSubmit`);

  // 1. No state.json -> Stop skips node (and agy emits {})
  assert.deepEqual(runCmd(stopClaude, '{"session_id":"s1"}'), { ran: false, stdin: '', stdout: '' });
  assert.deepEqual(runCmd(stopAgy, '{"conversationId":"c1"}'), { ran: false, stdin: '', stdout: '{}\n' });

  // 2. No state.json + normal prompt -> UserPromptSubmit skips node (and agy emits {})
  assert.deepEqual(runCmd(promptClaude, '{"session_id":"s1","prompt":"explain this function"}'), { ran: false, stdin: '', stdout: '' });
  assert.deepEqual(runCmd(promptAgy, '{"conversationId":"c1","prompt":"hello"}'), { ran: false, stdin: '', stdout: '{}\n' });

  // 3. No state.json + /swarm, $swarm, JSON-escaped \/swarm, or expanded command marker -> runs node with intact stdin
  for (const payload of [
    '{"session_id":"s1","prompt":"/swarm review on"}',
    '{"session_id":"s1","prompt":"$swarm handoff"}',
    '{"session_id":"s1","prompt":"\\/swarm review on"}',
    '{"session_id":"s1","prompt":"<!-- swarma:swarm-command -->\\nARGS: review off"}',
  ]) {
    const res = runCmd(promptClaude, payload);
    assert.equal(res.ran, true, `should run for ${payload}`);
    assert.equal(res.stdin, payload);
    assert.equal(res.stdout, '{"ok":true}\n');
  }

  // 4. Active state.json exists -> both Stop and UserPromptSubmit run node directly with intact stdin
  mkdirSync(join(home, '.swarma', 'turn', 'abc123'), { recursive: true });
  writeFileSync(join(home, '.swarma', 'turn', 'abc123', 'state.json'), '{"review":{"on":true}}');
  const stopRes = runCmd(stopClaude, '{"session_id":"s1"}');
  assert.equal(stopRes.ran, true);
  assert.equal(stopRes.stdin, '{"session_id":"s1"}');
  const promptRes = runCmd(promptClaude, '{"session_id":"s1","prompt":"normal message"}');
  assert.equal(promptRes.ran, true);
  assert.equal(promptRes.stdin, '{"session_id":"s1","prompt":"normal message"}');
});

test('installJournalHooks accepts explicit node path and installInboxHooks leaves task_submit unguarded', async t => {
  const root = temp('inst-root'), home = temp('inst-home');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  await installJournalHooks('claude', { root, home, dry: false, node: '/opt/homebrew/bin/node', log: () => {} });
  await installInboxHooks('claude', { root, home, dry: false, node: '/opt/homebrew/bin/node', log: () => {} });
  const cfg = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const journalCmd = cfg.hooks.SessionEnd[0].hooks[0].command as string;
  assert.ok(journalCmd.startsWith('/opt/homebrew/bin/node '), journalCmd);
  const nonSubmit = cfg.hooks.PostToolUse.find((g: any) => g.matcher === '^(?!mcp__swarma__task_submit$).*');
  const submit = cfg.hooks.PostToolUse.find((g: any) => g.matcher === '^mcp__swarma__task_submit$');
  assert.ok(nonSubmit.hooks[0].command.includes('inbox-dirty/.active'));
  assert.equal(submit.hooks[0].command.includes('inbox-dirty/.active'), false);
});

test('swarma-mcp.sh parses .env PORT safely and invokes stdio-proxy in a single Node process with --token-file', t => {
  const root = temp('launcher-root');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'clients', 'macos'), { recursive: true });
  mkdirSync(join(root, '.local'), { recursive: true });
  copyFileSync(resolve('clients/macos/swarma-mcp.sh'), join(root, 'clients', 'macos', 'swarma-mcp.sh'));
  chmodSync(join(root, 'clients', 'macos', 'swarma-mcp.sh'), 0o755);
  writeFileSync(join(root, '.env'), '# PORT=1111\nexport PORT="9123" # inline comment\n');
  writeFileSync(join(root, '.local', 'claude.json'), JSON.stringify({ token: 'secret' }));
  const fakeNode = join(root, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });

  const r = spawnSync('/bin/sh', [join(root, 'clients', 'macos', 'swarma-mcp.sh'), 'claude'], {
    env: { PATH: '/usr/bin:/bin', SWARMAA_NODE: fakeNode }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const args = r.stdout.trim().split('\n');
  assert.deepEqual(args, [
    join(root, 'dist/src/stdio-proxy.js'),
    '--url', 'http://127.0.0.1:9123',
    '--token-file', join(root, '.local/claude.json'),
  ]);
});

test('setup helpers: AGY_TOOLS matches codingCliToolNames, checkNodeVersion, tilde folder expansion, punycode tunnel, and mac grants', async t => {
  assert.deepEqual(AGY_TOOLS, codingCliToolNames());
  assert.equal(checkNodeVersion('22.12.0').ok, false);
  assert.equal(checkNodeVersion('24.5.0').ok, true);
  assert.equal(checkNodeVersion('24.5.0').warning, undefined);
  assert.equal(checkNodeVersion('25.1.0').ok, true);
  assert.ok(checkNodeVersion('25.1.0').warning);
  assert.equal(validTunnelHostname('xn--bcher-kva.example'), true);

  // Tilde expansion in validatePlan
  const subDir = temp('tilde-test');
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const p = validatePlan({ harnesses: {}, folders: ['~'], autostart: false });
  assert.deepEqual(p.folders, [realpathSync(homedir())].map(x => x) || [homedir()]);

  // Mac app permissions + /swarm command + agy mcp remove before add
  const root = temp('setup-mac-root');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const det: Detected = { clis: { agy: '/bin/agy-fake' }, mac: true, postgres: { found: true, reachable: true }, envExists: false, state: {} };
  const s = await runSetup(validatePlan({ harnesses: { agy: { connect: true }, mac: { connect: true } }, folders: [], autostart: false }), { dry: true, root, detected: det, log: l => lines.push(l) });
  assert.equal(s.ok, true, String(s.error));
  const macCmd = lines.find(l => l.includes('admin.ts') && l.includes('--name swarmaa-mac')) ?? '';
  for (const perm of NATIVE_APP_PERMISSIONS) assert.ok(macCmd.includes(`--grant ${perm}`), `missing ${perm}`);
  assert.ok(lines.some(l => l.includes('/bin/agy-fake mcp remove swarma')));
  assert.ok(lines.some(l => l.includes('/bin/agy-fake mcp add swarma -- /bin/sh')));
  assert.ok(s.steps.some(st => st.id === 'swarm-cmd' && st.status === 'ok'));
});

test('createOnboarding dynamically redacts .env secrets created after startup', async t => {
  const root = temp('redact-root');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const generatedSecret = 'super_secret_first_run_password_999';
  const ob = createOnboarding({
    dry: false, root, idleMs: 0,
    detectFn: async () => ({ clis: {}, mac: false, postgres: { found: true, reachable: true }, envExists: false, state: {} }),
    run: (async (_p, o) => {
      writeFileSync(join(root, '.env'), `POSTGRES_PASSWORD=${generatedSecret}\n`);
      o.log(`leaked ${generatedSecret}`);
      return { dry: false, ok: true, agents: [], workers: [], edits: [], sharing: [], projects: [], serviceUrl: 'http://127.0.0.1:8787', steps: [], warnings: [], nextSteps: [] } satisfies SetupSummary;
    }) as typeof runSetup,
  });
  const url = await ob.listen();
  const u = new URL(url);
  t.after(async () => { ob.close(); await ob.closed; });
  const reqJson = (method: string, path: string, body?: string) => new Promise<{ status: number; json: () => any }>((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: u.port, path, method, headers: { host: `127.0.0.1:${u.port}`, 'x-swarmaa-token': ob.token, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => ok({ status: res.statusCode!, json: () => JSON.parse(b) }));
    });
    r.on('error', fail);
    if (body) r.write(body);
    r.end();
  });
  const startRes = await reqJson('POST', '/api/run', JSON.stringify({ plan: { harnesses: {}, folders: [], autostart: false } }));
  assert.equal(startRes.status, 202);
  let job: any;
  for (let i = 0; i < 40; i++) {
    job = (await reqJson('GET', '/api/job?after=0')).json();
    if (!job.running && job.summary) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(job.lines.some((l: string) => l.includes('[redacted]')));
  assert.equal(JSON.stringify(job).includes(generatedSecret), false);
});

test('deployLocal enforces --drain-timeout instead of hanging forever', async () => {
  let sleeps = 0;
  const io: DeployIO = {
    uid: 501, port: '8787',
    command: (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        if (args.length === 1) return 'PID Status Label\n101 0 com.swarma.bridge.claude\n';
        return '{ "PID" = 101; }';
      }
      return '';
    },
    signal: () => {},
    sleep: async () => { sleeps++; },
    status: async () => [],
    healthy: async () => true,
    log: () => {},
  };
  await assert.rejects(deployLocal(['--drain-timeout', '4'], io), /Drain timed out after 4s/);
  assert.equal(sleeps, 2);
});
