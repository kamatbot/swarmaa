// Factory Droid: ~/.factory/sessions/<encoded-cwd>/<id>.jsonl (first line session_start, then message records).
// Adapted from Asymptote Labs agent-beacon (MIT).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Source, Turn, Where } from './types.js';
import { dashDecode, isObj, jsonlUpdate, blockText, str, stripReminders, userQuery, type Obj } from './util.js';

const dir = (w: Where) => join(w.home, '.factory', 'sessions');

export function factoryTurns(objs: Obj[]): Turn[] {
  const turns: Turn[] = [];
  for (const o of objs) {
    if (o.type !== 'message' || !isObj(o.message)) continue;
    const m = o.message, role = str(m.role);
    if ((role !== 'user' && role !== 'assistant') || m.visibility === 'llm_only') continue; // llm_only rows are injected context
    let text = stripReminders(blockText(m.content));
    if (role === 'user') text = userQuery(text);
    if (text) turns.push({ role, text, ...(typeof o.timestamp === 'string' ? { at: o.timestamp } : {}) });
  }
  return turns;
}

export const factory: Source = {
  id: 'factory', harness: 'factory', label: 'Factory Droid',
  exists: w => { try { return statSync(dir(w)).isDirectory(); } catch { return false; } },
  scan(ctx) {
    const updates = [];
    let found = 0;
    let projects: string[] = [];
    try { projects = readdirSync(dir(ctx)); } catch { /* none */ }
    for (const p of projects) {
      let files: string[] = [];
      try { files = readdirSync(join(dir(ctx), p)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      const cwd = p.startsWith('-') ? dashDecode(p) : '';
      for (const f of files) {
        const path = join(dir(ctx), p, f);
        try {
          found++;
          const u = jsonlUpdate(ctx, { key: path, id: f.slice(0, -6), path, cwd }, factoryTurns,
            head => { const h = head.find(o => o.type === 'session_start'); return h ? { cwd: str(h.cwd), title: str(h.title) } : {}; });
          if (u) updates.push(u);
        } catch (e) { ctx.fail(e); }
        if (ctx.expired()) return { found, updates };
      }
    }
    return { found, updates };
  },
};
