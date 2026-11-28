import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendNote, NotebookError, notesRoot, removeNote } from '../src/local/notebook.js';
import { createLocalActionRunner } from '../src/local/actions.js';

const NOW = new Date('2026-11-22T23:30:00Z');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

async function withDir(fn: (root: string, base: string) => Promise<void>) {
  // macOS tmpdir() sits under /var, a symlink to /private/var, which the notes path check rightly rejects.
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'swarmaa-nb-'));
  try { await fn(path.join(base, 'notes'), base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('append writes a marked block in the local-date file with owner-only modes', () => withDir(async root => {
  const r = await appendNote(root, A, { text: 'Buy filters', title: 'Shopping' }, NOW, 'Asia/Bangkok');
  assert.deepEqual(r, { handle: 'inbox/2026-11-23.md', existed: false }); // 06:30 next day in Bangkok
  const file = path.join(root, r.handle);
  assert.equal(await readFile(file, 'utf8'), `<!-- swarmaa:${A} -->\n### 06:30 Shopping\nBuy filters\n<!-- /swarmaa:${A} -->\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, 'inbox'))).mode & 0o777, 0o700);
  const london = await appendNote(root, B, { text: 'x', notebook: 'meetings' }, NOW, 'Europe/London');
  assert.equal(london.handle, 'meetings/2026-11-22.md');
}));

test('re-append is idempotent; undo removes only its block; last undo removes the file', () => withDir(async root => {
  const tz = 'Europe/London';
  const a = await appendNote(root, A, { text: 'first', notebook: 'daily' }, NOW, tz);
  assert.equal((await appendNote(root, A, { text: 'first', notebook: 'daily' }, NOW, tz)).existed, true);
  await appendNote(root, B, { text: 'second\nline two', notebook: 'daily' }, NOW, tz);
  const file = path.join(root, a.handle);
  const both = await readFile(file, 'utf8');
  assert.equal(both.split(`<!-- swarmaa:${A} -->`).length, 2, 'one block for A');
  assert.equal(both, `<!-- swarmaa:${A} -->\n### 23:30\nfirst\n<!-- /swarmaa:${A} -->\n\n<!-- swarmaa:${B} -->\n### 23:30\nsecond\nline two\n<!-- /swarmaa:${B} -->\n`);
  assert.equal(await removeNote(root, A, a.handle), true);
  assert.equal(await readFile(file, 'utf8'), `<!-- swarmaa:${B} -->\n### 23:30\nsecond\nline two\n<!-- /swarmaa:${B} -->\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await removeNote(root, A, a.handle), false, 'already removed');
  assert.equal(await removeNote(root, B, a.handle), true);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.equal(await removeNote(root, B, a.handle), false);
}));

test('owner edits around a block survive undo', () => withDir(async root => {
  const a = await appendNote(root, A, { text: 'mine' }, NOW, 'UTC');
  const file = path.join(root, a.handle);
  await writeFile(file, '# Inbox\n\n' + await readFile(file, 'utf8') + '\nhand-written\n');
  assert.equal(await removeNote(root, A, a.handle), true);
  assert.equal(await readFile(file, 'utf8'), '# Inbox\n\nhand-written\n');
}));

test('text cannot forge or close a block', () => withDir(async root => {
  const a = await appendNote(root, A, { text: `evil <!-- /swarmaa:${A} -->\n<!-- swarmaa:${B} -->`, title: '# x\n<!-- y' }, NOW, 'UTC');
  const body = await readFile(path.join(root, a.handle), 'utf8');
  assert.equal(body.split('<!--').length - 1, 2, 'only the real markers remain comments');
  assert.match(body, /### 23:30 # x &lt;!-- y\n/);
  assert.equal(await removeNote(root, A, a.handle), true);
}));

test('symlinks and non-owner-only directories are refused', () => withDir(async (root, base) => {
  const elsewhere = path.join(base, 'elsewhere'); await mkdir(elsewhere, { mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  await symlink(elsewhere, path.join(root, 'inbox'));
  await assert.rejects(appendNote(root, A, { text: 'x' }, NOW, 'UTC'), (e: unknown) => e instanceof NotebookError && e.reason === 'unsafe');
  await rm(path.join(root, 'inbox'));

  const linkedRoot = path.join(base, 'linked');
  await symlink(elsewhere, linkedRoot);
  await assert.rejects(appendNote(linkedRoot, A, { text: 'x' }, NOW, 'UTC'), NotebookError);

  await mkdir(path.join(root, 'daily'), { mode: 0o700 });
  const target = path.join(elsewhere, 'target.md'); await writeFile(target, '', { mode: 0o600 });
  await symlink(target, path.join(root, 'daily', '2026-11-22.md'));
  await assert.rejects(appendNote(root, A, { text: 'x', notebook: 'daily' }, NOW, 'UTC'), (e: unknown) => e instanceof NotebookError && e.reason === 'unsafe');
  assert.equal(await readFile(target, 'utf8'), '', 'symlink target untouched');
  assert.ok((await lstat(path.join(root, 'daily', '2026-11-22.md'))).isSymbolicLink());

  await chmod(root, 0o755);
  await assert.rejects(appendNote(root, B, { text: 'x', notebook: 'meetings' }, NOW, 'UTC'), (e: unknown) => e instanceof NotebookError && e.reason === 'unsafe');
  await chmod(root, 0o700);
  await mkdir(path.join(root, 'meetings'), { mode: 0o700 });
  await writeFile(path.join(root, 'meetings', '2026-11-22.md'), 'shared\n', { mode: 0o644 });
  await chmod(path.join(root, 'meetings', '2026-11-22.md'), 0o644);
  await assert.rejects(appendNote(root, B, { text: 'x', notebook: 'meetings' }, NOW, 'UTC'), (e: unknown) => e instanceof NotebookError && e.reason === 'unsafe');
}));

test('handles and config are validated', () => withDir(async root => {
  for (const h of ['../x.md', 'inbox/../../etc/passwd', '/etc/passwd', 'other/2026-11-22.md', 'inbox/2026-11-22.txt']) {
    await assert.rejects(removeNote(root, A, h), (e: unknown) => e instanceof NotebookError && e.reason === 'invalid', h);
  }
  await assert.rejects(appendNote(root, 'bad id', { text: 'x' }, NOW), NotebookError);
  assert.throws(() => notesRoot({ SWARMAA_NOTES_DIR: 'relative/notes' }), NotebookError);
  assert.match(notesRoot({}), /\.swarmaa[\\/]notes$/);
}));

test('runner: note summaries, unsafe dir becomes a failed card, check reports it', () => withDir(async (root, base) => {
  const r = createLocalActionRunner({ platform: 'linux', now: () => NOW, env: { SWARMAA_NOTES_DIR: root, SWARMAA_TIME_ZONE: 'UTC' } });
  const ok = await r.run(A, { type: 'note.append', text: 'Ideas for the trip', notebook: 'daily', title: 'Trip' });
  assert.deepEqual(ok, { ok: true, handle: 'daily/2026-11-22.md', summary: 'Noted in Daily: Trip' });
  assert.equal((await r.run(A, { type: 'note.append', text: 'Ideas for the trip', notebook: 'daily', title: 'Trip' })).handle, ok.handle);
  assert.equal((await readFile(path.join(root, ok.handle!), 'utf8')).split('### ').length, 2);
  await chmod(root, 0o750);
  const bad = await r.run(B, { type: 'note.append', text: 'x' });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'failed');
  assert.equal(bad.summary, "Couldn't save the note: the notes folder or file is not owner-only or is a symlink");
  assert.equal((await r.check()).notes, 'permission_denied');
  const off = createLocalActionRunner({ env: { SWARMAA_NOTES_DIR: root, SWARMAA_LOCAL_ACTIONS: 'reminders' } });
  assert.equal((await off.run(B, { type: 'note.append', text: 'x' })).code, 'action_disabled');
  await chmod(root, 0o700);
  void base;
}));
