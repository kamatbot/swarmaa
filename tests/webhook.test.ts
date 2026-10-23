import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { EventService } from '../src/events.js';
import type { Principal, ServerConfig } from '../src/types.js';
import { callbackUrl, decodeWebhookSecret, isPublicAddress, SecretBox, signedHeaders, webhookSignature } from '../src/webhook.js';

test('callback policy rejects redirects-by-URL, credentials, literal IPs and unlisted hosts', () => {
  assert.equal(callbackUrl('https://receiver.example.com/callback?q=1', ['receiver.example.com']).hostname, 'receiver.example.com');
  for (const url of ['http://receiver.example.com/x','https://receiver.example.com:444/x','https://user:pass@receiver.example.com/x','https://receiver.example.com/x#secret','https://127.0.0.1/x','https://other.example.com/x','https://receiver.example.com.evil.test/x']) {
    assert.throws(() => callbackUrl(url, ['receiver.example.com']));
  }
});

test('private and reserved destinations include mapped IPv6 and documentation networks', () => {
  for (const address of ['127.0.0.1','10.0.0.5','172.16.0.8','192.168.1.2','169.254.169.254','100.64.1.2','192.0.2.1','224.0.0.1','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('stored secret encryption authenticates both subscription identity and ciphertext', () => {
  const box = new SecretBox('ab'.repeat(32));
  const sealed = box.encrypt('sensitive signing material', 'subscription-A');
  assert.equal(box.decrypt(sealed, 'subscription-A'), 'sensitive signing material');
  assert.throws(() => box.decrypt(sealed, 'subscription-B'));
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[2], 'base64url');
  bytes[0] ^= 1;
  parts[2] = bytes.toString('base64url');
  assert.throws(() => box.decrypt(parts.join('.'), 'subscription-A'));
});

test('webhook signatures bind event id, time and exact bytes and support rotation', () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
  const older = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
  const signature = webhookSignature(secret, 'event-1', '123', '{"a":1}');
  assert.notEqual(signature, webhookSignature(secret, 'event-2', '123', '{"a":1}'));
  assert.notEqual(signature, webhookSignature(secret, 'event-1', '124', '{"a":1}'));
  assert.notEqual(signature, webhookSignature(secret, 'event-1', '123', '{ "a": 1 }'));
  const headers = signedHeaders(secret, 'sub-1', 'event-1', '{}', older);
  assert.equal(headers['webhook-signature'].split(' ').length, 2);
  assert.equal(headers['webhook-id'], 'event-1');
  assert.equal(decodeWebhookSecret(secret).length, 32);
  assert.throws(() => decodeWebhookSecret('whsec_YQ=='));
  assert.throws(() => decodeWebhookSecret(`whsec_${'!'.repeat(44)}`));
});

