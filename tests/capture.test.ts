import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SOURCES, SOURCE_IDS, buildBody, detectSources, loadState, runCapture, statePath } from '../src/capture/index.js';
import { parseWorkspaceYaml } from '../src/capture/copilot.js';
import type { ScanCtx, Source, SessionUpdate } from '../src/capture/types.js';
import { installJournalHooks, removeJournalHooks, type Harness } from '../scripts/hooks-install.js';
import { createOnboarding, runSetup, type Detected } from '../scripts/setup.js';
import { plist, validatePlan } from '../scripts/setup-lib.js';

const FX = (n: string) => join(resolve(process.cwd(), 'tests/fixtures/capture'), n);
const tmp = (p = 'cap') => realpathSync(mkdtempSync(join(tmpdir(), `${p}-`)));
const src = (id: string): Source => SOURCES.find(s => s.id === id)!;
const put = (path: string, text: string | Buffer) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path; };
const putFx = (path: string, fx: string) => { mkdirSync(join(path, '..'), { recursive: true }); copyFileSync(FX(fx), path); return path; };
const NOW = Date.now();

function scan(id: string, home: string, o: { sessions?: ScanCtx['sessions']; since?: number; env?: NodeJS.ProcessEnv } = {}) {
  const errs: string[] = [];
  const r = src(id).scan({ home, env: o.env ?? {}, now: NOW, sinceMs: o.since ?? 0, sessions: o.sessions ?? {}, expired: () => false, fail: e => errs.push(String(e)) });
  return { ...r, errs, sigs: Object.fromEntries(r.updates.map(u => [u.key, u.sig])) as ScanCtx['sessions'] };
}
const texts = (u: SessionUpdate) => u.turns.map(t => `${t.role}:${t.text}`);

// ---------------------------------------------------------------- Cursor
function cursorDb(home: string): DatabaseSync {
  const dir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  return db;
}
const kv = (db: DatabaseSync, key: string, v: unknown) => db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, JSON.stringify(v));

test('cursor: composer text turns only, workspace from context, title, cursor advancement', () => {
  const home = tmp(), proj = join(home, 'proj'); mkdirSync(proj);
  const db = cursorDb(home);
  kv(db, 'composerData:c1', {
    composerId: 'c1', name: 'Fix auth', lastUpdatedAt: NOW, createdAt: NOW - 1000, context: { folderSelections: [{ uri: `file://${proj}` }] },
    fullConversationHeadersOnly: ['b1', 'b2', 'b3', 'b4', 'b5'].map(bubbleId => ({ bubbleId })),
  });
  kv(db, 'bubbleId:c1:b1', { type: 1, text: 'Fix the login bug', createdAt: '2026-10-20T10:00:00.000Z' });
  kv(db, 'bubbleId:c1:b2', { type: 2, text: 'Looking at it', toolFormerData: { name: 'read_file', params: '{}' } });
  kv(db, 'bubbleId:c1:b3', { type: 2, text: '', thinking: { text: 'hidden reasoning' } });
  kv(db, 'bubbleId:c1:b4', { type: 2, text: 'Fixed in auth.ts' });
  kv(db, 'bubbleId:c1:b5', { type: 1, text: '<system-reminder>injected</system-reminder>' });
  kv(db, 'composerData:empty', { composerId: 'empty', lastUpdatedAt: NOW, fullConversationHeadersOnly: [] });
  kv(db, 'composerData:old', { composerId: 'old', lastUpdatedAt: NOW - 30 * 86_400_000, fullConversationHeadersOnly: [{ bubbleId: 'x' }] });
  db.close();

  const first = scan('cursor', home, { since: NOW - 14 * 86_400_000 });
  assert.equal(first.found, 2, 'empty composers are not sessions');
  assert.equal(first.updates.length, 1, 'the 30-day-old composer is outside the first-run window');
  const u = first.updates[0]!;
  assert.deepEqual(texts(u), ['user:Fix the login bug', 'assistant:Fixed in auth.ts']);
  assert.equal(u.cwd, proj);
  assert.equal(u.title, 'Fix auth');
  assert.equal(u.turns[0]!.at, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(first.errs, []);

  assert.equal(scan('cursor', home, { sessions: first.sigs, since: NOW - 14 * 86_400_000 }).updates.length, 0, 'unchanged composer is skipped');
  const db2 = new DatabaseSync(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  kv(db2, 'composerData:c1', { composerId: 'c1', name: 'Fix auth', lastUpdatedAt: NOW + 5000, fullConversationHeadersOnly: ['b1', 'b4'].map(bubbleId => ({ bubbleId })) });
  db2.close();
  assert.deepEqual(scan('cursor', home, { sessions: first.sigs, since: NOW - 14 * 86_400_000 }).updates.map(u => u.id), ['c1'], 'newer lastUpdatedAt re-sends the session');
  rmSync(home, { recursive: true });
});

test('cursor: agent transcripts strip <user_query>, skip tool_use, decode the dash-encoded project, defer to the database for the same id', () => {
  const home = tmp();
  mkdirSync(join(home, 'work', 'app'), { recursive: true });
  const enc = `${home.replace(/\//g, '-')}-work-app`;
  putFx(join(home, '.cursor', 'projects', enc, 'agent-transcripts', 't1', 't1.jsonl'), 'cursor-transcript.jsonl');
  putFx(join(home, '.cursor', 'projects', enc, 'agent-transcripts', 'dup', 'dup.jsonl'), 'cursor-transcript.jsonl');
  const db = cursorDb(home);
  kv(db, 'composerData:dup', { composerId: 'dup', lastUpdatedAt: NOW, fullConversationHeadersOnly: [{ bubbleId: 'b' }] });
  kv(db, 'bubbleId:dup:b', { type: 1, text: 'from the db' });
  db.close();
  const r = scan('cursor', home);
  const t = r.updates.find(u => u.id === 't1')!;
  assert.deepEqual(texts(t), ['user:Refactor the parser please', 'assistant:Reading the parser first.', 'assistant:Done: split into two functions.']);
  assert.equal(t.cwd, join(home, 'work', 'app'));
  assert.equal(r.updates.filter(u => u.id === 'dup').length, 1);
  assert.deepEqual(texts(r.updates.find(u => u.id === 'dup')!), ['user:from the db']);
  rmSync(home, { recursive: true });
});

// ---------------------------------------------------------------- OpenCode
test('opencode: sqlite text parts only, skips summaries/synthetic/sub-agents, honours OPENCODE_DB, cursor advances', () => {
  const home = tmp(), dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'custom.db'));
  db.exec(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const ses = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)');
  ses.run('s1', 'Port the CLI', '/w/app', null, NOW - 5000, NOW);
  ses.run('s2', 'child', '/w/app', 's1', NOW - 5000, NOW);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?)'), part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  const m = (id: string, t: number, d: object) => msg.run(id, 's1', t, JSON.stringify(d));
  const p = (id: string, mid: string, t: number, d: object) => part.run(id, mid, 's1', t, JSON.stringify(d));
  m('m1', 1, { role: 'user' }); p('p1', 'm1', 1, { type: 'text', text: 'hello opencode' });
  m('m2', 2, { role: 'assistant' });
  p('p2', 'm2', 2, { type: 'reasoning', text: 'private thoughts' }); p('p3', 'm2', 3, { type: 'tool', tool: 'bash', state: { output: 'tool output' } }); p('p4', 'm2', 4, { type: 'text', text: 'The answer' });
  m('m3', 3, { role: 'assistant', summary: true }); p('p5', 'm3', 5, { type: 'text', text: 'compaction summary' });
  m('m4', 4, { role: 'assistant' }); p('p6', 'm4', 6, { type: 'text', text: 'injected', synthetic: true });
  db.close();
  const env = { OPENCODE_DB: 'custom.db' };
  const r = scan('opencode', home, { env });
  assert.equal(r.found, 1, 'the child session is not counted');
  assert.deepEqual(texts(r.updates[0]!), ['user:hello opencode', 'assistant:The answer']);
  assert.equal(r.updates[0]!.cwd, '/w/app');
  assert.equal(r.updates[0]!.title, 'Port the CLI');
  assert.equal(scan('opencode', home, { env, sessions: r.sigs }).updates.length, 0);
  const w = new DatabaseSync(join(dir, 'custom.db')); w.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(NOW + 9000, 's1'); w.close();
  assert.equal(scan('opencode', home, { env, sessions: r.sigs }).updates.length, 1);
  assert.equal(src('opencode').exists({ home, env }), true);
  rmSync(home, { recursive: true });
});

