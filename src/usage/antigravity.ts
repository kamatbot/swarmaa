import { clampPct, isObj, isoFromText, num, UsageError, type Ctx, type ProviderResult, type UsageWindow } from './types.js';

// ---- parser: AntigravityQuotaParser (server reports what is LEFT; we report what is USED) ----
interface Bucket { modelId?: string; bucketId?: string; name?: string; displayName?: string; fraction?: number; used?: number; limit?: number; resetTime?: string; window?: string; disabled?: boolean }
interface Group { displayName?: string; buckets: Bucket[] }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
function bucket(b: unknown): Bucket | null {
  if (!isObj(b)) return null;
  const rem = isObj(b.remaining) ? (num(b.remaining.remainingFraction) ?? (b.remaining.case === 'remainingFraction' ? num(b.remaining.value) : undefined)) : undefined;
  return { modelId: str(b.modelId), bucketId: str(b.bucketId), name: str(b.name), displayName: str(b.displayName), fraction: num(b.remainingFraction) ?? rem, used: num(b.used), limit: num(b.limit), resetTime: str(b.resetTime), window: str(b.window), disabled: b.disabled === true };
}
const buckets = (v: unknown): Bucket[] => (Array.isArray(v) ? v.map(bucket).filter((b): b is Bucket => b !== null) : []);
const groups = (v: unknown): Group[] => (Array.isArray(v) ? v.filter(isObj).map((g) => ({ displayName: str(g.displayName), buckets: buckets(g.buckets) })) : []);

const norm = (s: string) => s.trim().toLowerCase().replace(/_/g, '-');
const groupRank = (n?: string) => { const v = norm(n ?? ''); return v.includes('gemini') ? 0 : v.includes('claude') || v.includes('gpt') ? 1 : 2; };
const cadenceValue = (raw?: string) => { if (!raw) return undefined; const v = norm(raw); return v.endsWith(' limit') ? v.slice(0, -6) : v || undefined; };
const isWeeklyV = (v: string) => v === 'weekly' || v.endsWith('-weekly') || v.endsWith(' weekly');
const isSessionV = (v: string) => ['session', '5h', '5-hour', 'five hour', 'five-hour', 'hourly'].includes(v) || ['-session', '-5h', '-5-hour', '-five-hour', '-hourly'].some((s) => v.endsWith(s));
/** 0 = session/5h, 1 = weekly, 2 = unknown */
function cadence(b: Bucket): number {
  const vs = [b.window, b.bucketId, b.displayName].map(cadenceValue).filter((v): v is string => !!v);
  return vs.some(isWeeklyV) ? 1 : vs.some(isSessionV) ? 0 : 2;
}
const bucketId = (b: Bucket, group?: string) => [b.bucketId, b.modelId, b.name, group].map((v) => v?.trim()).find((v) => !!v) ?? 'quota';
const win = (name: string, usedFrac: number, b: Bucket): UsageWindow => ({ name, used_percent: clampPct(usedFrac * 100), resets_at: isoFromText(b.resetTime) });
const byRank = <T,>(items: T[], rank: (t: T) => number) => items.map((t, i) => [t, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);

function fromBucket(b: Bucket, group?: string): UsageWindow | null {
  if (b.disabled) return null;
  const id = bucketId(b, group);
  if (b.fraction !== undefined && b.fraction >= 0 && b.fraction <= 1) return win(id, 1 - b.fraction, b);
  if (b.limit !== undefined && b.limit > 0 && b.used !== undefined && b.used >= 0 && b.used <= b.limit * 1.5) return win(id, b.used / b.limit, b);
  return null;
}

/** Per-model buckets folded into gemini/3p x hourly/weekly, taking the most-used bucket of each. */
function modelWindows(bs: Bucket[], now: Date): UsageWindow[] {
  const slots: Record<string, { rem: number; reset: string | null }> = {};
  for (const b of bs) {
    if (b.fraction === undefined || b.fraction < 0 || b.fraction > 1) continue;
    const model = norm(bucketId(b));
    if (!model || model.startsWith('chat-')) continue;
    const reset = isoFromText(b.resetTime);
    const weekly = cadence(b) === 1 || (reset !== null && Date.parse(reset) - now.getTime() > 24 * 3600_000);
    const fam = model.includes('gemini') ? 'gemini' : /claude|gpt|openai/.test(model) ? '3p' : null;
    if (!fam) continue;
    const key = `${fam}-${weekly ? 'weekly' : 'hourly'}`;
    if (!slots[key] || b.fraction < slots[key]!.rem) slots[key] = { rem: b.fraction, reset };
  }
  return ['gemini-hourly', 'gemini-weekly', '3p-hourly', '3p-weekly'].filter((k) => slots[k]).map((k) => ({ name: k, used_percent: clampPct((1 - slots[k]!.rem) * 100), resets_at: slots[k]!.reset }));
}

/** Pure: normalise quota envelopes if supplied from an approved public source. */
export function parseAntigravityQuota(json: unknown, now: Date = new Date()): UsageWindow[] {
  if (!isObj(json)) return [];
  const gs = [isObj(json.response) ? json.response.groups : undefined, isObj(json.summary) ? json.summary.groups : undefined, json.groups, json.quotaGroups].map(groups).find((g) => g.length) ?? [];
  const seen = new Set<string>();
  const dedupe = (ws: (UsageWindow | null)[]) => ws.filter((w): w is UsageWindow => !!w && !seen.has(w.name) && !!seen.add(w.name));
  if (gs.length) return dedupe(byRank(gs, (g) => groupRank(g.displayName)).flatMap((g) => byRank(g.buckets, cadence).map((b) => fromBucket(b, g.displayName))));
  const bs = buckets(json.buckets);
  if (!bs.length) return [];
  return bs.some((b) => b.limit !== undefined) ? dedupe(bs.map((b) => (b.limit !== undefined && b.limit > 0 && b.used !== undefined && b.used >= 0 && b.used <= b.limit * 1.5 ? win(bucketId(b), b.used / b.limit, b) : null))) : modelWindows(bs, now);
}

/** Only the quota group `model` draws from (Gemini 4 Argon, Claude/GPT "3p", else the shared Gemini group), named 5h/weekly like
 *  other providers, so headroom, routing and the Mac app never read another group's limit. Unknown shapes pass through unchanged. */
export function windowsForModel(ws: UsageWindow[], model = ''): UsageWindow[] {
  const m = model.toLowerCase();
  const fam = m.includes('argon') ? 'gemini-argon' : /claude|gpt/.test(m) ? '3p' : 'gemini';
  const mine = ws.filter((w) => w.name.startsWith(`${fam}-`) && (fam !== 'gemini' || !w.name.includes('argon')));
  return mine.length ? mine.map((w) => ({ ...w, name: w.name.endsWith('weekly') ? 'weekly' : /(5h|hourly)$/.test(w.name) ? '5h' : w.name })) : ws;
}

/**
 * Antigravity does not expose quota over a documented public CLI/ACP API.
 * Private language_server spawning, process-table CSRF scraping, and undocumented internal RPCs are intentionally prohibited.
 */
export async function fetchAntigravity(_ctx: Ctx): Promise<ProviderResult> {
  throw new UsageError('Antigravity quota is not exposed via a public CLI/ACP API');
}
