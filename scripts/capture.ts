// One-shot chat capture: scans the AI coding apps installed on this Mac and sends new/changed sessions to the local Swarmaa service.
// Usage: npm run capture -- [--once] [--dry-run] [--only cursor,opencode]. No daemon: it scans, sends, saves cursors and exits.
// Prints per-source counts only, never chat text. --dry-run reads app data read-only and writes and sends nothing.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SOURCE_IDS, runCapture } from '../src/capture/index.js';

const { values } = parseArgs({ options: { once: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, only: { type: 'string' } }, strict: true });
const only = values.only?.split(',').map(s => s.trim()).filter(Boolean);
const bad = only?.filter(s => !SOURCE_IDS.includes(s));
if (bad?.length) { console.error(`unknown source: ${bad.join(', ')} (known: ${SOURCE_IDS.join(', ')})`); process.exit(2); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dry = values['dry-run'] === true;
const { reports, skipped } = await runCapture({ root, dry, only });
if (skipped) console.log(`capture: ${skipped}`);
for (const r of reports) {
  if (!r.present) { console.log(`${r.id}: not installed`); continue; }
  console.log(`${r.id}: found ${r.found} sessions, ${dry ? 'would send' : 'sent'} ${dry ? r.changed : `${r.sent}/${r.changed}`}${r.errors.length ? `, errors: ${[...new Set(r.errors)].join(', ')}` : ''}`);
}
process.exit(0);