test('opencode: legacy storage tree', () => {
  const home = tmp(), st = join(home, '.local', 'share', 'opencode', 'storage');
  put(join(st, 'project', 'prj.json'), JSON.stringify({ worktree: '/w/legacy' }));
  put(join(st, 'session', 'prj', 'ses_1.json'), JSON.stringify({ id: 'ses_1', title: 'Legacy chat', time: { created: NOW - 1000, updated: NOW } }));
  put(join(st, 'message', 'ses_1', 'msg_1.json'), JSON.stringify({ id: 'msg_1', role: 'user', time: { created: 1 } }));
  put(join(st, 'message', 'ses_1', 'msg_2.json'), JSON.stringify({ id: 'msg_2', role: 'assistant', time: { created: 2 } }));
  put(join(st, 'part', 'msg_1', 'prt_1.json'), JSON.stringify({ id: 'prt_1', type: 'text', text: 'old question' }));
  put(join(st, 'part', 'msg_2', 'prt_1.json'), JSON.stringify({ id: 'prt_1', type: 'step-start' }));
  put(join(st, 'part', 'msg_2', 'prt_2.json'), JSON.stringify({ id: 'prt_2', type: 'text', text: 'old answer' }));
  const r = scan('opencode', home);
  assert.deepEqual(texts(r.updates[0]!), ['user:old question', 'assistant:old answer']);
  assert.equal(r.updates[0]!.cwd, '/w/legacy');
  rmSync(home, { recursive: true });
});

// ---------------------------------------------------------------- JSONL sources
test('copilot: events.jsonl turns, workspace.yaml meta, no advance past a partial trailing line', () => {
  const home = tmp(), dir = join(home, '.copilot', 'session-state', 'dirA');
  const file = putFx(join(dir, 'events.jsonl'), 'copilot-events.jsonl');
  putFx(join(dir, 'workspace.yaml'), 'copilot-workspace.yaml');
  const r = scan('copilot', home);
  const u = r.updates[0]!;
  assert.equal(u.id, 'cp-session-9');
  assert.equal(u.cwd, '/w/app/src');
  assert.equal(u.title, 'Retry work');
  assert.deepEqual(texts(u), ['user:Add a retry to fetchUser', 'assistant:Added exponential backoff.']);
  const full = statSync(file).size;
  assert.deepEqual([r.sigs[file]!.offset, r.sigs[file]!.last_line, r.sigs[file]!.size], [full, 6, full]);

  appendFileSync(file, '{"id":"7","type":"user.message","data":{"content":"half a lin');
  const partial = scan('copilot', home, { sessions: r.sigs });
  assert.equal(partial.updates.length, 1, 'the file grew, so it is re-read');
  assert.deepEqual(texts(partial.updates[0]!), texts(u), 'the unfinished line contributes nothing');
  assert.equal(partial.sigs[file]!.offset, full, 'cursor stays before the partial line');
  appendFileSync(file, 'e"}}\n');
  const done = scan('copilot', home, { sessions: partial.sigs });
  assert.equal(done.updates[0]!.turns.at(-1)!.text, 'half a line');
  assert.equal(done.sigs[file]!.last_line, 7);
  assert.equal(scan('copilot', home, { sessions: done.sigs }).updates.length, 0);
  rmSync(home, { recursive: true });
});

