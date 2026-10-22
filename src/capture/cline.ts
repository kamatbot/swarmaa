// Cline and Roo Code: api_conversation_history.json per task (Anthropic message arrays). Cline roots follow agent-beacon
// (CLINE_DIR/data/tasks, CLINE_DIR/tasks, VS Code globalStorage saoudrizwan.claude-dev, plus data/sessions/*/*.messages.json).
// Roo's layout (VS Code globalStorage rooveterinaryinc.roo-cline/tasks/<id>/api_conversation_history.json) is INFERRED to match
// Cline's: Roo is a Cline fork and beacon has no Roo reader. Adapted from Asymptote Labs agent-beacon (MIT).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanCtx, SessionUpdate, Source, Turn, Where } from './types.js';
import { MAX_TURNS, arr, firstPrompt, iso, isObj, normalizeDir, str, stripReminders, toMs, type Obj } from './util.js';

const MAX_FILE = 25 * 1024 * 1024;
const vscode = (w: Where, ext: string) => join(w.home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', ext);

interface Root { dir: string; kind: 'tasks' | 'sessions' }
function clineRoots(w: Where): Root[] {
  const base = w.env.CLINE_DIR?.trim() || join(w.home, '.cline');
  return [
    { dir: join(base, 'data', 'tasks'), kind: 'tasks' }, { dir: join(base, 'tasks'), kind: 'tasks' },
    { dir: join(vscode(w, 'saoudrizwan.claude-dev'), 'tasks'), kind: 'tasks' }, { dir: join(base, 'data', 'sessions'), kind: 'sessions' },
  ];
}
const rooRoots = (w: Where): Root[] => [{ dir: join(vscode(w, 'rooveterinaryinc.roo-cline'), 'tasks'), kind: 'tasks' }];

function tagged(text: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(text);
  return m ? m[1]!.trim() : '';
}
/** What the human wrote in a user block: the task/feedback tags; environment dumps and tool-result echoes are dropped. */
export function visibleUserText(text: string): string {
  const t = text.trim();
  for (const tag of ['user_message', 'user_input', 'feedback', 'task']) { const v = tagged(t, tag); if (v) return v; }
  if (t.includes('<environment_details>') || t.startsWith('# task_progress') || t.startsWith('[ERROR] You did not use a tool') || t.startsWith('Command executed.') || t.startsWith('New instructions for task continuation:')) return '';
  return t;
}
const cwdFromText = (t: string): string => {
  const m = /# Current Working Directory \(([^)\n]+)\)/.exec(t);
  return m ? normalizeDir(m[1]) : '';
};

export function clineTurns(entries: unknown[]): { turns: Turn[]; cwd: string } {
  const turns: Turn[] = [];
  let cwd = '';
  for (const e of entries) {
    if (!isObj(e)) continue;
    const role = str(e.role).toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks: unknown[] = typeof e.content === 'string' ? [{ type: 'text', text: e.content }] : arr(e.content);
    const texts = blocks.filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text as string);
    if (!cwd) for (const t of texts) { cwd = cwdFromText(t); if (cwd) break; }
    const parts = texts.map(t => role === 'user' ? visibleUserText(t) : t.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()).filter(Boolean);
    const text = stripReminders(parts.join('\n\n'));
    const at = iso(toMs(e.ts ?? e.timestamp));
    if (text) turns.push({ role, text, ...(at ? { at } : {}) });
  }
  return { turns, cwd };
}

const entriesOf = (v: unknown): unknown[] => Array.isArray(v) ? v : isObj(v) ? (['messages', 'history', 'entries'].map(k => v[k]).find(Array.isArray) as unknown[] | undefined) ?? [] : [];

function metaDir(taskDir: string): string {
  for (const n of ['task_metadata.json', 'metadata.json', 'task.json']) {
    try {
      const o = JSON.parse(readFileSync(join(taskDir, n), 'utf8')) as unknown;
      if (!isObj(o)) continue;
      for (const c of [o, ...['metadata', 'environment', 'workspace'].map(k => o[k]).filter(isObj)])
        for (const k of ['cwd', 'currentWorkingDirectory', 'workingDirectory', 'workspacePath', 'workspaceRoot', 'projectPath', 'projectDir', 'root']) { const d = normalizeDir(c[k]); if (d) return d; }
    } catch { /* optional */ }
  }
  return '';
}

function make(id: string, harness: string, label: string, roots: (w: Where) => Root[]): Source {
  return {
    id, harness, label,
    exists: w => roots(w).some(r => { try { return statSync(r.dir).isDirectory(); } catch { return false; } }),
    scan(ctx: ScanCtx) {
      const updates: SessionUpdate[] = [];
      let found = 0;
      const seen = new Set<string>();
      for (const root of roots(ctx)) {
        let ids: string[] = [];
        try { ids = readdirSync(root.dir); } catch { continue; }
        for (const taskId of ids) {
          const taskDir = join(root.dir, taskId);
          const file = root.kind === 'tasks' ? join(taskDir, 'api_conversation_history.json') : join(taskDir, `${taskId}.messages.json`);
          if (seen.has(file)) continue;
          seen.add(file);
          try {
            const st = statSync(file);
            found++;
            const mtime = Math.floor(st.mtimeMs), prev = ctx.sessions[file];
            if (prev ? prev.size === st.size && prev.mtime === mtime : mtime < ctx.sinceMs) continue;
            if (st.size > MAX_FILE || ctx.expired()) continue;
            const { turns, cwd } = clineTurns(entriesOf(JSON.parse(readFileSync(file, 'utf8'))));
            updates.push({ id: taskId, key: file, sig: { size: st.size, mtime }, title: firstPrompt(turns).slice(0, 80), cwd: metaDir(taskDir) || cwd, turns: turns.slice(-MAX_TURNS), updatedMs: mtime });
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.fail(e); }
        }
      }
      return { found, updates };
    },
  };
}

export const cline = make('cline', 'cline', 'Cline', clineRoots);
export const roo = make('roo', 'roo', 'Roo Code', rooRoots);