test('event delivery is concurrent with per-host limits so a slow sink does not block another, and uses sequence cursor discovery', async () => {
  const key = randomBytes(32).toString('hex');
  const box = new SecretBox(key);
  const principal: Principal = {
    id: randomUUID(), tenantId: 't1', name: 'dot', role: 'frontend', credentialVersion: 1,
    scopes: ['project:alpha'], permissions: ['events:read', 'memory:read'],
  };
  const config: ServerConfig = {
    host: '127.0.0.1', port: 8787, publicUrl: 'https://memory.example', allowedOrigins: [], allowInsecureLocalhost: false,
    maxBodyBytes: 524_288, oauthEnabled: false, oauthRedirectHosts: [],
    eventCallbackHosts: ['slow.example.com', 'fast.example.com'], eventEncryptionKey: key,
  };
  const slowSubId = 'sub_slow';
  const fastSubId = 'sub_fast';
  const slowCipher = box.encrypt(JSON.stringify({ Authorization: 'Bearer s' }), slowSubId);
  const fastCipher = box.encrypt(JSON.stringify({ Authorization: 'Bearer f' }), fastSubId);
  const queue = [
    { subscription_id: slowSubId, event_id: 'ev_s1', attempts: 0, callback_url: 'https://slow.example.com/hook', state: 'pending' },
    { subscription_id: slowSubId, event_id: 'ev_s2', attempts: 0, callback_url: 'https://slow.example.com/hook', state: 'pending' },
    { subscription_id: slowSubId, event_id: 'ev_s3', attempts: 0, callback_url: 'https://slow.example.com/hook', state: 'pending' },
    { subscription_id: fastSubId, event_id: 'ev_f1', attempts: 0, callback_url: 'https://fast.example.com/hook', state: 'pending' },
    { subscription_id: fastSubId, event_id: 'ev_f2', attempts: 0, callback_url: 'https://fast.example.com/hook', state: 'pending' },
  ];
  let discoverySql = '';
  const queryFn = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('JOIN LATERAL')) {
      discoverySql = sql;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FOR UPDATE OF d SKIP LOCKED')) {
      const blocked = (params[1] as string[]) ?? [];
      const next = queue.find(item => item.state === 'pending' && !blocked.includes(new URL(item.callback_url).hostname));
      return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
    }
    if (sql.includes("SET state='sending'")) {
      const [subId, evId, token] = params as [string, string, string];
      const item = queue.find(q => q.subscription_id === subId && q.event_id === evId);
      if (item) item.state = 'sending';
      return { rows: item ? [{ ...item, attempts: 1, lock_token: token }] : [], rowCount: item ? 1 : 0 };
    }
    if (sql.includes('SELECT s.*,e.subject_id')) {
      const [subId, evId] = params as [string, string];
      const isSlow = subId === slowSubId;
      return {
        rows: [{
          id: subId, principal_id: principal.id, oauth_grant_id: null, credential_version: 1, revision: 1,
          tenant_id: 't1', scope: 'project:alpha', name: 'memory.changed', mode: 'generic',
          callback_url: isSlow ? 'https://slow.example.com/hook' : 'https://fast.example.com/hook',
          secret_ciphertext: isSlow ? slowCipher : fastCipher, previous_secret_ciphertext: null, previous_secret_until: null,
          verified_until: new Date(Date.now() + 60_000), starts_at: new Date(Date.now() - 60_000),
          expires_at: new Date(Date.now() + 60_000), active: true, last_seq: '5',
          subject_id: evId, payload: { k: 'v' }, event_created_at: new Date(),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE event_deliveries SET state=$4')) {
      const [subId, evId, , state] = params as [string, string, string, string];
      const item = queue.find(q => q.subscription_id === subId && q.event_id === evId);
      if (item) item.state = state;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const fakePool = {
    query: queryFn,
    connect: async () => ({ query: queryFn, release: () => undefined }),
  } as unknown as Pool;

  let slowInFlight = 0;
  let maxSlowInFlight = 0;
  const fastCompleted: string[] = [];
  let releaseSlow!: () => void;
  const slowBarrier = new Promise<void>(resolve => { releaseSlow = resolve; });

  const service = new EventService(
    fakePool,
    { authenticate: async () => principal, getPrincipal: async () => principal },
    config,
    async url => {
      if (url.includes('slow.example.com')) {
        slowInFlight++;
        maxSlowInFlight = Math.max(maxSlowInFlight, slowInFlight);
        await slowBarrier;
        slowInFlight--;
        return { status: 204, body: '' };
      }
      fastCompleted.push(url);
      return { status: 204, body: '' };
    },
    { maxConcurrent: 6, maxPerHost: 2 },
  );

  service.start();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (fastCompleted.length < 2 || slowInFlight < 2)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(discoverySql.includes('e.seq > s.last_seq'), 'event discovery uses per-subscription sequence cursor');
  assert.equal(maxSlowInFlight, 2, 'slow host is capped at maxPerHost (2) even with 3 pending deliveries');
  assert.equal(fastCompleted.length, 2, 'fast host completes all deliveries while slow host is still blocked');
  releaseSlow();
  while (Date.now() < deadline && queue.some(q => q.state !== 'delivered')) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await service.stop();
  assert.ok(queue.every(q => q.state === 'delivered'));
  assert.equal(maxSlowInFlight, 2);
});

