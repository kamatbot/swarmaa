// Keeps the Grok Bot webhook sinks alive: re-registers one task.updated sink per project the `grok`
// identity can use, from .local/grok-webhook.json ({url, headers}). Registration is idempotent and pushes
// the expiry 30 days out, so a weekly run never lets a sink lapse. Never prints the URL or headers.
//   node --env-file=.env --import tsx scripts/renew-sinks.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

const file = '.local/grok-webhook.json';
if (!existsSync(file)) { console.log(`${new Date().toISOString()} no ${file}; nothing to renew`); process.exit(0); }
const { url, headers } = JSON.parse(readFileSync(file, 'utf8')) as { url: string; headers: Record<string, string> };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scopes = (await pool.query<{ scopes: string[] }>("SELECT scopes FROM principals WHERE name='grok' AND NOT disabled")).rows[0]?.scopes ?? [];
await pool.end();
let failed = 0;
for (const scope of scopes) {
  try {
    execFileSync(process.execPath, ['--env-file=.env', '--import', 'tsx', 'scripts/admin.ts', 'add-sink', '--name', 'grok', '--scope', scope, '--event', 'task.updated', '--days', '30'],
      { env: { ...process.env, CALLBACK_URL: url, CALLBACK_HEADERS_JSON: JSON.stringify(headers) }, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { failed++; console.log(`${new Date().toISOString()} renew failed for ${scope}`); }
}
console.log(`${new Date().toISOString()} renewed ${scopes.length - failed}/${scopes.length} grok sinks`);
process.exit(failed ? 1 : 0);
