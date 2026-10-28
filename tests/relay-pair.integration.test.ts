import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { provisionConnection, provisionRelayConnection } from '../src/provision.js';
import { hashToken } from '../src/auth.js';

test('DB pairing success copies exact scopes and permissions with a sanitized frontend name and hashed token', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const schema = `relay_pair_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 2 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(await readFile(new URL('../db/migrations/001_identity.sql', import.meta.url), 'utf8'));
  await provisionConnection(pool, { tenant: 'personal', name: 'notchtrader', role: 'frontend', scopes: ['project:one', 'project:two'], permissions: ['memory:read', 'thread:write'] });
  const token = await provisionRelayConnection(pool, 'notchtrader', 'My Phone / 🚀');
  const row = (await pool.query('SELECT * FROM principals WHERE token_hash=$1', [hashToken(token)])).rows[0];
  assert.match(row.name, /^relay-my-phone-[a-f0-9]{4}$/);
  assert.equal(row.role, 'frontend'); assert.equal(row.tenant_id, 'personal');
  assert.deepEqual(row.scopes, ['project:one', 'project:two']); assert.deepEqual(row.permissions, ['memory:read', 'thread:write']);
  assert.notEqual(row.token_hash, token);
  await t.test('template_missing fails without creating a principal', async () => {
    await assert.rejects(provisionRelayConnection(pool, 'absent', 'phone'), /template_missing/);
    assert.equal((await pool.query('SELECT count(*) FROM principals')).rows[0].count, '2');
  });
  await t.test('admin and disabled templates cannot provision', async () => {
    await provisionConnection(pool, { tenant: 'personal', name: 'owner', role: 'admin', scopes: ['*'], permissions: ['admin'] });
    await assert.rejects(provisionRelayConnection(pool, 'owner', 'phone'), /template_invalid/);
    await pool.query("UPDATE principals SET disabled=true WHERE name='notchtrader'");
    await assert.rejects(provisionRelayConnection(pool, 'notchtrader', 'phone'), /template_missing/);
  });
});