test('jsonl readers skip lines over 8 MiB and old files outside the first-run window', () => {
  const home = tmp(), dir = join(home, '.copilot', 'session-state', 'big');
  const huge = `{"type":"user.message","data":{"content":"${'x'.repeat(8 * 1024 * 1024 + 100)}"}}\n`;
  const file = put(join(dir, 'events.jsonl'), `{"type":"user.message","data":{"content":"before"}}\n${huge}{"type":"assistant.message","data":{"content":"after"}}\n`);
  const r = scan('copilot', home);
  assert.deepEqual(texts(r.updates[0]!), ['user:before', 'assistant:after']);
  const old = (NOW - 30 * 86_400_000) / 1000;
  utimesSync(file, old, old);
  const windowed = scan('copilot', home, { since: NOW - 14 * 86_400_000 });
  assert.equal(windowed.found, 1);
  assert.equal(windowed.updates.length, 0);
  assert.equal(scan('copilot', home, { since: NOW - 14 * 86_400_000, sessions: { [file]: { size: 1, mtime: 1 } } }).updates.length, 1, 'a session with a stale cursor is always re-read');
  rmSync(home, { recursive: true });
});

test('parseWorkspaceYaml reads the flat keys it needs', () => {
  assert.deepEqual(parseWorkspaceYaml('id: a\ncwd: "/x y"\nbranch: ~\n  nested: no\nname: \'Q\'\n'), { id: 'a', cwd: '/x y', name: 'Q' });
});

test('factory: user text without injected rows, thinking and tool blocks; header supplies cwd and title', () => {
  const home = tmp();
  putFx(join(home, '.factory', 'sessions', '-w-app', 'fa-1.jsonl'), 'factory-session.jsonl');
  const u = scan('factory', home).updates[0]!;
  assert.deepEqual(texts(u), ['user:Why is login flaky?', 'assistant:It races on the session cookie.']);
  assert.deepEqual([u.cwd, u.title, u.id], ['/w/app', 'Fix flaky test', 'fa-1']);
  rmSync(home, { recursive: true });
});

test('pi: text blocks only, id and cwd from the header, PI_CODING_AGENT_DIR and prime roots', () => {
  const home = tmp();
  putFx(join(home, '.pi', 'agent', 'sessions', '--w-app--', '2026_pi-77.jsonl'), 'pi-session.jsonl');
  const u = scan('pi', home).updates[0]!;
  assert.deepEqual(texts(u), ['user:Summarize the README', 'assistant:It describes a swarm.', 'user:Thanks']);
  assert.deepEqual([u.id, u.cwd], ['pi-77', '/w/app']);
  const other = tmp('pi-other');
  putFx(join(other, 'sessions', 'a.jsonl'), 'pi-session.jsonl');
  putFx(join(home, '.prime', 'agent', 'sessions', 'b.jsonl'), 'pi-session.jsonl');
  assert.equal(scan('pi', home, { env: { PI_CODING_AGENT_DIR: other } }).found, 2, 'override dir + prime; the default dir is replaced');
  rmSync(home, { recursive: true }); rmSync(other, { recursive: true });
});

// ---------------------------------------------------------------- Cline / Roo
test('cline and roo: task tags, no environment dumps, thinking or tool results; cwd from the environment block or task metadata', () => {
  const home = tmp();
  putFx(join(home, '.cline', 'data', 'tasks', 'task1', 'api_conversation_history.json'), 'cline-history.json');
  const c = scan('cline', home).updates[0]!;
  assert.deepEqual(texts(c), ['user:Build a todo app', 'assistant:I will create the files.', 'assistant:All done.']);
  assert.equal(c.cwd, '/w/app');
  assert.equal(c.title, 'Build a todo app');

  const rooDir = join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks', 'rt');
  putFx(join(rooDir, 'api_conversation_history.json'), 'cline-history.json');
  put(join(rooDir, 'task_metadata.json'), JSON.stringify({ cwd: '/meta/dir' }));
  const r = scan('roo', home).updates[0]!;
  assert.equal(r.cwd, '/meta/dir');
  assert.equal(r.turns.length, 3);
  assert.equal(src('roo').exists({ home, env: {} }), true);
  assert.equal(scan('cline', home, { sessions: scan('cline', home).sigs }).updates.length, 0);
  rmSync(home, { recursive: true });
});

