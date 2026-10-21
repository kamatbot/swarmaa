// Installs/removes the chat-journal hook (clients/hooks/swarmaa-journal.mjs) for Claude Code, Codex and Antigravity.
// Idempotent, never clobbers foreign config, writes nothing when dry. Detection is by the script's path suffix.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Harness = 'claude' | 'codex' | 'agy';
export interface HookResult { harness: Harness; changed: string[]; skipped?: string }
interface Opts { root: string; dry: boolean; log: (line: string) => void; home?: string }

const MARKER = 'clients/hooks/swarmaa-journal.mjs';
const AGY_HOOK_NAME = 'swarmaa-journal';
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const script = (root: string) => join(root, MARKER);
const command = (root: string, arg: string) => `node "${script(root)}" ${arg}`;
const isOurs = (c: unknown) => typeof c === 'string' && c.includes(MARKER);

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

async function write(path: string, text: string, o: Opts, what: string): Promise<void> {
  if (o.dry) { o.log(`[dry-run] would ${what}: ${path}`); return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  o.log(`${what}: ${path}`);
}

/** Reads a JSON-object config; { skipped } if it exists but is not a JSON object (never overwritten). */
async function readJsonObject(path: string): Promise<{ data: Obj } | { skipped: string }> {
  const text = await readText(path);
  if (text === null || text.trim() === '') return { data: {} };
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? { data: v } : { skipped: `${path} is not a JSON object; left untouched` };
  } catch { return { skipped: `${path} is not valid JSON; left untouched` }; }
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

// ---- Claude Code: ~/.claude/settings.json, hooks.Stop + hooks.SessionEnd matcher groups ----
const CLAUDE_EVENTS = ['Stop', 'SessionEnd'];

async function claude(install: boolean, o: Opts, home: string): Promise<HookResult> {
  const path = join(home, '.claude', 'settings.json');
  const r = await readJsonObject(path);
  if ('skipped' in r) return { harness: 'claude', changed: [], skipped: r.skipped };
  const settings = r.data;
  if (settings.hooks !== undefined && !isObj(settings.hooks)) return { harness: 'claude', changed: [], skipped: `${path}: "hooks" is not an object; left untouched` };
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {};
  const handler = { type: 'command', command: command(o.root, 'claude'), timeout: 5 };
  let dirty = false;

  for (const ev of CLAUDE_EVENTS) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) return { harness: 'claude', changed: [], skipped: `${path}: hooks.${ev} is not an array; left untouched` };
    const groups: unknown[] = Array.isArray(hooks[ev]) ? hooks[ev] as unknown[] : [];
    if (install) {
      let found = false;
      for (const g of groups) for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!isObj(h) || !isOurs(h.command)) continue;
        found = true;
        if (h.command !== handler.command) { h.command = handler.command; dirty = true; }
      }
      if (!found) { groups.push({ hooks: [{ ...handler }] }); dirty = true; }
      hooks[ev] = groups;
    } else {
      const kept: unknown[] = [];
      for (const g of groups) {
        if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
        const rest = g.hooks.filter(h => !(isObj(h) && isOurs(h.command)));
        if (rest.length === g.hooks.length) { kept.push(g); continue; }
        dirty = true;
        if (rest.length) kept.push({ ...g, hooks: rest });
      }
      if (kept.length) hooks[ev] = kept; else delete hooks[ev];
    }
  }
  if (!dirty) return { harness: 'claude', changed: [] };
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  await write(path, json(settings), o, install ? 'add journal hooks (Stop, SessionEnd)' : 'remove journal hooks (Stop, SessionEnd)');
  return { harness: 'claude', changed: [path] };
}

// ---- Codex: ~/.codex/config.toml, top-level notify = [...] ----
/** Index range [start, end) of the top-level `notify = ...` statement (may span lines), or null. */
function findNotify(lines: string[], limit: number): [number, number] | null {
  for (let i = 0; i < limit; i++) {
    if (!/^\s*notify\s*=/.test(lines[i]!)) continue;
    let depth = 0, seen = false, inStr = false, end = i;
    for (let j = i; j < lines.length; j++) {
      const l = j === i ? lines[j]!.slice(lines[j]!.indexOf('=') + 1) : lines[j]!;
      for (let k = 0; k < l.length; k++) {
        const ch = l[k];
        if (inStr) { if (ch === '\\') k++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '#') break;
        else if (ch === '[') { depth++; seen = true; }
        else if (ch === ']') depth--;
      }
      end = j + 1;
      if (!seen || depth <= 0) break;
    }
    return [i, end];
  }
  return null;
}

