export type UsageProviderId = 'claude' | 'codex' | 'antigravity' | 'grok';
export interface UsageWindow { name: string; used_percent: number; resets_at: string | null } // name e.g. '5h', 'weekly', 'weekly_opus', 'credits'; used_percent 0–100 (clamp); resets_at ISO-8601 UTC or null
export interface UsageSnapshot { provider: UsageProviderId; ok: boolean; windows: UsageWindow[]; plan?: string; fetched_at: string; error?: string }

// ---- internals shared by the provider modules (not part of the cross-team contract) ----
export interface Ctx { fetcher: typeof fetch; now: () => Date }
export interface ProviderResult { windows: UsageWindow[]; plan?: string }
export type ProviderFn = (ctx: Ctx) => Promise<ProviderResult>;

/** An error whose message is safe to surface: never contains tokens or response bodies. */
export class UsageError extends Error {
  constructor(message: string, readonly retryAfterSec?: number, readonly rateLimited = false) { super(message); }
}

export const TIMEOUT_MS = 10_000;
export const clampPct = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 100) / 100)) : 0);
export const isoOrNull = (ms: number | null | undefined): string | null => (ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const isoFromText = (s: unknown): string | null => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Seconds from a Retry-After header (delta-seconds or HTTP date), if present. */
export function retryAfter(r: Response, now: Date): number | undefined {
  const h = r.headers.get('retry-after')?.trim();
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now.getTime()) / 1000);
}

/** GET/POST JSON with the shared timeout; maps statuses to safe UsageErrors. The token only goes to `url`; redirects are refused. */
export async function getJson(ctx: Ctx, url: string, headers: Record<string, string>, authMsg: string, init: RequestInit = {}): Promise<unknown> {
  const r = await ctx.fetcher(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 429) throw new UsageError('rate limited', retryAfter(r, ctx.now()), true);
  if (r.status === 401 || r.status === 403) throw new UsageError(authMsg);
  if (!r.ok) throw new UsageError(`HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new UsageError('unreadable response'); }
}

/** A short message for any thrown value — never the raw error text (it may echo URLs or bodies). */
export function safeError(e: unknown): string {
  if (e instanceof UsageError) return e.message;
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'TypeError') return 'network error';
  return 'unexpected error';
}
