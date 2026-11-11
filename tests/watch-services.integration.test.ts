/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. Memo storage needs macOS. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Permission, Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('watch services', { skip: !connectionString, concurrency: false }, () => {
  const schema = `watch_services_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool, pool: Pool, core: CoreService, server: Server, dir: string;
  const reviews = new Map<string, any>();
  let remoteCalls = 0;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    core = new CoreService(pool);
    // The memo service rejects symlinked path components; macOS /var is a symlink to /private/var.
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-services-')));
    // Fake RetireOdds: immutable previews keyed by requestId, idempotent confirmation keyed by confirmationId.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        remoteCalls++;
        const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        const input = body ? JSON.parse(body) : {};
        if (req.url === '/api/integrations/swarmaa/transactions/preview') {
          const existing = [...reviews.values()].find(r => r.requestId === input.requestId);
          if (existing) return send(200, existing.review);
          const reviewId = randomUUID();
          const expired = input.values.payee === 'Expired';
          const review = { reviewId, reviewToken: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
            expiresAt: new Date(Date.now() + (expired ? -60_000 : 600_000)).toISOString(), accountId: input.expectedUserId,
            operation: input.operation, before: null, after: { ...input.values }, status: 'pending' };
          reviews.set(reviewId, { requestId: input.requestId, review });
          return send(200, review);
        }
        if (req.url === '/api/integrations/swarmaa/transactions/confirm') {
          const entry = reviews.get(input.reviewId);
          if (!entry || entry.review.reviewToken !== input.reviewToken) return send(409, { error: 'REVIEW_CONFLICT' });
          if (!entry.review.receipt) {
            entry.review = { ...entry.review, status: 'confirmed', receipt: { id: input.confirmationId, reviewId: input.reviewId,
              accountId: entry.review.accountId, expense: { id: 'exp-1', ...entry.review.after }, confirmedAt: new Date().toISOString(), status: 'confirmed' } };
          }
          return send(200, entry.review);
        }
        const id = decodeURIComponent((req.url ?? '').split('/').pop()!.split('?')[0]!);
        const entry = reviews.get(id);
        return entry ? send(200, entry.review) : send(404, { error: 'NOT_FOUND' });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const cookie = path.join(dir, 'cookie');
    await writeFile(cookie, 'session=test', { mode: 0o600 });
    process.env.SWARMAA_RETIREODDS_ORIGIN = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env.SWARMAA_RETIREODDS_USER_ID = 'user-1';
    process.env.SWARMAA_RETIREODDS_COOKIE_FILE = cookie;
    process.env.SWARMAA_MEMO_DIR = path.join(dir, 'memos');
  });

  after(async () => {
    server?.close();
    await pool?.end();
    if (control) { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.end(); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown>) => await core.call(p, name, args) as Record<string, any>;
  const rejects = (promise: Promise<unknown>, status: number, code: string) =>
    assert.rejects(promise, (e: any) => { assert.equal(e.code, code); assert.equal(e.status, status); return true; });

  async function principal(tenantId: string, permissions: Permission[] = ROLE_PERMISSIONS.frontend) {
    const p: Principal = { id: randomUUID(), tenantId, name: `phone-${randomUUID()}`, role: 'frontend', scopes: ['project:a'], permissions: [...permissions] };
    await pool.query(`INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`, [p.id, tenantId, p.name, p.role, p.scopes, p.permissions, randomUUID()]);
    return p;
  }
  async function setup() {
    const tenant = randomUUID();
    const user = await principal(tenant);
    const lead = (await call(user, 'agent_create', { name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } })).agent;
    const { thread } = await call(user, 'bot_create', { name: 'Ledger bot', job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [] });
    process.env.SWARMAA_RETIREODDS_PRINCIPALS = user.id;
    return { tenant, user, thread: thread.id as string };
  }
  const values = (payee = 'Cafe') => ({ payee, date: '2026-11-11', amount: '12.50', currency: 'THB', category: 'Food' });

  it('denies principals without permission, allowlisting or tenant access', async () => {
    const { tenant, user, thread } = await setup();
    const readOnly = await principal(tenant, ['thread:read']);
    const outsider = await principal(randomUUID());
    process.env.SWARMAA_RETIREODDS_PRINCIPALS = [user.id, readOnly.id, outsider.id].join(',');
    const preview = { thread_id: thread, request_id: randomUUID(), operation: 'create', values: values() };
    await rejects(call(readOnly, 'watch_transaction_preview', preview), 403, 'forbidden');
    await rejects(call(outsider, 'watch_transaction_preview', preview), 404, 'thread_not_found');
    await rejects(call(readOnly, 'watch_memo_status', { thread_id: thread, memo_id: randomUUID() }), 403, 'forbidden');
    process.env.SWARMAA_RETIREODDS_PRINCIPALS = randomUUID();
    await rejects(call(user, 'watch_transaction_preview', preview), 403, 'retireodds_forbidden');
  });

  it('replays previews and confirmations idempotently', async () => {
    const { user, thread } = await setup();
    const preview = { thread_id: thread, request_id: randomUUID(), operation: 'create', values: values() };
    const first = await call(user, 'watch_transaction_preview', preview);
    assert.deepEqual(await call(user, 'watch_transaction_preview', preview), first);
    await rejects(call(user, 'watch_transaction_preview', { ...preview, values: values('Other') }), 409, 'transaction_conflict');
    const confirm = { thread_id: thread, review_id: first.reviewId, review_token: first.reviewToken, confirmation_id: randomUUID() };
    const done = await call(user, 'watch_transaction_confirm', confirm);
    assert.equal(done.receipt.id, confirm.confirmation_id);
    assert.deepEqual(await call(user, 'watch_transaction_confirm', confirm), done);
    assert.equal((await call(user, 'watch_transaction_get', { thread_id: thread, review_id: first.reviewId })).status, 'confirmed');
  });

  it('rejects stale, replayed or foreign confirmations before calling RetireOdds', async () => {
    const { tenant, user, thread } = await setup();
    const first = await call(user, 'watch_transaction_preview', { thread_id: thread, request_id: randomUUID(), operation: 'create', values: values() });
    const confirm = { thread_id: thread, review_id: first.reviewId, review_token: first.reviewToken, confirmation_id: randomUUID() };
    const calls = remoteCalls;
    await rejects(call(user, 'watch_transaction_confirm', { ...confirm, review_token: 'f'.repeat(64) }), 409, 'review_stale');
    const other = await principal(tenant);
    process.env.SWARMAA_RETIREODDS_PRINCIPALS = [user.id, other.id].join(',');
    await rejects(call(other, 'watch_transaction_confirm', confirm), 404, 'review_not_found');
    assert.equal(remoteCalls, calls);
    await call(user, 'watch_transaction_confirm', confirm);
    await rejects(call(user, 'watch_transaction_confirm', { ...confirm, confirmation_id: randomUUID() }), 409, 'review_already_confirmed');
    const expired = await call(user, 'watch_transaction_preview', { thread_id: thread, request_id: randomUUID(), operation: 'create', values: values('Expired') });
    await rejects(call(user, 'watch_transaction_confirm', { thread_id: thread, review_id: expired.reviewId, review_token: expired.reviewToken, confirmation_id: randomUUID() }), 409, 'review_expired');
  });

  it('stores a chunked memo idempotently and rejects conflicting chunks', { skip: process.platform !== 'darwin' }, async () => {
    const { user, thread } = await setup();
    const data = Buffer.alloc(200_000, 7);
    data.write('ftypM4A ', 4, 'ascii');
    const { createHash } = await import('node:crypto');
    const base = { memo_id: randomUUID(), thread_id: thread, sha256: createHash('sha256').update(data).digest('hex'), byte_length: data.length, captured_at: '2026-11-11T10:00:00Z' };
    const chunk = (index: number, bytes = data) => ({ ...base, index, data_base64: bytes.subarray(index * 131072, (index + 1) * 131072).toString('base64') });
    assert.equal((await call(user, 'watch_memo_put', chunk(0))).status, 'uploading');
    assert.equal((await call(user, 'watch_memo_put', chunk(0))).status, 'uploading');
    const tampered = Buffer.from(data); tampered[5] = 0;
    await rejects(call(user, 'watch_memo_put', chunk(0, tampered)), 409, 'memo_conflict');
    assert.deepEqual((await call(user, 'watch_memo_status', { memo_id: base.memo_id, thread_id: thread })).received_indices, [0]);
    const stored = await call(user, 'watch_memo_put', chunk(1));
    assert.equal(stored.status, 'stored'); assert.equal(stored.stored_on, 'mac');
    assert.equal((await call(user, 'watch_memo_status', { memo_id: base.memo_id, thread_id: thread })).status, 'stored');
  });
});
