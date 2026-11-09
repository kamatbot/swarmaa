import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scopeForProjectDir, syncClaudeMemories } from '../src/capture/claude-memory.js';

test('scopeForProjectDir', () => {
  const projects = [{ scope: 'project:a', root: '/Users/mk/Projects/a' }, { scope: 'project:ab', root: '/Users/mk/Projects/a/b' }];
  assert.equal(scopeForProjectDir('-Users-mk-Projects-a', projects), 'project:a');
  assert.equal(scopeForProjectDir('-Users-mk-Projects-a--claude-worktrees-x', projects), 'project:a');
  assert.equal(scopeForProjectDir('-Users-mk-Projects-a-b-c', projects), 'project:ab');
  assert.equal(scopeForProjectDir('-Users-mk-Projects-ax', projects), 'project:general');
  assert.equal(scopeForProjectDir('-x', null), 'project:general');
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cm-root-')), home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  mkdirSync(join(root, '.local'), { recursive: true });
  writeFileSync(join(root, '.local', 'capture.json'), JSON.stringify({ token: 't0k' }));
  writeFileSync(join(root, '.local', 'setup.json'), JSON.stringify({ projects: [{ scope: 'project:a', root: '/Users/mk/Projects/a' }] }));
  const mem = join(home, '.claude', 'projects', '-Users-mk-Projects-a', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), 'index');
  writeFileSync(join(mem, 'one.md'), 'one');
  writeFileSync(join(mem, 'two.md'), 'two');
  const calls: any[] = [];
  let respond: (b: any) => Response = () => new Response(JSON.stringify({ result: { memory: { version: 1 } } }));
  const fetchImpl = (async (url: string, init: any) => { const b = JSON.parse(init.body); calls.push({ url, auth: init.headers.authorization, b }); return respond(b); }) as unknown as typeof fetch;
  return { root, home, mem, calls, fetchImpl, setRespond: (f: typeof respond) => { respond = f; } };
}

test('sends changed files only, with expected_version on edit', async () => {
  const s = setup();
  let r = await syncClaudeMemories(s);
  assert.deepEqual([r.found, r.sent], [2, 2]);
  assert.equal(s.calls[0].url, 'http://127.0.0.1:8787/api/tools/memory_propose');
  assert.equal(s.calls[0].auth, 'Bearer t0k');
  const one = s.calls.find(c => c.b.key === 'claude-memory/one').b;
  assert.equal(one.scope, 'project:a'); assert.equal(one.kind, 'note'); assert.equal(one.source.type, 'agent');
  assert.equal(one.source.reference, join(s.mem, 'one.md')); assert.equal(one.expected_version, undefined);
  s.calls.length = 0;
  assert.equal((await syncClaudeMemories(s)).sent, 0); assert.equal(s.calls.length, 0);
  s.setRespond(() => new Response(JSON.stringify({ result: { memory: { version: 2 } } })));
  writeFileSync(join(s.mem, 'one.md'), 'one edited');
  r = await syncClaudeMemories(s);
  assert.equal(r.sent, 1); assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].b.expected_version, 1);
  rmSync(s.root, { recursive: true }); rmSync(s.home, { recursive: true });
});

test('deleted file is expired once', async () => {
  const s = setup();
  await syncClaudeMemories(s);
  rmSync(join(s.mem, 'two.md'));
  s.calls.length = 0;
  let r = await syncClaudeMemories(s);
  assert.equal(r.expired, 1); assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0].b.expires_at); assert.equal(s.calls[0].b.key, 'claude-memory/two'); assert.equal(s.calls[0].b.expected_version, 1);
  s.calls.length = 0;
  r = await syncClaudeMemories(s);
  assert.equal(r.expired, 0); assert.equal(s.calls.length, 0);
});

test('memory_retracted stops resending', async () => {
  const s = setup();
  s.setRespond(() => new Response(JSON.stringify({ error: { code: 'memory_retracted' } }), { status: 409 }));
  await syncClaudeMemories(s);
  s.calls.length = 0;
  s.setRespond(() => new Response(JSON.stringify({ result: { memory: { version: 1 } } })));
  writeFileSync(join(s.mem, 'one.md'), 'changed');
  await syncClaudeMemories(s);
  assert.equal(s.calls.length, 0);
});

test('a stale version is retried at the current one; same-name files in one scope send only the newest', async () => {
  const s = setup();
  const other = join(s.home, '.claude', 'projects', '-Users-mk-Projects-a--claude-worktrees-x', 'memory');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'one.md'), 'older copy');
  const { utimesSync } = await import('node:fs');
  utimesSync(join(other, 'one.md'), new Date(1000), new Date(1000));
  s.setRespond(b => new Response(JSON.stringify({ result: { memory: { version: 7 }, conflict: b.expected_version !== 7 } })));
  const r = await syncClaudeMemories(s);
  assert.equal(r.found, 3);
  const ones = s.calls.filter(c => c.b.key === 'claude-memory/one');
  assert.deepEqual(ones.map(c => [c.b.content, c.b.expected_version]), [['one', undefined], ['one', 7]]);
  rmSync(s.root, { recursive: true }); rmSync(s.home, { recursive: true });
});
