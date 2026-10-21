import test from 'node:test';
import assert from 'node:assert/strict';
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
