// Pi (and Prime): ~/.pi/agent/sessions/**.jsonl, ~/.prime/agent/sessions. Header line type "session" carries id and cwd.
// Adapted from Asymptote Labs agent-beacon (MIT).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Source, Turn, Where } from './types.js';
import { blockText, isObj, jsonlUpdate, str, stripReminders, type Obj } from './util.js';

const MAX_FILES = 15_000;
function roots(w: Where): string[] {
  const agent = w.env.PI_CODING_AGENT_DIR?.trim();
  const pi = agent ? (agent === '~' ? w.home : agent.startsWith('~/') ? join(w.home, agent.slice(2)) : agent) : join(w.home, '.pi', 'agent');
  return [join(pi, 'sessions'), join(w.home, '.prime', 'agent', 'sessions')];
}

export function piTurns(objs: Obj[]): Turn[] {
  const turns: Turn[] = [];
  for (const o of objs) {
    if (o.type !== 'message' || !isObj(o.message)) continue;
    const m = o.message, role = str(m.role).toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue; // toolResult / bashExecution rows are skipped
    const text = stripReminders(blockText(m.content)); // text blocks only: thinking and tool calls are dropped
    if (text) turns.push({ role, text, ...(typeof o.timestamp === 'string' ? { at: o.timestamp } : {}) });
  }
  return turns;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) out.push(p);
  }
}

export const pi: Source = {
  id: 'pi', harness: 'pi', label: 'Pi',
  exists: w => roots(w).some(r => { try { return statSync(r).isDirectory(); } catch { return false; } }),
  scan(ctx) {
    const files: string[] = [];
    for (const r of roots(ctx)) walk(r, files);
    const updates = [];
    for (const path of files) {
      try {
        const base = path.replace(/^.*\//, '').replace(/\.jsonl$/i, '');
        const u = jsonlUpdate(ctx, { key: path, id: base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base, path }, piTurns,
          head => { const h = head.find(o => str(o.type).toLowerCase() === 'session'); return h ? { id: str(h.id), cwd: str(h.cwd) } : {}; });
        if (u) updates.push(u);
      } catch (e) { ctx.fail(e); }
      if (ctx.expired()) break;
    }
    return { found: files.length, updates };
  },
};