/** The notify array's strings, or null when it is not a plain array of basic strings. */
function parseNotify(statement: string): string[] | null {
  try {
    const value: unknown = JSON.parse(statement.slice(statement.indexOf('=') + 1).replace(/#.*$/gm, '').trim());
    return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string') ? value as string[] : null;
  } catch { return null; }
}

async function codex(install: boolean, o: Opts, home: string): Promise<HookResult> {
  const path = join(home, '.codex', 'config.toml');
  const text = (await readText(path)) ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const topEnd = firstTable === -1 ? lines.length : firstTable;
  const found = findNotify(lines, topEnd);
  const statement = found ? lines.slice(found[0], found[1]).join('\n') : '';
  const ours = found !== null && statement.includes(MARKER);
  // Codex runs one notify program, so an existing one is chained: the journal starts it with the same payload.
  const current = found ? parseNotify(statement) : null;
  const chained = ours ? (current && current.includes('--then') ? current.slice(current.indexOf('--then') + 1) : []) : (current ?? []);
  const want = `notify = ${JSON.stringify(['node', script(o.root), 'codex', ...(chained.length ? ['--then', ...chained] : [])])}`;

  if (install) {
    if (found && !ours && !current) return { harness: 'codex', changed: [], skipped: `${path}: notify is set to a value this installer cannot parse; not overwriting` };
    if (ours && statement === want) return { harness: 'codex', changed: [] };
    if (found) lines.splice(found[0], found[1] - found[0], want);
    else {
      let pos = topEnd;
      while (pos > 0 && lines[pos - 1]!.trim() === '') pos--;
      lines.splice(pos, 0, want);
      if (pos === 0 && firstTable !== -1) lines.splice(1, 0, '');
    }
    await write(path, lines.join(eol), o, 'set notify');
    return { harness: 'codex', changed: [path] };
  }
  if (!found || !ours) return { harness: 'codex', changed: [] };
  if (chained.length) {
    lines.splice(found[0], found[1] - found[0], `notify = ${JSON.stringify(chained)}`);
    await write(path, lines.join(eol), o, 'restore chained notify');
    return { harness: 'codex', changed: [path] };
  }
  const drop = found[0] === 0 && lines[found[1]] === '' && found[1] + 1 < lines.length ? 1 : 0; // blank separator we added above a leading table
  lines.splice(found[0], found[1] - found[0] + drop);
  await write(path, lines.join(eol), o, 'remove notify');
  return { harness: 'codex', changed: [path] };
}

// ---- Antigravity: ~/.gemini/config/hooks.json, own named hook "swarmaa-journal" with a flat Stop list ----
async function agy(install: boolean, o: Opts, home: string): Promise<HookResult> {
  const path = join(home, '.gemini', 'config', 'hooks.json');
  const r = await readJsonObject(path);
  if ('skipped' in r) return { harness: 'agy', changed: [], skipped: r.skipped };
  const file = r.data;
  const existing = file[AGY_HOOK_NAME];
  const ours = existing !== undefined && JSON.stringify(existing).includes(MARKER);
  const want = { Stop: [{ type: 'command', command: command(o.root, 'agy'), timeout: 5 }] };

  if (install) {
    if (existing !== undefined && !ours) return { harness: 'agy', changed: [], skipped: `${path}: hook "${AGY_HOOK_NAME}" already exists and is not ours; not overwriting` };
    if (ours && JSON.stringify(existing) === JSON.stringify(want)) return { harness: 'agy', changed: [] };
    file[AGY_HOOK_NAME] = want;
    await write(path, json(file), o, 'add Stop hook');
    return { harness: 'agy', changed: [path] };
  }
  if (!ours) return { harness: 'agy', changed: [] };
  delete file[AGY_HOOK_NAME];
  await write(path, json(file), o, 'remove Stop hook');
  return { harness: 'agy', changed: [path] };
}

const impl = { claude, codex, agy } as const;

/** Installs (idempotently) the hook that records this harness's chats into Swarmaa. */
export async function installJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void; home?: string }): Promise<HookResult> {
  return impl[harness](true, opts, opts.home ?? homedir());
}

/** Removes the hook installJournalHooks added, leaving every other hook untouched. */
export async function removeJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void; home?: string }): Promise<HookResult> {
  return impl[harness](false, opts, opts.home ?? homedir());
}
