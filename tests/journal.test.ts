import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { installJournalHooks, installSwarmCommand, removeJournalHooks, type Harness } from '../scripts/hooks-install.js';

const SCRIPT = resolve(process.cwd(), 'clients/hooks/swarmaa-journal.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J: Record<string, any> = await import(SCRIPT);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `${p}-`));
const jsonl = (...o: unknown[]) => o.map(x => JSON.stringify(x)).join('\n') + '\n';

// ---- payload parsers (shapes confirmed from vendor docs; see report) ----
test('parseClaudePayload reads Stop and SessionEnd stdin', () => {
  const stop = { session_id: 'abc123', transcript_path: '/h/.claude/projects/x/abc123.jsonl', cwd: '/w/app', permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' };
  assert.deepEqual(J.parseClaudePayload(stop), { session_id: 'abc123', cwd: '/w/app', transcriptPath: '/h/.claude/projects/x/abc123.jsonl', ended: false, lastAssistant: 'Done.' });
  const end = J.parseClaudePayload({ session_id: 'abc123', transcript_path: '/t.jsonl', cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(end.ended, true);
  assert.equal(J.parseClaudePayload({ cwd: '/w' }), null);
  assert.equal(J.parseClaudePayload('x'), null);
});

test('parseCodexPayload reads notify argv JSON (kebab-case) and ignores other types', () => {
  const p = J.parseCodexPayload({ type: 'agent-turn-complete', 'thread-id': 'th-1', 'turn-id': 'tu-9', cwd: '/w/app', 'input-messages': ['fix it', '', 'thanks'], 'last-assistant-message': 'Fixed.' });
  assert.deepEqual(p, { session_id: 'th-1', cwd: '/w/app', turnId: 'tu-9', inputMessages: ['fix it', 'thanks'], lastAssistant: 'Fixed.', ended: false });
  assert.equal(J.parseCodexPayload({ type: 'something-else', 'thread-id': 'x' }), null);
  assert.equal(J.parseCodexPayload({ type: 'agent-turn-complete' }), null);
  assert.equal(J.parseCodexPayload({ type: 'agent-turn-complete', thread_id: 'snake' }).session_id, 'snake');
});

test('parseAgyPayload reads camelCase hook stdin', () => {
  const p = J.parseAgyPayload({ conversationId: 'ec33', workspacePaths: ['/w/app', '/w/other'], transcriptPath: '/t/transcript.jsonl', artifactDirectoryPath: '/a', modelName: 'auto', executionNum: 1, terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.deepEqual(p, { session_id: 'ec33', cwd: '/w/app', transcriptPath: '/t/transcript.jsonl', ended: false });
  assert.equal(J.parseAgyPayload({ workspacePaths: [] }), null);
});

// ---- transcripts ----
const CLAUDE_FIXTURE = jsonl(
  { type: 'queue-operation', operation: 'enqueue' },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta caveat' } },
  { type: 'user', timestamp: '2026-10-22T01:00:00Z', message: { role: 'user', content: '<system-reminder>ignore</system-reminder>Build the journal please' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', timestamp: '2026-10-22T01:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading files.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Now add tests' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added tests.' }] } },
);

test('extractClaudeTurns keeps only user/assistant text', () => {
  const turns = J.extractClaudeTurns(CLAUDE_FIXTURE);
  assert.deepEqual(turns.map((t: { role: string; text: string }) => [t.role, t.text]), [
    ['user', 'Build the journal please'], ['assistant', 'Reading files.'], ['user', 'Now add tests'], ['assistant', 'Added tests.'],
  ]);
  assert.equal(turns[0].at, '2026-10-22T01:00:00Z');
});

test('extractAgyTurns maps USER_INPUT and text PLANNER_RESPONSE steps', () => {
  const fixture = jsonl(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-21T17:31:00Z', content: '<USER_REQUEST>\nCall the tool\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: {} }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'tool output' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-21T17:31:09Z', content: 'It worked.' },
  );
  assert.deepEqual(J.extractAgyTurns(fixture), [
    { role: 'user', text: 'Call the tool', at: '2026-10-21T17:31:00Z' },
    { role: 'assistant', text: 'It worked.', at: '2026-10-21T17:31:09Z' },
  ]);
});

// ---- scope, redaction, body, port ----
test('resolveScope uses longest path prefix on a directory boundary, else project:general', () => {
  const projects = [{ scope: 'project:a', root: '/w/a' }, { scope: 'project:ab', root: '/w/a/b/' }, { scope: 'project:ax', root: '/w/ax' }];
  assert.equal(J.resolveScope('/w/a/b/src', projects), 'project:ab');
  assert.equal(J.resolveScope('/w/a', projects), 'project:a');
  assert.equal(J.resolveScope('/w/a/c', projects), 'project:a');
  assert.equal(J.resolveScope('/w/ax/y', projects), 'project:ax');
  assert.equal(J.resolveScope('/w/abc', projects), 'project:general');
  assert.equal(J.resolveScope('', projects), 'project:general');
  assert.equal(J.resolveScope('/w/a', undefined), 'project:general');
});

test('redact masks common secret shapes and leaves prose alone', () => {
  const secrets = ['sk-ant-api03-AbCdEf0123456789xyz', 'cn_0123456789abcdefABCDEF', 'ghp_0123456789abcdefghij0123', 'github_pat_11ABCDEFG0123456789_abc', 'xai-0123456789abcdefghij', 'AKIAIOSFODNN7EXAMPLE'];
  for (const s of secrets) assert.equal(J.redact(`key ${s} end`), 'key [redacted] end', s);
  assert.equal(J.redact('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: [redacted]');
  assert.equal(J.redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----!'), '[redacted]!');
  assert.equal(J.redact('use sk-short and cn_x and a bearer of bad news'), 'use sk-short and cn_x and a bearer of bad news');
});

test('buildBody maps harness, clips, redacts, windows and bounds size', () => {
  const turns = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `t${i} cn_0123456789abcdefABCDEF ` + 'x'.repeat(9000) }));
  const b = J.buildBody({ harness: 'agy', session_id: 's', scope: 'project:general', title: 'T '.repeat(100), cwd: '/w', turns, ended: false });
  assert.equal(b.harness, 'antigravity');
  assert.ok(b.turns.length <= 40);
  assert.ok(b.turns.every((t: { text: string }) => t.text.length <= 8000 && t.text.includes('[redacted]')));
  assert.ok(b.title.length <= 120);
  assert.ok(Buffer.byteLength(JSON.stringify(b)) <= 128 * 1024);
  assert.equal(b.turns.at(-1).text.slice(0, 3), 't59');
  assert.equal(J.buildBody({ harness: 'claude', session_id: 's', scope: 'x', turns: [{ role: 'user', text: 'hi' }], ended: true }).harness, 'claude-code');
  assert.equal(J.buildBody({ harness: 'codex', session_id: 's', scope: 'x', turns: [{ role: 'user', text: 'hi' }] }).harness, 'codex');
});

test('readPort parses .env with default 8787', () => {
  assert.equal(J.readPort('A=1\nPORT=9911\n'), 9911);
  assert.equal(J.readPort('export PORT="9912"'), 9912);
  assert.equal(J.readPort('# PORT=1\nOTHER=2'), 8787);
});

// ---- Codex rolling cache ----
test('mergeCodexCache rolls a 40-turn window, replaces a repeated turn id and keeps the first title', () => {
  let cache: unknown = null;
  for (let i = 0; i < 30; i++) cache = J.mergeCodexCache(cache, { session_id: 's', turnId: `t${i}`, inputMessages: [`q${i}`], lastAssistant: `a${i}` }, 'T');
  const c = cache as { title: string; turns: { text: string }[] };
  assert.equal(c.turns.length, 40);
  assert.equal(c.turns[0]!.text, 'q10');
  assert.equal(c.turns.at(-1)!.text, 'a29');
  assert.equal(c.title, 'q0');
  const again = J.mergeCodexCache(cache, { session_id: 's', turnId: 't29', inputMessages: ['q29'], lastAssistant: 'a29-v2' }, 'T');
  assert.equal(again.turns.length, 40);
  assert.deepEqual(again.turns.slice(-2).map((t: { text: string }) => t.text), ['q29', 'a29-v2']);
});

// ---- hook install / remove against a temp HOME ----
const quiet = () => {};
const optsFor = (home: string, extra: { dry?: boolean } = {}) => ({ root: '/opt/swarma', dry: false, log: quiet, home, ...extra });
const read = (p: string) => readFileSync(p, 'utf8');

test('claude hooks: merge, idempotent, preserve others, remove, invalid JSON skipped', async () => {
  const home = tmp('home');
  const file = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  const original = { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } };
  writeFileSync(file, JSON.stringify(original));
  const r1 = await installJournalHooks('claude', optsFor(home));
  assert.deepEqual(r1.changed, [file]);
  const s = JSON.parse(read(file));
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(s.hooks.Stop.length, 2);
  assert.deepEqual(s.hooks.Stop[0], original.hooks.Stop[0]);
  const ours = { type: 'command', command: 'node "/opt/swarma/clients/hooks/swarmaa-journal.mjs" claude', timeout: 5 };
  assert.deepEqual(s.hooks.Stop[1], { hooks: [ours] });
  assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [ours] }]);
  const before = read(file);
  assert.deepEqual((await installJournalHooks('claude', optsFor(home))).changed, []);
  assert.equal(read(file), before);
  const r2 = await removeJournalHooks('claude', optsFor(home));
  assert.deepEqual(r2.changed, [file]);
  assert.deepEqual(JSON.parse(read(file)), original);
  assert.deepEqual((await removeJournalHooks('claude', optsFor(home))).changed, []);

  writeFileSync(file, '{ not json');
  const bad = await installJournalHooks('claude', optsFor(home));
  assert.ok(bad.skipped && bad.changed.length === 0);
  assert.equal(read(file), '{ not json');
  rmSync(home, { recursive: true });
});

