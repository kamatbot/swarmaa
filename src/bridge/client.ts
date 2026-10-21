import { serviceUrl } from './config.js';
import type { ToolClient } from './types.js';

export const MAX_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;

export class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string) {
    // Do not copy server responses, model text or authorization headers into logs.
    super(`Collective service request failed (${status}, ${code})`);
  }
}

export async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('Remote response exceeded size limit');
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class HttpToolClient implements ToolClient {
  private readonly origin: string;
  constructor(origin: string, private readonly token: string, private readonly timeoutMs = 10000, private readonly fetcher: typeof fetch = fetch) {
    this.origin = serviceUrl(origin);
    if (!token || /[\r\n]/u.test(token)) throw new Error('A valid worker token must be supplied through its environment variable');
  }
  async call<T = unknown>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!/^[a-z][a-z0-9_]+$/u.test(name)) throw new Error('Invalid tool name');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(`${this.origin}/api/tools/${name}`, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args)
    });
    const body = await boundedResponse(response, MAX_HTTP_RESPONSE_BYTES);
    if (!response.ok) {
      let code = 'request_failed';
      try { const value = JSON.parse(body) as { error?: { code?: unknown } }; if (typeof value.error?.code === 'string' && /^[a-z0-9_]+$/u.test(value.error.code)) code = value.error.code; } catch { /* Omit arbitrary remote text. */ }
      throw new RemoteError(response.status, code);
    }
    const value = JSON.parse(body) as { result?: T };
    if (!Object.hasOwn(value, 'result')) throw new Error('Collective service returned an invalid envelope');
    return value.result as T;
  }
}
