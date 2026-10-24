import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AppError } from '../src/errors.js';
import { EventService } from '../src/events.js';
import { webhookSignature, type WebhookSender } from '../src/webhook.js';
import type { Principal, ServerConfig } from '../src/types.js';

interface CapturedWebhook {
  url: string;
  body: string;
  headers: Record<string, string>;
}

async function eventually(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

// Authored only. A real disposable PostgreSQL database is required; callbacks
// are fake in-memory receivers, so this test never sends external webhooks.
test('event lifecycle verifies signatures, refreshes deterministically and stops on OAuth revocation', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `events_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  let service: EventService | undefined;
  t.after(async () => {
    await service?.stop();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const migration of ['001_identity.sql', '003_oauth.sql', '004_events.sql', '017_event_subscription_cursor.sql','018_events_xid.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }

  const principal: Principal = {
    id: randomUUID(), tenantId: 'events-test', name: 'dot', role: 'frontend',
    credentialVersion: 1,
    scopes: ['project:alpha'], permissions: ['events:read', 'task:read', 'memory:read'],
  };
  await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [principal.id, principal.tenantId, principal.name, principal.role, principal.scopes, principal.permissions, randomBytes(32).toString('hex')]);
  await pool.query('INSERT INTO oauth_clients(client_id,client_name,redirect_uris) VALUES($1,$2,$3)',
    ['dot-test-client', 'Dot test', ['https://client.example/callback']]);
  const grantId = randomUUID();
  await pool.query("INSERT INTO oauth_grants(id,principal_id,client_id,resource,grant_snapshot,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,now()+interval '1 day')",
    [grantId, principal.id, 'dot-test-client', 'https://memory.example/mcp', JSON.stringify(principal)]);
  const oauthPrincipal: Principal = { ...principal, oauthGrantId: grantId };
  const config: ServerConfig = {
    host: '127.0.0.1', port: 8787, publicUrl: 'https://memory.example', allowedOrigins: [], allowInsecureLocalhost: false,
    maxBodyBytes: 524_288, oauthEnabled: true, oauthRedirectHosts: ['client.example'],
    eventCallbackHosts: ['receiver.example'], eventEncryptionKey: randomBytes(32).toString('hex'),
  };
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const nextSecret = `whsec_${randomBytes(32).toString('base64')}`;
  const verifications: CapturedWebhook[] = [];
  const deliveries: CapturedWebhook[] = [];
  const fakeSender: WebhookSender = async (url, body, headers) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const id = headers['webhook-id']!;
    const timestamp = headers['webhook-timestamp']!;
    const signatures = headers['webhook-signature']!.split(' ');
    assert.ok(/^\d+$/u.test(timestamp));
    assert.ok(headers['X-MCP-Subscription-Id']);
    assert.ok([secret, nextSecret].some(key => signatures.includes(webhookSignature(key, id, timestamp, body))), 'The request must be signed over its exact bytes.');
    if (parsed.type === 'verification') {
      assert.equal(typeof parsed.challenge, 'string');
      verifications.push({ url, body, headers });
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    }
    assert.equal(id, parsed.eventId);
    deliveries.push({ url, body, headers });
    return { status: 204, body: '' };
  };
  const auth = { authenticate: async () => principal, getPrincipal: async (id: string) => id === principal.id ? principal : null };
  service = new EventService(pool, auth, config, fakeSender);
  const params = {
    name: 'task.updated', arguments: { scope: 'project:alpha' },
    delivery: { mode: 'webhook', url: 'https://receiver.example/dot-events', secret }, cursor: null, ttlMs: 120_000,
  };
  const first = await service.handle(oauthPrincipal, 'events/subscribe', params) as { id: string; refreshBefore: string };
  assert.equal(verifications.length, 1);
  assert.ok(Date.parse(first.refreshBefore) > Date.now());
  const repeated = await service.handle(oauthPrincipal, 'events/subscribe', params) as { id: string };
  assert.equal(repeated.id, first.id);
  assert.equal(verifications.length, 1, 'The same callback and secret use a bounded verification cache.');
  assert.equal((await pool.query('SELECT id FROM event_subscriptions')).rows.length, 1);
  const stored = await pool.query<{ oauth_grant_id: string; secret_ciphertext: string }>('SELECT oauth_grant_id,secret_ciphertext FROM event_subscriptions WHERE id=$1', [first.id]);
  assert.equal(stored.rows[0]?.oauth_grant_id, grantId);
  assert.ok(!stored.rows[0]?.secret_ciphertext.includes(secret));

  await assert.rejects(service.handle(oauthPrincipal, 'events/subscribe', { ...params, arguments: { scope: 'project:beta' } }),
    error => error instanceof AppError && error.status === 403);
  assert.equal(verifications.length, 1, 'Cross-project rejection precedes callback verification.');
  const rotated = await service.handle(oauthPrincipal, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: nextSecret } }) as { id: string };
  assert.equal(rotated.id, first.id);
  assert.equal(verifications.length, 2);

  const eventId = randomUUID();
  await pool.query('INSERT INTO events(id,tenant_id,scope,name,subject_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [eventId, principal.tenantId, 'project:alpha', 'task.updated', randomUUID(), JSON.stringify({ state: 'queued' })]);
  service.start();
  await eventually(() => deliveries.some(delivery => (JSON.parse(delivery.body) as { eventId: string }).eventId === eventId), 'the first event');
  const delivered = deliveries.find(delivery => (JSON.parse(delivery.body) as { eventId: string }).eventId === eventId)!;
  for (const key of [secret, nextSecret]) {
    assert.ok(delivered.headers['webhook-signature']!.split(' ').includes(webhookSignature(key, eventId, delivered.headers['webhook-timestamp']!, delivered.body)),
      'Secret rotation signs with both old and new keys during the grace period.');
  }

  await pool.query('UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1', [grantId]);
  const revokedEventId = randomUUID();
  await pool.query('INSERT INTO events(id,tenant_id,scope,name,subject_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [revokedEventId, principal.tenantId, 'project:alpha', 'task.updated', randomUUID(), JSON.stringify({ state: 'running' })]);
  await eventually(async () => {
    const result = await pool.query<{ state: string }>('SELECT state FROM event_deliveries WHERE subscription_id=$1 AND event_id=$2', [first.id, revokedEventId]);
    return result.rows[0]?.state === 'skipped';
  }, 'revoked-grant event suppression');
  assert.ok(!deliveries.some(delivery => (JSON.parse(delivery.body) as { eventId: string }).eventId === revokedEventId));
  assert.equal((await pool.query<{ active: boolean }>('SELECT active FROM event_subscriptions WHERE id=$1', [first.id])).rows[0]?.active, false);
  await service.stop();

  const directParams = { ...params, delivery: { ...params.delivery, url: 'https://receiver.example/direct-events' } };
  const direct = await service.handle(principal, 'events/subscribe', directParams) as { id: string };
  const unsubscribe = { name: directParams.name, arguments: directParams.arguments, delivery: { mode: 'webhook', url: directParams.delivery.url } };
  assert.deepEqual(await service.handle(principal, 'events/unsubscribe', unsubscribe), {});
  assert.deepEqual(await service.handle(principal, 'events/unsubscribe', unsubscribe), {});
  assert.equal((await pool.query<{ active: boolean }>('SELECT active FROM event_subscriptions WHERE id=$1', [direct.id])).rows[0]?.active, false);

  const failedVerification = new EventService(pool, auth, config, async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(failedVerification.handle(principal, 'events/subscribe', {
    ...params, delivery: { ...params.delivery, url: 'https://receiver.example/invalid-challenge' },
  }), error => error instanceof AppError && error.code === 'callback_verification_failed');
  assert.equal((await pool.query('SELECT id FROM event_subscriptions WHERE callback_url=$1', ['https://receiver.example/invalid-challenge'])).rows.length, 0);
});

test('generic task sinks deliver only terminal states as a small signed summary with the owner headers', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `events_generic_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  let service: EventService | undefined;
  t.after(async () => { await service?.stop(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const migration of ['001_identity.sql', '002_core.sql', '019_inbox.sql', '020_inbox_receipts.sql', '003_oauth.sql', '004_events.sql', '017_event_subscription_cursor.sql','018_events_xid.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const principal: Principal = { id: randomUUID(), tenantId: 'events-generic', name: 'grok', role: 'frontend', credentialVersion: 1,
    scopes: ['project:alpha'], permissions: ['events:read', 'task:read', 'memory:read'] };
  await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [principal.id, principal.tenantId, principal.name, principal.role, principal.scopes, principal.permissions, randomBytes(32).toString('hex')]);
  const config: ServerConfig = { host: '127.0.0.1', port: 8787, publicUrl: 'https://memory.example', allowedOrigins: [], allowInsecureLocalhost: false,
    maxBodyBytes: 524_288, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: ['receiver.example'], eventEncryptionKey: randomBytes(32).toString('hex') };
  const sent: CapturedWebhook[] = [];
  service = new EventService(pool, { authenticate: async () => principal, getPrincipal: async id => id === principal.id ? principal : null }, config,
    async (url, body, headers) => { sent.push({ url, body, headers }); return { status: 202, body: '' }; });
  await service.registerGeneric(principal, { scope: 'project:alpha', name: 'task.updated', url: 'https://receiver.example/hook', headers: { Authorization: 'Bearer test-token' } });
  const taskId = randomUUID();
  await pool.query(`INSERT INTO tasks(id,tenant_id,scope,kind,objective,permission_envelope,required_capability,status,created_by,idempotency_key,request_hash)
    VALUES($1,$2,'project:alpha','research','Receipt fixture','{}','claude.read','completed',$3,'fixture','fixture')`,[taskId,principal.tenantId,principal.id]);
  const inbox=await pool.query(`INSERT INTO inbox(id,tenant_id,recipient_principal,kind,scope,task_id,from_principal,body)
    VALUES(gen_random_uuid(),$1,$2,'message','project:alpha',$3,$2,'private sink body') RETURNING delivery_id`,[principal.tenantId,principal.id,taskId]);
  await pool.query(`INSERT INTO inbox_receipts(delivery_id,session,state,offers,accepted_at,confirm_by)
    VALUES($1,'claude:accepted','accepted',1,clock_timestamp(),NULL),
      ($1,'codex:stuck','offered',3,NULL,clock_timestamp()-interval '1 second')`,[inbox.rows[0].delivery_id]);
  const emit = (status: string) => pool.query('INSERT INTO events(id,tenant_id,scope,name,subject_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [randomUUID(), principal.tenantId, 'project:alpha', 'task.updated', taskId, JSON.stringify({ task_id: taskId, status, action: status })]);
  await emit('queued'); await emit('running'); await emit('completed');
  service.start();
  await eventually(async () => (await pool.query("SELECT 1 FROM event_deliveries WHERE state IN ('pending','sending')")).rowCount === 0 && sent.length > 0, 'deliveries to settle');
  assert.equal(sent.length, 1, 'queued and running are skipped');
  const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['completed_at', 'event', 'event_id', 'inbox_receipts', 'kind', 'provider', 'scope', 'status', 'task_id', 'title']);
  assert.deepEqual([body.event, body.task_id, body.scope, body.status], ['task.completed', taskId, 'project:alpha', 'completed']);
  assert.deepEqual(body.inbox_receipts,{offered:0,accepted:1,unconfirmed:1,read:0,stuck:1});
  assert.ok(!sent[0]!.body.includes('private sink body'));
  assert.ok(!sent[0]!.body.includes('claude:accepted'));
  assert.ok(!sent[0]!.body.includes('body'));
  const h = sent[0]!.headers;
  assert.equal(h.Authorization, 'Bearer test-token', 'owner header sent as given');
  assert.equal(h['X-Collective-Event-Id'], body.event_id);
  assert.equal(h['webhook-id'], body.event_id);
  assert.ok(h['webhook-signature'] && h['webhook-timestamp'], 'Swarmaa signature headers present');
  const skipped = await pool.query("SELECT count(*)::int AS n FROM event_deliveries WHERE state='skipped' AND last_error_code='not_terminal'");
  assert.equal(skipped.rows[0].n, 2);
  const cursorRow = await pool.query<{ last_seq: string }>('SELECT last_seq::text FROM event_subscriptions LIMIT 1');
  assert.ok(BigInt(cursorRow.rows[0]!.last_seq) > 0n, 'subscription sequence cursor advances as events are discovered');
});

test('event delivery is bounded-concurrent with per-host limits so a slow sink does not block another', {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `events_conc_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  let service: EventService | undefined;
  t.after(async () => { await service?.stop(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const migration of ['001_identity.sql', '002_core.sql', '019_inbox.sql', '020_inbox_receipts.sql', '003_oauth.sql', '004_events.sql', '017_event_subscription_cursor.sql','018_events_xid.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const principal: Principal = {
    id: randomUUID(), tenantId: 'events-conc', name: 'dot', role: 'frontend', credentialVersion: 1,
    scopes: ['project:alpha'], permissions: ['events:read', 'task:read', 'memory:read'],
  };
  await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [principal.id, principal.tenantId, principal.name, principal.role, principal.scopes, principal.permissions, randomBytes(32).toString('hex')]);
  const config: ServerConfig = {
    host: '127.0.0.1', port: 8787, publicUrl: 'https://memory.example', allowedOrigins: [], allowInsecureLocalhost: false,
    maxBodyBytes: 524_288, oauthEnabled: false, oauthRedirectHosts: [],
    eventCallbackHosts: ['slow.example', 'fast.example'], eventEncryptionKey: randomBytes(32).toString('hex'),
  };
  let slowActive = 0;
  let maxSlowActive = 0;
  const fastDelivered: string[] = [];
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });

  service = new EventService(
    pool,
    { authenticate: async () => principal, getPrincipal: async id => id === principal.id ? principal : null },
    config,
    async url => {
      const host = new URL(url).hostname;
      if (host === 'slow.example') {
        slowActive++;
        maxSlowActive = Math.max(maxSlowActive, slowActive);
        await slowGate;
        slowActive--;
        return { status: 204, body: '' };
      }
      fastDelivered.push(url);
      return { status: 204, body: '' };
    },
    { maxConcurrent: 6, maxPerHost: 2 },
  );

  await service.registerGeneric(principal, { scope: 'project:alpha', name: 'memory.changed', url: 'https://slow.example/hook', headers: { Authorization: 'Bearer s' } });
  await service.registerGeneric(principal, { scope: 'project:alpha', name: 'memory.changed', url: 'https://fast.example/hook', headers: { Authorization: 'Bearer f' } });

  for (let i = 0; i < 4; i++) {
    await pool.query('INSERT INTO events(id,tenant_id,scope,name,subject_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [randomUUID(), principal.tenantId, 'project:alpha', 'memory.changed', randomUUID(), JSON.stringify({ seq: i })]);
  }

  service.start();
  await eventually(() => fastDelivered.length === 4 && slowActive === 2, 'fast sink deliveries to finish while slow sink is capped at 2');
  assert.equal(maxSlowActive, 2, 'per-host concurrency cap must hold for slow.example');
  assert.equal(fastDelivered.length, 4, 'fast.example completes all 4 events without waiting for slow.example');
  releaseSlow();
  await eventually(async () => (await pool.query("SELECT 1 FROM event_deliveries WHERE state <> 'delivered'")).rowCount === 0, 'all deliveries to complete');
  assert.equal(maxSlowActive, 2);
});