test('claude hooks: creates settings.json when missing; dry run writes nothing', async () => {
  const home = tmp('home');
  const lines: string[] = [];
  const dry = await installJournalHooks('claude', { ...optsFor(home, { dry: true }), log: l => lines.push(l) });
  assert.deepEqual(dry.changed, [join(home, '.claude', 'settings.json')]);
  assert.ok(lines.some(l => l.includes('dry-run')));
  assert.deepEqual(readdirSync(home), []);
  await installJournalHooks('claude', optsFor(home));
  assert.ok(JSON.parse(read(join(home, '.claude', 'settings.json'))).hooks.SessionEnd);
  rmSync(home, { recursive: true });
});

test('codex notify: insert before first table, idempotent, no-clobber, exact removal', async () => {
  const home = tmp('home');
  const file = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'));
  const original = '# my config\nmodel = "gpt"\n\n[desktop]\nfoo = true\n\n[plugins."a"]\nenabled = true\n';
  writeFileSync(file, original);
  assert.deepEqual((await installJournalHooks('codex', optsFor(home))).changed, [file]);
  const text = read(file);
  const line = 'notify = ["node","/opt/swarma/clients/hooks/swarmaa-journal.mjs","codex"]';
  assert.ok(text.indexOf(line) > text.indexOf('model =') && text.indexOf(line) < text.indexOf('[desktop]'));
  assert.deepEqual((await installJournalHooks('codex', optsFor(home))).changed, []);
  assert.equal(read(file), text);
  assert.deepEqual((await removeJournalHooks('codex', optsFor(home))).changed, [file]);
  assert.equal(read(file), original);

  // an existing notify program is chained after the journal, and removal restores it
  const foreign = 'notify = ["/bin/other", "turn-ended"]\n[desktop]\nx = 1\n';
  writeFileSync(file, foreign);
  assert.deepEqual((await installJournalHooks('codex', optsFor(home))).changed, [file]);
  assert.ok(read(file).startsWith('notify = ["node","/opt/swarma/clients/hooks/swarmaa-journal.mjs","codex","--then","/bin/other","turn-ended"]\n'));
  assert.deepEqual((await installJournalHooks('codex', optsFor(home))).changed, []);
  assert.deepEqual((await removeJournalHooks('codex', optsFor(home))).changed, [file]);
  assert.equal(read(file), 'notify = ["/bin/other","turn-ended"]\n[desktop]\nx = 1\n');

  // a value it cannot parse is never overwritten; a multi-line array is detected and chained
  writeFileSync(file, "notify = ['/bin/literal']\n");
  assert.ok((await installJournalHooks('codex', optsFor(home))).skipped);
  writeFileSync(file, 'notify = [\n  "/bin/other",\n  "x"\n]\n[t]\nnotify = 1\n');
  await installJournalHooks('codex', optsFor(home));
  assert.ok(read(file).startsWith('notify = ["node","/opt/swarma/clients/hooks/swarmaa-journal.mjs","codex","--then","/bin/other","x"]\n[t]'));

  writeFileSync(file, '[t]\nnotify = 1\n');
  assert.deepEqual((await installJournalHooks('codex', optsFor(home))).changed, [file]);
  assert.ok(read(file).startsWith('notify = ['));
  await removeJournalHooks('codex', optsFor(home));
  assert.equal(read(file), '[t]\nnotify = 1\n');

  rmSync(file);
  await installJournalHooks('codex', optsFor(home));
  assert.equal(read(file), line + '\n');
  rmSync(home, { recursive: true });
});

