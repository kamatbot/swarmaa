import { parseArgs } from 'node:util';
import { collectUsage } from '../src/usage/index.js';
import type { UsageProviderId } from '../src/usage/types.js';

const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });
const ALL: UsageProviderId[] = ['claude', 'codex', 'antigravity', 'grok'];

function resetsIn(iso: string | null, now: number): string {
  if (!iso) return '-';
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const snaps = await collectUsage(ALL);
if (values.json) {
  console.log(JSON.stringify(snaps, null, 2));
} else {
  const now = Date.now();
  const rows: string[][] = [['provider', 'window', 'used%', 'resets in']];
  for (const s of snaps) {
    const name = s.plan ? `${s.provider} (${s.plan})` : s.provider;
    if (!s.ok) rows.push([s.provider, `ERROR: ${s.error ?? 'unknown'}`, '', '']);
    else for (const w of s.windows) rows.push([name, w.name, w.used_percent.toFixed(1), resetsIn(w.resets_at, now)]);
  }
  const width = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(width[i]!)).join('  ').trimEnd());
}
