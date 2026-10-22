// GitHub Copilot CLI: ~/.copilot/session-state/<id>/events.jsonl + workspace.yaml. Adapted from Asymptote Labs agent-beacon (MIT).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Source, Turn, Where } from './types.js';
import { isObj, jsonlUpdate, str, stripReminders, type Obj } from './util.js';

const stateDir = (w: Where) => join(w.env.COPILOT_HOME?.trim() || join(w.home, '.copilot'), 'session-state');

/** The few flat `key: value` pairs we need from workspace.yaml (id, cwd, git_root, name); no YAML parser needed. */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v) && v.length >= 2) v = v.slice(1, -1);
    if (!v || v === '~' || v === 'null') continue;
    out[m[1]!] = v;
  }
  return out;
}

export function copilotTurns(objs: Obj[]): Turn[] {
  const turns: Turn[] = [];
  for (const o of objs) {
    const d = isObj(o.data) ? o.data : {};
    if (o.type !== 'user.message' && o.type !== 'assistant.message') continue;
    if (d.parentToolCallId) continue; // sub-agent output
    const text = stripReminders(str(d.content)); // `content` is what was typed; transformedContent adds injected context
    if (text) turns.push({ role: o.type === 'user.message' ? 'user' : 'assistant', text, ...(typeof o.timestamp === 'string' ? { at: o.timestamp } : {}) });
  }
  return turns;
}

export const copilot: Source = {
  id: 'copilot', harness: 'copilot', label: 'GitHub Copilot CLI',
  exists: w => { try { return statSync(stateDir(w)).isDirectory(); } catch { return false; } },
  scan(ctx) {
    const updates = [];
    let found = 0;
    let dirs: string[] = [];
    try { dirs = readdirSync(stateDir(ctx)); } catch { /* none */ }
    for (const name of dirs) {
      const dir = join(stateDir(ctx), name), path = join(dir, 'events.jsonl');
      try {
        statSync(path); found++;
        let meta: Record<string, string> = {};
        try { meta = parseWorkspaceYaml(readFileSync(join(dir, 'workspace.yaml'), 'utf8')); } catch { /* optional */ }
        const u = jsonlUpdate(ctx, { key: path, id: meta.id || name, path, cwd: meta.cwd || meta.git_root, title: meta.name }, copilotTurns);
        if (u) updates.push(u);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.fail(e); }
      if (ctx.expired()) break;
    }
    return { found, updates };
  },
};