test('agy hooks.json: add named Stop hook, idempotent, no-clobber, remove only ours', async () => {
  const home = tmp('home');
  const file = join(home, '.gemini', 'config', 'hooks.json');
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const other = { 'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } };
  writeFileSync(file, JSON.stringify(other));
  assert.deepEqual((await installJournalHooks('agy', optsFor(home))).changed, [file]);
  const s = JSON.parse(read(file));
  assert.deepEqual(s['lint-checker'], other['lint-checker']);
  assert.deepEqual(s['swarmaa-journal'], { Stop: [{ type: 'command', command: 'node "/opt/swarma/clients/hooks/swarmaa-journal.mjs" agy', timeout: 5 }] });
  assert.deepEqual((await installJournalHooks('agy', optsFor(home))).changed, []);
  assert.deepEqual((await removeJournalHooks('agy', optsFor(home))).changed, [file]);
  assert.deepEqual(JSON.parse(read(file)), other);

  writeFileSync(file, JSON.stringify({ 'swarmaa-journal': { Stop: [{ command: 'mine.sh' }] } }));
  assert.ok((await installJournalHooks('agy', optsFor(home))).skipped);
  assert.deepEqual((await removeJournalHooks('agy', optsFor(home))).changed, []);
  rmSync(home, { recursive: true });
});

test('every harness returns its own name in the result', async () => {
  const home = tmp('home');
  for (const h of ['claude', 'codex', 'agy'] as Harness[]) assert.equal((await installJournalHooks(h, optsFor(home, { dry: true }))).harness, h);
  rmSync(home, { recursive: true });
});

// ---- end to end: run the real script against a fake service ----
interface Hit { body: Record<string, unknown>; headers: IncomingMessage['headers']; url?: string }

async function withService(fn: (ctx: { root: string; hits: Hit[]; token: string }) => Promise<void>, opts: { status?: number } = {}) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      hits.push({ body: JSON.parse(data), headers: req.headers, url: req.url });
      res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' }).end('{"result":{"session":{}}}');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const root = tmp('root');
  mkdirSync(join(root, 'clients', 'hooks'), { recursive: true });
  mkdirSync(join(root, '.local'));
  copyFileSync(SCRIPT, join(root, 'clients', 'hooks', 'swarmaa-journal.mjs'));
  writeFileSync(join(root, '.env'), `PORT=${port}\n`);
  const token = 'cn_' + 'Zq9xK2mP7vL4nR8tW3yB6cD1';
  for (const f of ['claude', 'codex', 'antigravity']) writeFileSync(join(root, '.local', `${f}.json`), JSON.stringify({ token }), { mode: 0o600 });
  writeFileSync(join(root, '.local', 'setup.json'), JSON.stringify({ projects: [{ scope: 'project:app', root: '/w/app' }] }));
  try { await fn({ root, hits, token }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

function runScript(root: string, args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(res => {
    const p = spawn(process.execPath, [join(root, 'clients', 'hooks', 'swarmaa-journal.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => { stdout += c; });
    p.stderr.on('data', c => { stderr += c; });
    p.on('close', code => res({ code, stdout, stderr }));
    p.stdin.end(stdin ?? '');
  });
}

function allText(root: string): string {
  try { return read(join(root, '.local', 'logs', 'journal.log')); } catch { return ''; }
}

test('e2e claude Stop: posts redacted window with bearer token, silent stdout, scope by cwd', async () => {
  await withService(async ({ root, hits, token }) => {
    const transcript = join(root, 'session.jsonl');
    writeFileSync(transcript, CLAUDE_FIXTURE.replace('Added tests.', 'Added tests with key sk-ant-api03-AbCdEf0123456789xyz'));
    const payload = JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: '/w/app/src', hook_event_name: 'Stop', last_assistant_message: 'Final words' });
    const r = await runScript(root, ['claude'], payload);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(hits.length, 1);
    const h = hits[0]!;
    assert.equal(h.url, '/api/tools/session_record');
    assert.equal(h.headers.authorization, `Bearer ${token}`);
    assert.equal(h.headers['content-type'], 'application/json');
    const b = h.body as { turns: { role: string; text: string }[] } & Record<string, unknown>;
    assert.equal(b.harness, 'claude-code');
    assert.equal(b.session_id, 'sess-1');
    assert.equal(b.scope, 'project:app');
    assert.equal(b.cwd, '/w/app/src');
    assert.equal(b.title, 'Build the journal please');
    assert.equal(b.ended, false);
    assert.deepEqual(b.turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant', 'assistant']);
    assert.ok(b.turns[3]!.text.includes('[redacted]') && !JSON.stringify(b).includes('sk-ant'));
    assert.equal(b.turns[4]!.text, 'Final words');

    await runScript(root, ['claude'], JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: '/elsewhere', hook_event_name: 'SessionEnd', reason: 'other' }));
    assert.equal(hits[1]!.body.ended, true);
    assert.equal(hits[1]!.body.scope, 'project:general');

    const everything = r.stdout + r.stderr + allText(root);
    assert.ok(!everything.includes(token));
  });
});

test('e2e codex: argv payload, rolling cache sends whole window, cache file is private', async () => {
  await withService(async ({ root, hits, token }) => {
    const mk = (n: number) => JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'th-7', 'turn-id': `tu-${n}`, cwd: '/w/app', 'input-messages': [`q${n}`], 'last-assistant-message': `a${n}` });
    const r1 = await runScript(root, ['codex', mk(1)]);
    const r2 = await runScript(root, ['codex', mk(2)]);
    assert.equal(r1.stdout + r2.stdout + r1.stderr + r2.stderr, '');
    assert.equal(hits.length, 2);
    const b = hits[1]!.body as { turns: { role: string; text: string }[] } & Record<string, unknown>;
    assert.equal(b.harness, 'codex');
    assert.equal(b.session_id, 'th-7');
    assert.equal(b.scope, 'project:app');
    assert.equal(b.title, 'q1');
    assert.deepEqual(b.turns.map(t => t.text), ['q1', 'a1', 'q2', 'a2']);
    const dir = join(root, '.local', 'journal');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^codex-[0-9a-f]{64}\.json$/);
    assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
    assert.ok(!allText(root).includes(token));
  });
});

