import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { AppError, requireCondition } from './errors.js';

export interface WebhookResponse { status: number; body: string }
export type WebhookSender = (url: string, body: string, headers: Record<string, string>) => Promise<WebhookResponse>;

export function callbackUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, 'invalid_callback', 'Callback URL is invalid.'); }
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !raw.includes('#') && (!url.port || url.port === '443'), 400, 'invalid_callback', 'Callbacks require HTTPS on port 443 without credentials or a fragment.');
  requireCondition(!isIP(url.hostname.replace(/^\[|\]$/g, '')) && allowedHosts.includes(url.hostname.toLowerCase()), 403, 'callback_forbidden', 'The callback hostname must be explicitly allowed by the service owner.');
  return url;
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}

/** Connect to a validated address, not a second DNS lookup. TLS still verifies the original hostname. */
export function createWebhookSender(allowedHosts: string[]): WebhookSender {
  return async (raw, body, headers) => {
    const url = callbackUrl(raw, allowedHosts);
    requireCondition(Buffer.byteLength(body) <= 256 * 1024, 400, 'event_too_large', 'Webhook body exceeds 256 KiB.');
    // Bound DNS independently; lookup() itself cannot be cancelled on all supported Node versions.
    let dnsTimer: NodeJS.Timeout | undefined;
    let addresses;
    try {
      addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new AppError(504, 'callback_timeout', 'Callback DNS timed out.')), 3000); }),
      ]);
    } finally { if (dnsTimer) clearTimeout(dnsTimer); }
    requireCondition(addresses.length > 0 && addresses.every(a => isPublicAddress(a.address)), 403, 'callback_address_forbidden', 'Callback DNS must resolve only to public addresses.');
    const chosen = addresses[0];
    return await new Promise<WebhookResponse>((resolve, reject) => {
      const req = request({
        hostname: chosen.address, family: chosen.family, port: 443,
        servername: url.hostname,
        checkServerIdentity: (_name, cert) => checkServerIdentity(url.hostname, cert),
        method: 'POST', path: `${url.pathname}${url.search}`, agent: false,
        headers: { ...headers, Host: url.host, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) { req.destroy(new AppError(502, 'callback_response_too_large', 'Callback response exceeds the limit.')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', err => { clearTimeout(timer); reject(err); });
        res.on('aborted', () => { clearTimeout(timer); reject(new AppError(502, 'callback_aborted', 'Callback response ended early.')); });
      });
      const timer = setTimeout(() => req.destroy(new AppError(504, 'callback_timeout', 'Callback request timed out.')), 7000);
      req.on('error', err => { clearTimeout(timer); reject(err); });
      req.end(body);
    });
  };
}

export function decodeWebhookSecret(secret: string): Buffer {
  requireCondition(/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret), 400, 'invalid_secret', 'Webhook secret must have a whsec_ prefix and canonical base64 encoding.');
  const raw = secret.slice(6);
  const key = Buffer.from(raw, 'base64');
  requireCondition(key.length >= 24 && key.length <= 64 && key.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, ''), 400, 'invalid_secret', 'Webhook secret must decode to 24–64 bytes.');
  return key;
}

export function webhookSignature(secret: string, id: string, timestamp: string, body: string): string {
  return `v1,${createHmac('sha256', decodeWebhookSecret(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function signedHeaders(secret: string, subscriptionId: string, id: string, body: string, oldSecret?: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatures = [webhookSignature(secret, id, timestamp, body)];
  if (oldSecret && oldSecret !== secret) signatures.push(webhookSignature(oldSecret, id, timestamp, body));
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscriptionId };
}

/** Context binding prevents a ciphertext being moved to a different subscription. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    requireCondition(/^[0-9a-f]{64}$/i.test(hexKey), 503, 'events_not_configured', 'Webhook encryption is not configured.');
    this.key = Buffer.from(hexKey, 'hex');
  }
  encrypt(value: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64url')).join('.');
  }
  decrypt(value: string, context: string): string {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted secret format.');
    const [iv, tag, ciphertext] = parts.map(v => Buffer.from(v, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
