import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packageRoot } from './setup-lib.js';
import { createPool } from '../src/db.js';

export async function migrate(databaseUrl: string, directory = join(packageRoot(dirname(fileURLToPath(import.meta.url))), 'db/migrations')): Promise<void> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('collective-network-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter(f => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT sha256 FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].sha256 !== digest) throw new Error(`Applied migration ${name} was modified. Restore it and create a new migration.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, sha256) VALUES ($1,$2)', [name, digest]);
        await client.query('COMMIT');
        process.stderr.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('collective-network-migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  await migrate(url);
}
