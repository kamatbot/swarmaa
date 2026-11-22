// Markdown notebook for `note.append` (docs/RING-AGENT.md §5.1, §5.3, §7). Owner-only dirs (0700) and files (0600),
// no symlink components, one marked block per action id so a retry never duplicates and undo removes exactly that block.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type Notebook = 'daily' | 'inbox' | 'meetings';
export const NOTEBOOKS: readonly Notebook[] = ['daily', 'inbox', 'meetings'];
const MAX_FILE = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HANDLE = /^(daily|inbox|meetings)\/(\d{4}-\d\d-\d\d)\.md$/;

export class NotebookError extends Error {
  constructor(public readonly reason: 'unsafe' | 'invalid' | 'too_large', message: string) { super(message); this.name = 'NotebookError'; }
}

/** `SWARMAA_NOTES_DIR` (must be absolute) or `~/.swarmaa/notes`. */
export function notesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SWARMAA_NOTES_DIR || path.join(homedir(), '.swarmaa', 'notes');
  if (!path.isAbsolute(dir)) throw new NotebookError('invalid', 'SWARMAA_NOTES_DIR must be absolute.');
  return path.resolve(dir);
}

const uid = () => process.getuid?.();
// Mirrors `safeDir` in src/core/watch-services.ts: every component a real directory, the notes root and below owner-only.
async function safeDir(root: string, dir: string): Promise<void> {
  const parsed = path.parse(dir); let current = parsed.root;
  for (const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new NotebookError('unsafe', 'Notes path contains a symlink or non-directory.');
    if ((current === root || current.startsWith(root + path.sep)) && (st.uid !== uid() || (st.mode & 0o077) !== 0)) throw new NotebookError('unsafe', 'Notes directory must be owner-only.');
  }
}

/** Creates/validates the notes root; used by `check()`. */
export async function checkNotebook(root: string): Promise<void> { await safeDir(root, root); }

function parts(date: Date, timeZone?: string): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
}
const marker = (id: string) => `<!-- swarmaa:${id} -->`;
const endMarker = (id: string) => `<!-- /swarmaa:${id} -->`;
// Text cannot forge or close a block: comment openers are escaped, the heading stays one line.
const neutral = (s: string) => s.replace(/\r\n?/g, '\n').replace(/<!--/g, '&lt;!--');
const oneLine = (s: string) => neutral(s).replace(/\s+/g, ' ').trim();

async function openOwned(file: string, flags: number) {
  let handle;
  try { handle = await open(file, flags | constants.O_NOFOLLOW, 0o600); }
  catch (e: any) { if (e.code === 'ELOOP') throw new NotebookError('unsafe', 'Notes file is a symlink.'); throw e; }
  const st = await handle.stat();
  if (!st.isFile() || st.uid !== uid() || (st.mode & 0o077) !== 0) { await handle.close(); throw new NotebookError('unsafe', 'Notes file must be an owner-only regular file.'); }
  if (st.size > MAX_FILE) { await handle.close(); throw new NotebookError('too_large', 'Notes file is too large.'); }
  return handle;
}

export interface AppendInput { text: string; title?: string; notebook?: Notebook }
export interface AppendResult { handle: string; existed: boolean }

/** Appends one marked block to `<root>/<notebook>/YYYY-MM-DD.md` (date in `timeZone`); idempotent on `id`. */
export async function appendNote(root: string, id: string, note: AppendInput, now: Date, timeZone?: string): Promise<AppendResult> {
  if (!ID.test(id)) throw new NotebookError('invalid', 'Invalid action id.');
  const notebook = note.notebook ?? 'inbox';
  if (!NOTEBOOKS.includes(notebook)) throw new NotebookError('invalid', 'Invalid notebook.');
  const p = parts(now, timeZone);
  const rel = `${notebook}/${p.year}-${p.month}-${p.day}.md`;
  const dir = path.join(root, notebook); await safeDir(root, dir);
  const file = await openOwned(path.join(root, rel), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND);
  try {
    const existing = await file.readFile('utf8');
    if (existing.includes(marker(id))) return { handle: rel, existed: true };
    const title = note.title ? oneLine(note.title) : '';
    const block = `${marker(id)}\n### ${p.hour}:${p.minute}${title ? ' ' + title : ''}\n${neutral(note.text).trim()}\n${endMarker(id)}\n`;
    const sep = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await file.write(sep + block); await file.sync();
    return { handle: rel, existed: false };
  } finally { await file.close(); }
}

/** Removes the block marked `id` from the file named by `handle`. Returns false when it was already gone. */
export async function removeNote(root: string, id: string, handle: string): Promise<boolean> {
  if (!ID.test(id)) throw new NotebookError('invalid', 'Invalid action id.');
  const m = HANDLE.exec(handle); if (!m) throw new NotebookError('invalid', 'Invalid note handle.');
  const dir = path.join(root, m[1]); await safeDir(root, dir);
  const filename = path.join(root, handle);
  let file;
  try { file = await openOwned(filename, constants.O_RDONLY); }
  catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
  let content: string;
  try { content = await file.readFile('utf8'); } finally { await file.close(); }
  let start = content.indexOf(marker(id)); if (start < 0) return false;
  const close = content.indexOf(endMarker(id), start); if (close < 0) throw new NotebookError('invalid', 'Note block is not terminated.');
  let end = close + endMarker(id).length; if (content[end] === '\n') end++;
  if (start >= 2 && content[start - 1] === '\n' && content[start - 2] === '\n') start--; // the blank line appendNote added
  else if (start === 0 && content[end] === '\n') end++;
  const next = content.slice(0, start) + content.slice(end);
  if (next.trim() === '') { await unlink(filename); return true; }
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await out.writeFile(next); await out.sync(); } finally { await out.close(); }
    await rename(temporary, filename);
    const d = await open(dir, constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
  } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
  return true;
}
