export const FAILURE_CODES = [
  'quota_exhausted',
  'rate_limited',
  'auth_required',
  'provider_error',
  'harness_error',
  'timeout',
  'sandbox_denied',
  'cancelled',
] as const;

export type StandardFailureCode = typeof FAILURE_CODES[number];
export type FailureCode = StandardFailureCode | `swarmaa_${string}`;

export interface FailureInfo {
  code: FailureCode;
  retry: boolean;
  detail: string;
  retry_after_ms?: number;
}

export interface ServedStamp {
  provider: string;
  model: string | null;
  substituted?: boolean;
}

const VERSION_SUFFIX_RE = /^(-(\d{2,}|v\d+|preview|latest))+$/;

/**
 * Whether a served model id names the model asked for.
 * Drops vendor prefix (anthropic/claude-fable-5 is claude-fable-5) and provider dated/versioned suffix
 * (claude-haiku-4-5-20251001, gemini-3.5-flash-001). A different family, number, or tier word
 * (such as -lite) is another model. Verbatim rule from HarnessRouter's samemodel.py.
 */
export function sameModel(asked: string, served: string): boolean {
  const norm = (m: string) => (m || '').trim().toLowerCase().split('/').pop()!.replace(/\./g, '-');
  const a = norm(asked);
  const s = norm(served);
  if (!a || !s) return false;
  if (a === s) return true;
  if (s === 'deepseek-flash' && a === 'deepseek-v4-1-flash') return true;
  const [long, short] = s.length > a.length ? [s, a] : [a, s];
  return long.startsWith(short + '-') && VERSION_SUFFIX_RE.test(long.slice(short.length));
}

/** Whether a failure code is retryable according to the closed failure code table. */
export function isRetryableCode(code: FailureCode): boolean {
  return code === 'rate_limited' || code === 'provider_error';
}
