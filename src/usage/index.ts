import { fetchAntigravity } from './antigravity.js';
import { fetchClaude } from './claude.js';
import { fetchCodex } from './codex.js';
import { fetchGrok } from './grok.js';
import { safeError, UsageError, type Ctx, type ProviderFn, type UsageProviderId, type UsageSnapshot } from './types.js';

export type { UsageProviderId, UsageSnapshot, UsageWindow } from './types.js';

/** Provider table; exported (underscored) so tests can substitute fetchers without touching the real keychain/network. */
export const _providers: Record<UsageProviderId, ProviderFn> = {
  claude: (c) => fetchClaude(c),
  codex: (c) => fetchCodex(c),
  antigravity: (c) => fetchAntigravity(c),
  grok: (c) => fetchGrok(c),
};

const BASE_BACKOFF_SEC = 60, MAX_BACKOFF_SEC = 30 * 60;
// ponytail: in-memory only; a restarted poller forgets its penalty. Persist if restarts during a 429 window matter.
const backoff = new Map<UsageProviderId, { until: number; strikes: number }>();
export const _resetBackoff = (): void => backoff.clear();

/** Never throws. A failing provider yields ok:false with a short safe error. 429s back off 60s, doubling per consecutive hit, capped at 30 min. */
export async function collectUsage(providers: UsageProviderId[], opts: { fetcher?: typeof fetch; now?: () => Date } = {}): Promise<UsageSnapshot[]> {
  const ctx: Ctx = { fetcher: opts.fetcher ?? fetch, now: opts.now ?? (() => new Date()) };
  return Promise.all(providers.map(async (provider): Promise<UsageSnapshot> => {
    const fetched_at = ctx.now().toISOString();
    const fail = (error: string): UsageSnapshot => ({ provider, ok: false, windows: [], fetched_at, error });
    try {
      const b = backoff.get(provider);
      if (b && ctx.now().getTime() < b.until) return fail(`rate limited; retry in ${Math.ceil((b.until - ctx.now().getTime()) / 1000)}s`);
      const r = await _providers[provider](ctx);
      backoff.delete(provider);
      return { provider, ok: true, windows: r.windows, ...(r.plan ? { plan: r.plan } : {}), fetched_at };
    } catch (e) {
      if (e instanceof UsageError && e.rateLimited) {
        const strikes = (backoff.get(provider)?.strikes ?? 0) + 1;
        // Servers answer Retry-After: 0 (no guidance), so ours is the floor; a larger server hint wins, both capped.
        const sec = Math.min(MAX_BACKOFF_SEC, Math.max(BASE_BACKOFF_SEC * 2 ** (strikes - 1), e.retryAfterSec ?? 0));
        backoff.set(provider, { until: ctx.now().getTime() + sec * 1000, strikes });
      }
      return fail(safeError(e));
    }
  }));
}

/** Percentage points left on the most-used window; 0 when unreadable. */
export function headroom(s: UsageSnapshot): number {
  return !s.ok || !s.windows.length ? 0 : 100 - Math.max(...s.windows.map((w) => w.used_percent));
}