// ---------------------------------------------------------------- Devin / Hermes
test('devin: user_input rows and assistant text only, message_id de-duplication, row cursor, hidden sessions skipped', () => {
  const home = tmp(), dir = join(home, '.local', 'share', 'devin', 'cli');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'sessions.db'));
  db.exec(`CREATE TABLE sessions (id TEXT, working_directory TEXT, title TEXT, hidden INTEGER, created_at INTEGER, last_activity_at INTEGER, model TEXT);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER);`);
  const sec = Math.floor(NOW / 1000);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('d1', '/w/app', 'Devin chat', 0, sec - 10, sec, 'x');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('d2', '/w/app', 'hidden', 1, sec - 10, sec, 'x');
  const row = db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?,?,?,?)');
  const add = (sid: string, n: number, m: object) => row.run(sid, n, JSON.stringify(m), sec);
  add('d1', 1, { role: 'user', content: 'q1', message_id: 'u1', metadata: { is_user_input: true } });
  add('d1', 2, { role: 'assistant', content: 'a1', message_id: 'a1', metadata: { generation_model: 'gpt' }, tool_calls: [{ id: 'c' }] });
  add('d1', 3, { role: 'assistant', content: 'a1', message_id: 'a1', metadata: {} });
  add('d1', 4, { role: 'user', content: 'keepalive', message_id: 'k', metadata: { is_user_input: false } });
  add('d1', 5, { role: 'tool', content: 'tool output', message_id: 't' });
  add('d1', 6, { role: 'assistant', content: 'compaction text', message_id: 'x', metadata: { generation_model: 'compactor' } });
  add('d1', 7, { role: 'assistant', content: 'a2', message_id: 'a2', metadata: {} });
  add('d2', 1, { role: 'user', content: 'secret hidden', message_id: 'h', metadata: { is_user_input: true } });
  db.close();
  const r = scan('devin', home);
  assert.equal(r.found, 1);
  assert.deepEqual(texts(r.updates[0]!), ['user:q1', 'assistant:a1', 'assistant:a2']);
  assert.deepEqual([r.updates[0]!.cwd, r.updates[0]!.title, r.sigs.d1!.row], ['/w/app', 'Devin chat', 7]);
  assert.equal(scan('devin', home, { sessions: r.sigs }).updates.length, 0);
  const w = new DatabaseSync(join(dir, 'sessions.db'));
  w.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?,?,?,?)').run('d1', 8, JSON.stringify({ role: 'user', content: 'q2', message_id: 'u2', metadata: { is_user_input: true } }), sec);
  w.close();
  const again = scan('devin', home, { sessions: r.sigs });
  assert.equal(again.updates[0]!.turns.at(-1)!.text, 'q2');
  assert.equal(again.sigs.d1!.row, 9);
  rmSync(home, { recursive: true });
});

test('hermes: active user/assistant text, float-second timestamps, HERMES_HOME, id cursor', () => {
  const home = tmp(), hh = join(home, 'hh');
  mkdirSync(hh);
  const db = new DatabaseSync(join(hh, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT, source TEXT, cwd TEXT, title TEXT, archived INTEGER, started_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL, active INTEGER);`);
  const ts = Math.floor(NOW / 1000) + 0.5;
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('h1', 'cli', '/w/app', 'Hermes chat', 0, ts - 5);
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active) VALUES (?,?,?,?,?,?)');
  ins.run('h1', 'user', 'plan the week', null, ts - 4, 1);
  ins.run('h1', 'assistant', '', '[{"id":"c1"}]', ts - 3, 1);
  ins.run('h1', 'tool', 'tool result', null, ts - 2, 1);
  ins.run('h1', 'assistant', 'Here is the plan', null, ts - 1, 1);
  ins.run('h1', 'user', 'rolled back message', null, ts, 0);
  db.close();
  const env = { HERMES_HOME: hh };
  const r = scan('hermes', home, { env });
  assert.deepEqual(texts(r.updates[0]!), ['user:plan the week', 'assistant:Here is the plan']);
  assert.equal(r.updates[0]!.turns[0]!.at, new Date((ts - 4) * 1000).toISOString());
  assert.equal(r.updates[0]!.cwd, '/w/app');
  assert.equal(scan('hermes', home, { env, sessions: r.sigs }).updates.length, 0);
  rmSync(home, { recursive: true });
});

test('every source reports absent when its app data is missing, and detectSources lists only present ones', () => {
  const home = tmp();
  for (const s of SOURCES) assert.equal(s.exists({ home, env: {} }), false, s.id);
  assert.deepEqual(detectSources({ home, env: {} }), []);
  put(join(home, '.hermes', 'state.db'), '');
  assert.deepEqual(detectSources({ home, env: {} }), ['hermes']);
  rmSync(home, { recursive: true });
});

// ---------------------------------------------------------------- body building
test('buildBody redacts, clips to 8000, keeps 40 turns, bounds bytes and resolves scope', () => {
  const turns = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i} ${'y'.repeat(9000)}` }));
  const body = buildBody('cursor', { id: 's', key: 'k', sig: {}, turns, updatedMs: 1, cwd: '/w/app/x' }, [{ scope: 'project:app', root: '/w/app' }]) as { turns: { text: string }[]; scope: string; title: string };
  assert.ok(body.turns.length <= 40);
  assert.ok(body.turns.every(t => t.text.length <= 8000));
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 120 * 1024);
  assert.equal(body.scope, 'project:app');
  assert.equal(body.title.length, 120);
  const secret = buildBody('pi', { id: 's', key: 'k', sig: {}, turns: [{ role: 'user', text: 'use key sk-ant-api03-AbCdEf0123456789xyzQQ' }], updatedMs: 1 }, []) as { turns: { text: string }[]; scope: string; title: string };
  assert.ok(!JSON.stringify(secret).includes('AbCdEf0123456789'));
  assert.equal(secret.scope, 'project:general');
});