test('e2e agy: reads transcript, prints {} for the hook contract, sends antigravity', async () => {
  await withService(async ({ root, hits }) => {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, jsonl(
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nhello agy\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'hi there' },
    ));
    const r = await runScript(root, ['agy'], JSON.stringify({ conversationId: 'conv-1', workspacePaths: ['/w/app'], transcriptPath: transcript, terminationReason: 'NO_TOOL_CALL' }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '{}');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.body.harness, 'antigravity');
    assert.equal(hits[0]!.body.session_id, 'conv-1');
    assert.equal(hits[0]!.body.title, 'hello agy');
  });
});

test('e2e failures never break the harness: bad payload, no token, server 500, service down', async () => {
  await withService(async ({ root, hits, token }) => {
    assert.deepEqual(await runScript(root, ['claude'], 'not json'), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await runScript(root, ['claude'], JSON.stringify({ session_id: 's', transcript_path: '/nope.jsonl' })), { code: 0, stdout: '', stderr: '' });
    assert.equal(hits.length, 0);
    rmSync(join(root, '.local', 'claude.json'));
    const t = join(root, 't.jsonl');
    writeFileSync(t, CLAUDE_FIXTURE);
    assert.equal((await runScript(root, ['claude'], JSON.stringify({ session_id: 's', transcript_path: t }))).code, 0);
    assert.equal(hits.length, 0);
    const log = read(join(root, '.local', 'logs', 'journal.log'));
    assert.match(log, /no-token/);
    assert.ok(!log.includes(token));
  });
  await withService(async ({ root, token }) => {
    const t = join(root, 't.jsonl');
    writeFileSync(t, CLAUDE_FIXTURE);
    writeFileSync(join(root, '.env'), 'PORT=1\n'); // nothing listens
    const r = await runScript(root, ['claude'], JSON.stringify({ session_id: 's', transcript_path: t }));
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    const log = read(join(root, '.local', 'logs', 'journal.log'));
    assert.ok(!log.includes(token) && !log.includes('Build the journal'));
  });
  await withService(async ({ root }) => {
    const t = join(root, 't.jsonl');
    writeFileSync(t, CLAUDE_FIXTURE);
    const r = await runScript(root, ['claude'], JSON.stringify({ session_id: 's', transcript_path: t }));
    assert.deepEqual([r.code, r.stdout], [0, '']);
    assert.match(read(join(root, '.local', 'logs', 'journal.log')), /http-500/);
  }, { status: 500 });
});

