import { createHash, randomInt } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/db.js';
import { NATIVE_APP_PERMISSIONS } from './setup-lib.js';

// A 6-digit code the owner types on the phone. The relay finds the host from it (POST /pair/resolve),
// and the host's room checks and consumes it once. It lives five minutes; guesses are rate limited.
export const codeHash = (code: string): string => createHash('sha256').update(code.trim().toLowerCase().split(/\s+/).join(' ')).digest('hex');

/** Ensures the native-app template principal (e.g. swarmaa-mac) carries the native-app permission grants before pairing copies them to a phone. */
export async function ensureTemplatePermissions(db: Pick<Pool | PoolClient, 'query'>, template = 'swarmaa-mac'): Promise<boolean> {
  const result = await db.query(
    `UPDATE principals
     SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || $2::text[]) AS p)
     WHERE name = $1 AND role = 'frontend' AND NOT disabled
     RETURNING id`,
    [template, [...NATIVE_APP_PERMISSIONS]],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createPairing(directory = resolve('.local')): Promise<string> {
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `relay-pairing-${process.pid}-${randomInt(0x1000000)}.tmp`);
  await writeFile(temporary, JSON.stringify({ code_hash: codeHash(code), expires_at: Date.now() + 300_000 }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, resolve(directory, 'relay-pairing.json'));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    if (process.env.DATABASE_URL) {
      const pool = createPool(process.env.DATABASE_URL);
      try {
        await ensureTemplatePermissions(pool, process.env.RELAY_PAIR_TEMPLATE ?? 'swarmaa-mac');
      } finally {
        await pool.end();
      }
    }
    const code = await createPairing();
    // The sole intentional display is to the owner, never to daemon logs.
    process.stdout.write(`${code.slice(0, 3)} ${code.slice(3)}\nType it in Swarmaa on your phone within five minutes.\n`);
  })().catch(() => { process.stderr.write('Pairing setup failed.\n'); process.exitCode = 1; });
}