// ---------------------------------------------------------------- end to end against a fake service
interface Hit { body: Record<string, any>; auth?: string; url?: string }
async function withService(fn: (c: { root: string; home: string; hits: Hit[]; url: string; token: string }) => Promise<void>, status = 200) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { hits.push({ body: JSON.parse(data), auth: req.headers.authorization, url: req.url }); res.writeHead(status, { 'content-type': 'application/json' }).end('{"result":{}}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = tmp('croot'), home = tmp('chome');
  const token = 'cn_' + 'Zq9xK2mP7vL4nR8tW3yB6cD1';
  put(join(root, '.local', 'capture.json'), JSON.stringify({ token }));
  put(join(root, '.local', 'setup.json'), JSON.stringify({ projects: [{ scope: 'project:app', root: '/w/app' }] }));
  const dir = join(home, '.copilot', 'session-state', 'dirA');
  put(join(dir, 'events.jsonl'), readFileSync(FX('copilot-events.jsonl'), 'utf8').replace('Added exponential backoff.', 'Added backoff with key sk-ant-api03-AbCdEf0123456789xyz'));
  putFx(join(dir, 'workspace.yaml'), 'copilot-workspace.yaml');
  try { await fn({ root, home, hits, url, token }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}
const logText = (root: string) => { try { return readFileSync(join(root, '.local', 'logs', 'capture.log'), 'utf8'); } catch { return ''; } };

test('e2e capture: sends redacted, scoped sessions with the capture token, saves private cursors, then sends nothing', async () => {
  await withService(async ({ root, home, hits, url, token }) => {
    const run = () => runCapture({ root, home, env: {}, serviceUrl: url, only: ['copilot', 'cursor'] });
    const first = await run();
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.auth, `Bearer ${token}`);
    assert.equal(hits[0]!.url, '/api/tools/session_record');
    const b = hits[0]!.body;
    assert.deepEqual([b.harness, b.session_id, b.scope, b.title, b.cwd, b.ended], ['copilot', 'cp-session-9', 'project:app', 'Retry work', '/w/app/src', false]);
    assert.equal(b.turns.length, 2);
    assert.ok(!JSON.stringify(b).includes('AbCdEf0123456789'), 'secret redacted');
    assert.deepEqual(first.reports.map(r => [r.id, r.present, r.sent]), [['cursor', false, 0], ['copilot', true, 1]]);
    const sf = statePath(root, 'copilot');
    assert.equal(statSync(sf).mode & 0o777, 0o600);
    assert.ok(Object.keys(loadState(root, 'copilot').sessions).length === 1);
    assert.deepEqual(readdirSync(join(root, '.local', 'capture')).filter(f => f.endsWith('.tmp') || f === '.lock'), [], 'no temp or lock files left');
    await run();
    assert.equal(hits.length, 1, 'cursor advanced: nothing re-sent');
    const log = logText(root);
    assert.ok(!log.includes(token) && !log.includes('backoff') && !log.includes('retry'));
  });
});

test('e2e capture: dry run sends and writes nothing; server errors keep cursors back and log status words only', async () => {
  await withService(async ({ root, home, hits, url, token }) => {
    const dry = await runCapture({ root, home, env: {}, serviceUrl: url, only: ['copilot'], dry: true });
    assert.deepEqual([dry.reports[0]!.found, dry.reports[0]!.changed, dry.reports[0]!.sent], [1, 1, 0]);
    assert.equal(hits.length, 0);
    assert.equal(existsSync(join(root, '.local', 'capture')), false);
  });
  await withService(async ({ root, home, hits, url, token }) => {
    const r = await runCapture({ root, home, env: {}, serviceUrl: url, only: ['copilot'] });
    assert.equal(hits.length, 1);
    assert.deepEqual(r.reports[0]!.errors, ['http-500']);
    assert.deepEqual(loadState(root, 'copilot').sessions, {}, 'failed send leaves the cursor');
    const log = logText(root);
    assert.match(log, /copilot http-500/);
    assert.ok(!log.includes(token) && !log.includes('retry'));
  }, 500);
  await withService(async ({ root, home, hits, token }) => {
    const r = await runCapture({ root, home, env: {}, serviceUrl: 'http://127.0.0.1:1', only: ['copilot'] });
    assert.equal(hits.length, 0);
    assert.ok(r.reports[0]!.errors.length > 0);
    assert.deepEqual(loadState(root, 'copilot').sessions, {});
    assert.ok(!logText(root).includes(token));
  });
  await withService(async ({ root, home, hits, url }) => {
    rmSync(join(root, '.local', 'capture.json'));
    const r = await runCapture({ root, home, env: {}, serviceUrl: url, only: ['copilot'] });
    assert.equal(hits.length, 0);
    assert.deepEqual(r.reports[0]!.errors, ['no-token']);
  });
});

test('e2e capture: a source that throws does not stop the others', async () => {
  await withService(async ({ root, home, hits, url }) => {
    const boom: Source = { id: 'boom', harness: 'other', label: 'Boom', exists: () => true, scan: () => { throw Object.assign(new Error('secret chat text'), { code: 'EBOOM' }); } };
    const r = await runCapture({ root, home, env: {}, serviceUrl: url, sources: [boom, src('copilot')] });
    assert.equal(hits.length, 1);
    assert.deepEqual(r.reports[0]!.errors, ['error Error EBOOM']);
    assert.ok(!logText(root).includes('secret chat text'));
  });
});

// ---------------------------------------------------------------- hook installers (Kiro, Windsurf, Qwen)
const quiet = () => {};
const opts = (home: string, extra: { dry?: boolean } = {}) => ({ root: '/opt/swarma', dry: false, log: quiet, home, ...extra });
const readJ = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const baks = (dir: string) => readdirSync(dir).filter(f => f.includes('.bak-'));

test('kiro hooks: own file in Kiro v1 shape, no matcher, seconds timeouts above zero, idempotent, removal, no-clobber', async () => {
  const home = tmp('home'), file = join(home, '.kiro', 'hooks', 'swarmaa-journal.json');
  put(join(home, '.kiro', 'hooks', 'mine.json'), '{"version":"v1","hooks":[]}');
  const r = await installJournalHooks('kiro', opts(home));
  assert.deepEqual(r.changed, [file]);
  const f = readJ(file);
  assert.equal(f.version, 'v1');
  assert.deepEqual(f.hooks.map((h: any) => h.trigger), ['UserPromptSubmit', 'Stop']);
  for (const h of f.hooks) {
    assert.deepEqual(Object.keys(h).sort(), ['action', 'description', 'enabled', 'name', 'timeout', 'trigger']);
    assert.equal(h.enabled, true);
    assert.ok(h.timeout > 0 && h.timeout <= 60, 'seconds, never 0');
    assert.deepEqual(h.action, { type: 'command', command: 'node "/opt/swarma/clients/hooks/swarmaa-journal.mjs" kiro' });
  }
  const before = readFileSync(file, 'utf8');
  assert.deepEqual((await installJournalHooks('kiro', opts(home))).changed, []);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual((await removeJournalHooks('kiro', opts(home))).changed, [file]);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(join(home, '.kiro', 'hooks', 'mine.json'), 'utf8'), '{"version":"v1","hooks":[]}');
  assert.deepEqual((await removeJournalHooks('kiro', opts(home))).changed, []);
  put(file, '{"version":"v1","hooks":[{"name":"someone else"}]}');
  const foreign = await installJournalHooks('kiro', opts(home));
  assert.ok(foreign.skipped && !foreign.changed.length);
  assert.deepEqual((await removeJournalHooks('kiro', opts(home))).changed, []);
  assert.match(readFileSync(file, 'utf8'), /someone else/);
  const dry = tmp('home');
  await installJournalHooks('kiro', opts(dry, { dry: true }));
  assert.deepEqual(readdirSync(dry), []);
  rmSync(home, { recursive: true }); rmSync(dry, { recursive: true });
});

test('kiro hooks honour KIRO_HOME when no home override is given', async () => {
  const kh = tmp('kiro-home'), prev = process.env.KIRO_HOME;
  process.env.KIRO_HOME = kh;
  try {
    const r = await installJournalHooks('kiro', { root: '/opt/swarma', dry: false, log: quiet });
    assert.deepEqual(r.changed, [join(kh, 'hooks', 'swarmaa-journal.json')]);
    await removeJournalHooks('kiro', { root: '/opt/swarma', dry: false, log: quiet });
  } finally { if (prev === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = prev; rmSync(kh, { recursive: true }); }
});

test('windsurf hooks: merge-preserve, show_output false, timestamped backup, idempotent, exact removal, bad JSON untouched', async () => {
  const home = tmp('home'), dir = join(home, '.codeium', 'windsurf'), file = join(dir, 'hooks.json');
  const original = { version: 2, hooks: { pre_user_prompt: [{ command: 'echo mine', show_output: true }], post_write_code: [{ command: 'fmt' }] } };
  put(file, JSON.stringify(original));
  const r = await installJournalHooks('windsurf', opts(home));
  assert.deepEqual(r.changed, [file]);
  const f = readJ(file), ours = { command: 'node "/opt/swarma/clients/hooks/swarmaa-journal.mjs" windsurf', show_output: false };
  assert.equal(f.version, 2);
  assert.deepEqual(f.hooks.post_write_code, original.hooks.post_write_code);
  assert.deepEqual(f.hooks.pre_user_prompt, [original.hooks.pre_user_prompt[0], ours]);
  assert.deepEqual(f.hooks.post_cascade_response, [ours]);
  assert.equal(baks(dir).length, 1);
  assert.deepEqual(readJ(join(dir, baks(dir)[0]!)), original, 'backup holds the pre-edit file');
  assert.deepEqual((await installJournalHooks('windsurf', opts(home))).changed, []);
  assert.equal(baks(dir).length, 1, 'no new backup when nothing changes');
  assert.deepEqual((await removeJournalHooks('windsurf', opts(home))).changed, [file]);
  assert.deepEqual(readJ(file), original);
  assert.deepEqual((await removeJournalHooks('windsurf', opts(home))).changed, []);
  put(file, '{ nope');
  const bad = await installJournalHooks('windsurf', opts(home));
  assert.ok(bad.skipped && readFileSync(file, 'utf8') === '{ nope');
  rmSync(home, { recursive: true });
});

test('qwen hooks: Claude-style groups with MILLISECOND timeouts and a shell, preserves others, backup, removal', async () => {
  const home = tmp('home'), dir = join(home, '.qwen'), file = join(dir, 'settings.json');
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }], PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard' }] }] } };
  put(file, JSON.stringify(original));
  assert.deepEqual((await installJournalHooks('qwen', opts(home))).changed, [file]);
  const s = readJ(file);
  const ours = { type: 'command', shell: 'bash', command: 'node "/opt/swarma/clients/hooks/swarmaa-journal.mjs" qwen', timeout: 5000 };
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(s.hooks.Stop, [original.hooks.Stop[0], { hooks: [ours] }]);
  assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [ours] }]);
  assert.ok(ours.timeout >= 1000, 'milliseconds, not seconds');
  assert.equal(baks(dir).length, 1);
  assert.deepEqual((await installJournalHooks('qwen', opts(home))).changed, []);
  assert.deepEqual((await removeJournalHooks('qwen', opts(home))).changed, [file]);
  assert.deepEqual(readJ(file), original);
  for (const h of ['kiro', 'windsurf', 'qwen'] as Harness[]) assert.equal((await installJournalHooks(h, opts(tmp('h'), { dry: true }))).harness, h);
  rmSync(home, { recursive: true });
});

