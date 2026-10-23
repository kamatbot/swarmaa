import { isIP } from 'node:net';
import type { ServerConfig } from './types.js';

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error('Boolean environment values must be true or false.');
  return value === 'true';
}

function csv(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '127.0.0.1';
}

function parseTrustedProxies(env: NodeJS.ProcessEnv): { trustProxy: boolean; trustedProxies: string[] } {
  const raw = env.TRUST_PROXY?.trim().toLowerCase();
  const list = csv(env.TRUSTED_PROXIES);
  for (const entry of list) {
    if (entry !== 'loopback' && !isIP(entry)) throw new Error('TRUSTED_PROXIES must contain valid IP addresses or loopback.');
  }
  if (raw === undefined || raw === '') return { trustProxy: list.length > 0, trustedProxies: list };
  if (raw === 'true' || raw === 'loopback' || raw === 'cloudflare') return { trustProxy: true, trustedProxies: list };
  if (raw === 'false') return { trustProxy: false, trustedProxies: [] };
  const fromTrustProxy = csv(env.TRUST_PROXY);
  for (const entry of fromTrustProxy) {
    if (entry !== 'loopback' && !isIP(entry)) throw new Error('Boolean environment values must be true or false.');
  }
  return { trustProxy: fromTrustProxy.length > 0, trustedProxies: [...new Set([...list, ...fromTrustProxy])] };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const allowInsecureLocalhost = flag(env.ALLOW_INSECURE_LOCALHOST, false);
  const url = new URL(env.PUBLIC_URL ?? `http://127.0.0.1:${port}`);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('PUBLIC_URL must be an origin without a path or credentials.');
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && url.protocol === 'http:' && isLoopbackHostname(url.hostname))) throw new Error('PUBLIC_URL must use HTTPS; local development requires explicit ALLOW_INSECURE_LOCALHOST=true.');
  const host = env.HOST ?? '127.0.0.1';
  const eventEncryptionKey = env.EVENT_ENCRYPTION_KEY ?? '';
  if (eventEncryptionKey && !/^[0-9a-f]{64}$/i.test(eventEncryptionKey)) throw new Error('EVENT_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters.');
  const callbackHosts = csv(env.EVENT_CALLBACK_HOSTS).map(h => h.toLowerCase());
  for (const h of callbackHosts) if (!/^[a-z0-9.-]+$/i.test(h) || h.includes('*')) throw new Error('Callback allowlists require exact DNS hostnames without ports or wildcards.');
  for (const h of csv(env.OAUTH_REDIRECT_HOSTS)) if (h !== '[::1]' && !/^[a-z0-9.-]+$/i.test(h)) throw new Error('OAuth redirect allowlists require exact hostnames without ports or wildcards.');
  if (callbackHosts.length > 0 && !eventEncryptionKey) throw new Error('Webhook delivery requires EVENT_ENCRYPTION_KEY.');
  const allowedOrigins = csv(env.ALLOWED_ORIGINS);
  if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
  for (const origin of allowedOrigins) if (new URL(origin).origin !== origin) throw new Error('ALLOWED_ORIGINS must contain exact URL origins.');
  const { trustProxy, trustedProxies } = parseTrustedProxies(env);
  return {
    host, port, publicUrl: url.origin, allowedOrigins, allowInsecureLocalhost,
    maxBodyBytes: 512 * 1024,
    oauthEnabled: flag(env.OAUTH_ENABLED, true),
    oauthRedirectHosts: csv(env.OAUTH_REDIRECT_HOSTS).map(h => h.toLowerCase()),
    eventCallbackHosts: callbackHosts, eventEncryptionKey,
    passkeyRpId: env.PASSKEY_RP_ID?.trim().toLowerCase() || undefined,
    trustProxy,
    trustedProxies,
  };
}
