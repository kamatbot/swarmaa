/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;

describe('Live Activity token columns', { skip: !connectionString }, () => {
  const schema = `activity_tokens_${randomUUID().replaceAll('-', '')}`;
  let control: Pool;
  let pool: Pool;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` });
    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
  });
  after(async () => {
    await pool?.end();
    await control?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control?.end();
  });

  it('stores hex tokens up to 512 characters and rejects longer or non-hex ones', async () => {
    const constraints = (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('push_devices_activity_start_token_check','bot_activity_tokens_token_check')`)).rows;
    assert.equal(constraints.length, 2);
    // Evaluate each check exactly as PostgreSQL would on insert ({n,m} above 255 fails to compile at runtime).
    for (const value of ['a'.repeat(64), 'f'.repeat(512)]) {
      const row = (await pool.query(`SELECT ($1::text ~ '^[0-9a-f]+$' AND length($1::text) <= 512) AS ok`, [value])).rows[0];
      assert.equal(row.ok, true);
    }
    for (const c of constraints) {
      const check = c.def.replace(/^CHECK \(\((.*)\)\)$/su, '$1').replace(/^CHECK \((.*)\)$/su, '$1');
      const column = c.conname.startsWith('push_devices') ? 'activity_start_token' : 'token';
      const run = (value: string) => pool.query(`SELECT (${check.replaceAll(column, '$1::text')}) AS ok`, [value]);
      assert.equal((await run('ab'.repeat(256))).rows[0].ok, true, `${c.conname}: 512 hex chars pass`);
      assert.equal((await run('a'.repeat(513))).rows[0].ok, false, `${c.conname}: 513 chars fail`);
      assert.equal((await run('xyz')).rows[0].ok, false, `${c.conname}: non-hex fails`);
    }
  });
});