test('e2e codex chaining: records the turn and starts the replaced notify program with the same payload', async () => {
  await withService(async ({ root, hits }) => {
    const out = join(root, 'chained.txt');
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't-9', 'turn-id': 'u-1', cwd: '/w/app', 'input-messages': ['Hi'], 'last-assistant-message': 'Hello' });
    const r = await runScript(root, ['codex', '--then', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', out, payload]);
    assert.equal(r.code, 0);
    assert.equal(hits.length, 1);
    assert.equal((hits[0]!.body as { session_id: string }).session_id, 't-9');
    for (let i = 0; i < 50 && !readdirSync(root).includes('chained.txt'); i++) await new Promise(res => setTimeout(res, 20));
    assert.equal(read(out), payload);
  });
});

test('installSwarmCommand writes our files, is idempotent, leaves foreign swarm files alone, removes only ours', async () => {
  const home = tmp('swc');
  const lines: string[] = [];
  const o = { root: process.cwd(), dry: false, home, log: (l: string) => lines.push(l) };
  const paths = [join(home, '.claude/commands/swarm.md'), join(home, '.codex/skills/swarm/SKILL.md'), join(home, '.gemini/config/skills/swarm/SKILL.md')];
  assert.equal((await installSwarmCommand(true, o)).filter(r => r.changed.length).length, 3);
  assert.match(readFileSync(paths[0]!, 'utf8'), /argument-hint:[\s\S]*ARGS: \$ARGUMENTS/);
  assert.match(readFileSync(paths[1]!, 'utf8'), /^---\nname: swarm\n/);
  assert.ok((await installSwarmCommand(true, o)).every(r => r.changed.length === 0));
  writeFileSync(paths[0]!, 'mine'); // foreign: no marker
  const r = await installSwarmCommand(true, o);
  assert.match(r[0]!.skipped!, /not ours/);
  assert.equal(readFileSync(paths[0]!, 'utf8'), 'mine');
  await installSwarmCommand(false, o);
  assert.equal(readFileSync(paths[0]!, 'utf8'), 'mine');
  assert.equal(statSync(paths[1]!, { throwIfNoEntry: false }), undefined);
  rmSync(home, { recursive: true });
});
