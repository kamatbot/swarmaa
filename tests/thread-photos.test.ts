import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_PHOTO_BYTES, parseThreadPhotos, photoMetadata, samePhotos } from '../src/core/thread-attachments.js';

const bytes = readFileSync(new URL('./fixtures/chat-photo.jpg', import.meta.url));
const photo = { name: 'Photo.jpg', media_type: 'image/jpeg', data_base64: bytes.toString('base64') };

test('native JPEG roundtrips with stable identity evidence and metadata-only views', () => {
  const first = parseThreadPhotos([photo]);
  const retry = parseThreadPhotos([photo]);
  assert.equal(first[0]!.byte_length, bytes.length);
  assert.equal(first[0]!.data_base64, photo.data_base64);
  assert.equal(samePhotos(first, retry), true);
  assert.equal(samePhotos(first, parseThreadPhotos([{ ...photo, name: 'Changed.jpg' }])), false);
  assert.equal('data_base64' in photoMetadata(first[0]!), false);
});

test('photo validation rejects malformed, oversized, excessive and path-shaped inputs', () => {
  const bigDimensions = Buffer.from(bytes);
  const frame = bigDimensions.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame > 0);
  bigDimensions.writeUInt16BE(65535, frame + 5);
  for (const value of [
    [photo, photo, photo], [{ ...photo, media_type: 'image/png' }],
    [{ ...photo, name: '../secret.jpg' }], [{ ...photo, name: 'photo\n.jpg' }],
    [{ ...photo, data_base64: `${photo.data_base64}\n` }],
    [{ ...photo, data_base64: Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64') }],
    [{ ...photo, data_base64: bytes.subarray(0, 20).toString('base64') }],
    [{ ...photo, data_base64: bigDimensions.toString('base64') }],
  ]) assert.throws(() => parseThreadPhotos(value), { code: 'invalid_photo' });
});

test('two maximum-size JPEGs plus a full caption fit the established HTTP request cap', () => {
  const maximum = Buffer.concat([bytes.subarray(0, -2), Buffer.alloc(MAX_PHOTO_BYTES - bytes.length), bytes.subarray(-2)]);
  const attachments = [photo, photo].map(item => ({ ...item, data_base64: maximum.toString('base64') }));
  assert.equal(parseThreadPhotos(attachments).length, 2);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'thread_post', arguments: { thread_id: '00000000-0000-4000-8000-000000000000', body: 'a'.repeat(16384), idempotency_key: 'x'.repeat(200), attachments } } };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 512 * 1024);
});