// ---------------------------------------------------------------- hook scripts end to end
const SCRIPT = resolve(process.cwd(), 'clients/hooks/swarmaa-journal.mjs');
async function withHookService(fn: (c: { root: string; hits: Hit[]; token: string; run: (harness: string, payload: object) => Promise<{ code: number | null; stdout: string }> }) => Promise<void>) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { hits.push({ body: JSON.parse(data), auth: req.headers.authorization }); res.writeHead(200).end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const root = tmp('hroot');
  mkdirSync(join(root, 'clients', 'hooks'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'clients', 'hooks', 'swarmaa-journal.mjs'));
  put(join(root, '.env'), `PORT=${(server.address() as { port: number }).port}\n`);
  put(join(root, '.local', 'setup.json'), JSON.stringify({ projects: [{ scope: 'project:app', root: '/w/app' }] }));
  const token = 'cn_' + 'Zq9xK2mP7vL4nR8tW3yB6cD1';
  for (const f of ['kiro', 'windsurf', 'qwen']) put(join(root, '.local', `${f}.json`), JSON.stringify({ token: `${token}-${f}` }));
  const run = (harness: string, payload: object) => new Promise<{ code: number | null; stdout: string }>(res => {
    const p = spawn(process.execPath, [join(root, 'clients', 'hooks', 'swarmaa-journal.mjs'), harness], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', c => { stdout += c; });
    p.on('close', code => res({ code, stdout }));
    p.stdin.end(JSON.stringify(payload));
  });
  try { await fn({ root, hits, token, run }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

test('kiro hook: prompt then reply accumulate in the rolling cache, cwd sticks, silent stdout, own identity', async () => {
  await withHookService(async ({ root, hits, token, run }) => {
    const a = await run('kiro', { session_id: 'k1', cwd: '/w/app', hook_event_name: 'UserPromptSubmit', prompt: 'Hello kiro' });
    assert.deepEqual(a, { code: 0, stdout: '' });
    await run('kiro', { session_id: 'k1', hook_event_name: 'Stop', assistant_response: 'Hi there' });
    await run('kiro', { session_id: 'k1', hook_event_name: 'Stop', assistant_response: 'Hi there' }); // a retry must not duplicate
    assert.equal(hits.length, 3);
    assert.equal(hits[1]!.auth, `Bearer ${token}-kiro`);
    const b = hits[2]!.body;
    assert.deepEqual([b.harness, b.session_id, b.scope, b.title, b.cwd], ['kiro', 'k1', 'project:app', 'Hello kiro', '/w/app']);
    assert.deepEqual(b.turns.map((t: any) => `${t.role}:${t.text}`), ['user:Hello kiro', 'assistant:Hi there']);
    const cache = readdirSync(join(root, '.local', 'journal'));
    assert.equal(cache.length, 1);
    assert.equal(statSync(join(root, '.local', 'journal', cache[0]!)).mode & 0o777, 0o600);
  });
});

test('windsurf hook: trajectory_id session, prompt and cascade response; qwen hook records as harness other with its own token', async () => {
  await withHookService(async ({ hits, token, run }) => {
    await run('windsurf', { agent_action_name: 'pre_user_prompt', trajectory_id: 'tr9', tool_info: { user_prompt: 'hey cascade' } });
    await run('windsurf', { agent_action_name: 'post_cascade_response', trajectory_id: 'tr9', tool_info: { response: 'hello human' } });
    const w = hits[1]!;
    assert.deepEqual([w.body.harness, w.body.session_id, w.body.scope], ['windsurf', 'tr9', 'project:general']);
    assert.deepEqual(w.body.turns.map((t: any) => t.text), ['hey cascade', 'hello human']);
    assert.equal(w.auth, `Bearer ${token}-windsurf`);
    await run('qwen', { session_id: 'q1', cwd: '/w/app/x', hook_event_name: 'UserPromptSubmit', prompt: 'qwen question' });
    await run('qwen', { session_id: 'q1', hook_event_name: 'Stop', last_assistant_message: 'qwen answer' });
    const q = hits.at(-1)!;
    assert.deepEqual([q.body.harness, q.body.scope, q.auth], ['other', 'project:app', `Bearer ${token}-qwen`]);
    assert.deepEqual(q.body.turns.map((t: any) => t.text), ['qwen question', 'qwen answer']);
    const before = hits.length;
    assert.equal((await run('kiro', { nothing: true })).code, 0);
    assert.equal(hits.length, before);
  });
});

// ---------------------------------------------------------------- setup integration
const detected = (extra: Partial<Detected> = {}): Detected => ({ clis: { claude: '/bin/claude-fake' }, notchtrader: false, postgres: { found: true, reachable: true }, envExists: false, state: {}, ...extra });

test('validatePlan: capture and hookApps are validated strictly and default off', () => {
  const base = { harnesses: {}, folders: [], autostart: false };
  assert.deepEqual(validatePlan(base).capture, { enabled: false });
  assert.deepEqual(validatePlan(base).hookApps, {});
  const p = validatePlan({ ...base, capture: { enabled: true }, hookApps: { kiro: { share: true }, qwen: { share: false }, windsurf: {} } });
  assert.deepEqual(p.capture, { enabled: true });
  assert.deepEqual(p.hookApps, { kiro: { share: true }, qwen: { share: false }, windsurf: { share: true } });
  for (const bad of [{ capture: true }, { capture: { enabled: 'yes' } }, { capture: { enabled: true, x: 1 } }, { hookApps: { cursor: {} } }, { hookApps: { kiro: { share: 1 } } }, { hookApps: { kiro: { evil: true } } }, { hookApps: [] }])
    assert.throws(() => validatePlan({ ...base, ...bad }), /capture|hook ?app/i, JSON.stringify(bad));
});

test('plist: interval and calendar jobs have no KeepAlive; daemons are unchanged', () => {
  const interval = plist('com.swarma.capture', ['/bin/node', 'x'], { startInterval: 120 });
  assert.match(interval, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.match(interval, /RunAtLoad/);
  assert.ok(!interval.includes('KeepAlive') && !interval.includes('ThrottleInterval'));
  const cal = plist('com.swarma.distill', ['/bin/node', 'y'], { calendar: { hour: 3, minute: 30 }, runAtLoad: false });
  assert.match(cal, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.ok(!cal.includes('KeepAlive') && !cal.includes('RunAtLoad'));
  const daemon = plist('d', ['x']);
  assert.ok(daemon.includes('KeepAlive') && daemon.includes('RunAtLoad') && daemon.includes('ThrottleInterval') && !daemon.includes('StartInterval'));
});

test('runSetup dry run provisions the capture and hook-app identities and the one-shot LaunchAgents', async () => {
  const root = tmp('sroot'), lines: string[] = [];
  const plan = validatePlan({ harnesses: {}, capture: { enabled: true }, hookApps: { kiro: { share: true }, qwen: { share: true } }, folders: [], autostart: true });
  const s = await runSetup(plan, { dry: true, log: l => lines.push(l), root, detected: detected({ captureSources: ['cursor', 'opencode'], hookApps: ['kiro', 'windsurf'] }) });
  const text = lines.join('\n');
  assert.equal(s.ok, true, String(s.error));
  assert.deepEqual(s.captured, ['cursor', 'opencode']);
  assert.deepEqual(s.hookApps, ['kiro'], 'qwen was not detected, windsurf was not asked for');
  const cmd = (name: string) => lines.find(l => l.includes('admin.ts') && l.includes(`--name ${name} `)) ?? '';
  assert.match(cmd('capture'), /--role frontend .*project:general/);
  assert.match(cmd('kiro'), /--out \S+\.local\/kiro\.json/);
  assert.equal(cmd('qwen'), '');
  assert.match(text, /com\.swarma\.capture\.plist/);
  assert.match(text, /scripts\/capture\.ts/);
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.match(text, /com\.swarma\.distill\.plist/);
  assert.match(text, /scripts\/distill\.ts/);
  assert.match(text, /<key>StartCalendarInterval<\/key>/);
  assert.equal(existsSync(join(root, '.local')), false, 'a dry run writes nothing');
  rmSync(root, { recursive: true });
});

test('runSetup: capture needs a detected app and an explicit yes; autostart off prints the manual command', async () => {
  const root = tmp('sroot');
  const run = async (plan: unknown, det: Detected) => { const lines: string[] = []; const s = await runSetup(validatePlan(plan), { dry: true, log: l => lines.push(l), root, detected: det }); return { s, text: lines.join('\n') }; };
  const none = await run({ harnesses: {}, capture: { enabled: true }, folders: [], autostart: true }, detected());
  assert.deepEqual(none.s.captured, []);
  // Never installs the capture job (removing one left on this machine by a real setup is fine).
  assert.ok(!/write \S*com\.swarma\.capture\.plist/.test(none.text));
  const off = await run({ harnesses: {}, folders: [], autostart: true }, detected({ captureSources: ['cursor'] }));
  assert.deepEqual(off.s.captured, []);
  assert.ok(!off.text.includes('--name capture'));
  const manual = await run({ harnesses: {}, capture: { enabled: true }, folders: [], autostart: false }, detected({ captureSources: ['cursor'] }));
  assert.match(manual.text, /npm run capture -- --once/);
  const removed = await run({ harnesses: {}, hookApps: {}, folders: [], autostart: false }, detected({ hookApps: ['kiro'], state: { hookApps: ['kiro'] } }));
  assert.match(removed.text, /chat sharing removed|Kiro/);
  assert.deepEqual(removed.s.hookApps, []);
  rmSync(root, { recursive: true, force: true });
});

test('onboarding detect returns the new fields additively', async () => {
  const ob = createOnboarding({ dry: true, idleMs: 0, html: 'x', detectFn: async () => detected({ captureSources: ['cursor'], hookApps: ['kiro'] }) });
  const url = new URL(await ob.listen());
  try {
    const res = await fetch(`${url.origin}/api/detect`, { headers: { 'x-swarmaa-token': ob.token } });
    const j = await res.json() as any;
    assert.deepEqual([j.captureSources, j.hookApps], [['cursor'], ['kiro']]);
    assert.deepEqual(Object.keys(j.installed).sort(), ['agy', 'claude', 'codex', 'notchtrader']);
  } finally { ob.close(); await ob.closed; }
});

test('source ids are stable for --only', () => {
  assert.deepEqual(SOURCE_IDS, ['cursor', 'opencode', 'copilot', 'cline', 'roo', 'devin', 'hermes', 'factory', 'pi']);
});
