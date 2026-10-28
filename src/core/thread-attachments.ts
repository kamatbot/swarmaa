import { createHash, randomUUID } from 'node:crypto';
import { requireCondition } from '../errors.js';
import { redactSecrets } from '../safety/redact.js';
import { object, string } from '../validation.js';
import { noExtraKeys } from './shared.js';

export const MAX_THREAD_PHOTOS = 2;
export const MAX_PHOTO_BYTES = 160 * 1024;
export const MAX_PHOTO_BASE64 = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;

export interface ThreadPhoto {
  id: string;
  name: string;
  media_type: 'image/jpeg';
  byte_length: number;
  sha256: string;
  data_base64: string;
}

/** Bound decoding work before a JPEG reaches a native or provider image decoder. */
function validateJPEG(bytes: Buffer): void {
  const valid = (condition: boolean) => requireCondition(condition, 400, 'invalid_photo', 'Photos must be JPEG images no larger than 160 KiB and 2048 × 2048 pixels.');
  valid(bytes.length >= 32 && bytes.length <= MAX_PHOTO_BYTES);
  valid(bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9);
  let offset = 2;
  let frame = false;
  while (offset + 4 <= bytes.length) {
    valid(bytes[offset++] === 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    valid(marker !== undefined && marker !== 0 && marker !== 0xd8 && marker !== 0xd9 && offset + 2 <= bytes.length);
    const length = bytes.readUInt16BE(offset);
    valid(length >= 2 && offset + length <= bytes.length - 2);
    if (marker === 0xc0 || marker === 0xc2) {
      valid(!frame && length >= 8 && bytes[offset + 2] === 8);
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      valid(width > 0 && height > 0 && width <= 2048 && height <= 2048);
      frame = true;
    } else if (marker === 0xda) {
      valid(frame && length >= 6);
      return;
    } else {
      // Only baseline/progressive Huffman JPEGs are accepted.
      valid(!(marker! >= 0xc0 && marker! <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker!)));
    }
    offset += length;
  }
  valid(false);
}

export function parseThreadPhotos(value: unknown): ThreadPhoto[] {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value) && value.length <= MAX_THREAD_PHOTOS, 400, 'invalid_photo', 'Attach up to two photos per message.');
  return (value as unknown[]).map(raw => {
    const photo = object(raw);
    noExtraKeys(photo, ['name', 'media_type', 'data_base64']);
    const name = string(photo.name, 'photo.name', 120).trim();
    requireCondition(!/[\/\\\x00-\x1f\x7f]/u.test(name), 400, 'invalid_photo', 'Photo names must be plain filenames.');
    requireCondition(photo.media_type === 'image/jpeg', 400, 'invalid_photo', 'Photos must use image/jpeg.');
    const encoded = photo.data_base64;
    requireCondition(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= MAX_PHOTO_BASE64, 400, 'invalid_photo', 'Photo exceeds the 160 KiB limit.');
    const bytes = Buffer.from(encoded as string, 'base64');
    requireCondition(bytes.toString('base64') === encoded, 400, 'invalid_photo', 'Photo must use canonical base64 encoding.');
    validateJPEG(bytes);
    return { id: randomUUID(), name: redactSecrets(name), media_type: 'image/jpeg', byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data_base64: encoded as string };
  });
}

export function storedThreadPhotos(ref: Record<string, unknown> | null): ThreadPhoto[] {
  return Array.isArray(ref?.attachments) ? ref.attachments as ThreadPhoto[] : [];
}

export function photoMetadata(photo: ThreadPhoto): Omit<ThreadPhoto, 'data_base64'> {
  return { id: photo.id, name: photo.name, media_type: photo.media_type, byte_length: photo.byte_length, sha256: photo.sha256 };
}

export function samePhotos(left: ThreadPhoto[], right: ThreadPhoto[]): boolean {
  return left.length === right.length && left.every((photo, index) => photo.name === right[index]!.name && photo.sha256 === right[index]!.sha256);
}

/** Keep image payloads out of paginated reads and their database-to-server transfer. */
export const MESSAGE_METADATA_COLUMNS = `id, tenant_id, scope, thread_id, seq, author, kind, body, idempotency_key, created_at, edited_at,
  CASE WHEN jsonb_typeof(ref->'attachments')='array' THEN jsonb_set(ref, '{attachments}',
    (SELECT COALESCE(jsonb_agg(photo - 'data_base64'), '[]'::jsonb) FROM jsonb_array_elements(ref->'attachments') photo))
  ELSE ref END AS ref`;
