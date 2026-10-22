// Installs/removes the chat-journal hook (clients/hooks/swarmaa-journal.mjs) for Claude Code, Codex, Antigravity, Kiro, Windsurf and Qwen Code.
// Idempotent, never clobbers foreign config, writes nothing when dry. Detection is by the script's path suffix.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Harness = 'claude' | 'codex' | 'agy' | 'kiro' | 'windsurf' | 'qwen';
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

async function write(path: string, text: string, o: Opts, what: string, backup = false): Promise<void> {
  if (o.dry) { o.log(`[dry-run] would ${what}: ${path}`); return; }
  await mkdir(dirname(path), { recursive: true });
  // A user-owned file we are about to edit gets a timestamped copy first.
  if (backup && (await readText(path)) !== null) await copyFile(path, `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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

// ---- Claude-style settings: hooks.<Event> matcher groups. Claude Code (~/.claude/settings.json) and Qwen Code (~/.qwen/settings.json) ----
const CLAUDE_EVENTS = ['Stop', 'SessionEnd'];

async function settingsHooks(harness: Harness, path: string, events: string[], handler: Obj, install: boolean, o: Opts, backup: boolean): Promise<HookResult> {
  const r = await readJsonObject(path);
  if ('skipped' in r) return { harness, changed: [], skipped: r.skipped };
  const settings = r.data;
  if (settings.hooks !== undefined && !isObj(settings.hooks)) return { harness, changed: [], skipped: `${path}: "hooks" is not an object; left untouched` };
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {};
  let dirty = false;

  for (const ev of events) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) return { harness, changed: [], skipped: `${path}: hooks.${ev} is not an array; left untouched` };
    const groups: unknown[] = Array.isArray(hooks[ev]) ? hooks[ev] as unknown[] : [];
    if (install) {
      let found = false;
      for (const g of groups) for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!isObj(h) || !isOurs(h.command)) continue;
        found = true;
        for (const [k, v] of Object.entries(handler)) if (h[k] !== v) { h[k] = v; dirty = true; }
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
  if (!dirty) return { harness, changed: [] };
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  const names = events.join(', ');
  await write(path, json(settings), o, install ? `add journal hooks (${names})` : `remove journal hooks (${names})`, backup);
  return { harness, changed: [path] };
}

const claude = (install: boolean, o: Opts, home: string) =>
  settingsHooks('claude', join(home, '.claude', 'settings.json'), CLAUDE_EVENTS, { type: 'command', command: command(o.root, 'claude'), timeout: 5 }, install, o, false);

// ---- Qwen Code: ~/.qwen/settings.json, Claude-style hooks but timeouts in MILLISECONDS and an explicit shell ----
// Adapted from Asymptote Labs agent-beacon (MIT). A seconds-valued timeout here would be read as a few milliseconds and kill the hook.
const QWEN_TIMEOUT_MS = 5000;
const qwen = (install: boolean, o: Opts, home: string) =>
  settingsHooks('qwen', join(home, '.qwen', 'settings.json'), ['UserPromptSubmit', 'Stop'], { type: 'command', shell: 'bash', command: command(o.root, 'qwen'), timeout: QWEN_TIMEOUT_MS }, install, o, true);

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

// ---- Kiro: a file of our own, ~/.kiro/hooks/swarmaa-journal.json ($KIRO_HOME), never touching other hook files ----
// Adapted from Asymptote Labs agent-beacon (MIT). Kiro timeouts are SECONDS and 0 means "no timeout", so a real value is always written.
// No `matcher` (always match); Stop fires per turn and carries assistant_response; Kiro feeds hook stdout to the agent, so the hook prints nothing.
const KIRO_TIMEOUT_S = 10;
const kiroFile = (o: Opts, home: string) => join(o.home ? join(home, '.kiro') : process.env.KIRO_HOME?.trim() || join(home, '.kiro'), 'hooks', 'swarmaa-journal.json');
const kiroWant = (o: Opts) => ({
  version: 'v1',
  hooks: [['UserPromptSubmit', 'prompt'], ['Stop', 'reply']].map(([trigger, what]) => ({
    name: `swarmaa-journal-${what}`, description: 'Swarmaa chat journal. Records this chat locally into the Swarmaa service.',
    trigger, action: { type: 'command', command: command(o.root, 'kiro') }, timeout: KIRO_TIMEOUT_S, enabled: true,
  })),
});

async function kiro(install: boolean, o: Opts, home: string): Promise<HookResult> {
  const path = kiroFile(o, home);
  const text = await readText(path);
  let current: unknown;
  if (text !== null) try { current = JSON.parse(text); } catch { return { harness: 'kiro', changed: [], skipped: `${path} is not valid JSON; left untouched` }; }
  const ours = current !== undefined && JSON.stringify(current).includes(MARKER);
  if (text !== null && !ours) return { harness: 'kiro', changed: [], skipped: `${path} exists and is not ours; not overwriting` };
  const want = json(kiroWant(o));
  if (install) {
    if (text === want) return { harness: 'kiro', changed: [] };
    await write(path, want, o, 'write Kiro hooks');
    return { harness: 'kiro', changed: [path] };
  }
  if (!ours) return { harness: 'kiro', changed: [] };
  if (o.dry) o.log(`[dry-run] would remove Kiro hooks: ${path}`); else { await rm(path); o.log(`remove Kiro hooks: ${path}`); }
  return { harness: 'kiro', changed: [path] };
}

// ---- Windsurf (and Devin Desktop): ~/.codeium/windsurf/hooks.json, hooks.<event> = [{ command, show_output }] ----
const WINDSURF_EVENTS = ['pre_user_prompt', 'post_cascade_response'];

async function windsurf(install: boolean, o: Opts, home: string): Promise<HookResult> {
  const path = join(home, '.codeium', 'windsurf', 'hooks.json');
  const r = await readJsonObject(path);
  if ('skipped' in r) return { harness: 'windsurf', changed: [], skipped: r.skipped };
  const file = r.data;
  if (file.hooks !== undefined && !isObj(file.hooks)) return { harness: 'windsurf', changed: [], skipped: `${path}: "hooks" is not an object; left untouched` };
  const hooks: Obj = isObj(file.hooks) ? file.hooks : {};
  const want = { command: command(o.root, 'windsurf'), show_output: false };
  let dirty = false;
  for (const ev of WINDSURF_EVENTS) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) return { harness: 'windsurf', changed: [], skipped: `${path}: hooks.${ev} is not an array; left untouched` };
    const list: unknown[] = Array.isArray(hooks[ev]) ? hooks[ev] as unknown[] : [];
    const others = list.filter(h => !(isObj(h) && isOurs(h.command)));
    const next = install ? [...others, want] : others;
    if (JSON.stringify(next) !== JSON.stringify(list)) dirty = true;
    if (next.length) hooks[ev] = next; else delete hooks[ev];
  }
  if (!dirty) return { harness: 'windsurf', changed: [] };
  if (Object.keys(hooks).length) file.hooks = hooks; else delete file.hooks;
  await write(path, json(file), o, install ? 'add hooks (pre_user_prompt, post_cascade_response)' : 'remove hooks (pre_user_prompt, post_cascade_response)', true);
  return { harness: 'windsurf', changed: [path] };
}

const impl = { claude, codex, agy, kiro, windsurf, qwen } as const;

/** Installs (idempotently) the hook that records this harness's chats into Swarmaa. */
export async function installJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void; home?: string }): Promise<HookResult> {
  return impl[harness](true, opts, opts.home ?? homedir());
}

/** Removes the hook installJournalHooks added, leaving every other hook untouched. */
export async function removeJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void; home?: string }): Promise<HookResult> {
  return impl[harness](false, opts, opts.home ?? homedir());
}
