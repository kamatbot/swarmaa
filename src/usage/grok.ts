import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { clampPct, getJson, isObj, isoFromText, num, UsageError, type Ctx, type ProviderResult, type UsageWindow } from './types.js';

const URL_ = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const ISSUER = 'https://auth.x.ai';

export interface GrokCreds { accessToken: string; expiresAt: number | null }

/** Only a session minted by xAI itself: the issuer is the part before `::`, compared whole (never a prefix match). */
function trusted(key: string, e: Record<string, unknown>): boolean {
  return key.split('::')[0] === ISSUER || e.oidc_issuer === ISSUER;
}

/** Pure: pick the credential from ~/.grok/auth.json (keyed `issuer::client_id`); a still-live trusted entry wins, else the first trusted one. */
export function parseGrokAuth(text: string): GrokCreds | null {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return null; }
  if (!isObj(root)) return null;
  const entries = Object.entries(root).filter((kv): kv is [string, Record<string, unknown>] => isObj(kv[1]) && trusted(kv[0], kv[1]));
  const exp = (e: Record<string, unknown>) => { const t = isoFromText(e.expires_at); return t ? Date.parse(t) : null; };
  const pick = entries.find(([, e]) => { const x = exp(e); return x === null || x > Date.now(); }) ?? entries[0];
  const token = pick?.[1].key;
  return pick && typeof token === 'string' && token ? { accessToken: token, expiresAt: exp(pick[1]) } : null;
}

export async function readGrokCreds(): Promise<GrokCreds | null> {
  try { return parseGrokAuth(await readFile(`${homedir()}/.grok/auth.json`, 'utf8')); } catch { return null; }
}

const pct = (v: unknown) => num(v);
const humanize = (s: string) => s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();

/** Pure: GET /v1/billing?format=credits -> windows. creditUsagePercent is the ring ('credits'); else productUsage; else a fresh weekly pool at 0%. */
export function parseGrokCredits(json: unknown): UsageWindow[] {
  const c = isObj(json) && isObj(json.config) ? json.config : null;
  if (!c) return [];
  const period = isObj(c.currentPeriod) ? c.currentPeriod : undefined;
  const reset = isoFromText(period?.end) ?? isoFromText(c.billingPeriodEnd);
  const out: UsageWindow[] = [];
  if (pct(c.creditUsagePercent) !== undefined) out.push({ name: 'credits', used_percent: clampPct(pct(c.creditUsagePercent)!), resets_at: reset });
  else if (Array.isArray(c.productUsage)) {
    for (const p of c.productUsage) {
      if (!isObj(p) || pct(p.usagePercent) === undefined) continue;
      out.push({ name: out.length ? humanize(String(p.product ?? 'usage')) : 'credits', used_percent: clampPct(pct(p.usagePercent)!), resets_at: reset });
    }
  }
  // A weekly pool states its window in currentPeriod and omits the percent until usage lands: that is 0%, not absent.
  if (!out.length && typeof period?.type === 'string' && period.type.includes('WEEKLY')) out.push({ name: 'credits', used_percent: 0, resets_at: reset });
  return out;
}

export async function fetchGrok(ctx: Ctx, readCreds: () => Promise<GrokCreds | null> = readGrokCreds): Promise<ProviderResult> {
  const creds = await readCreds();
  if (!creds) throw new UsageError('not signed in to Grok');
  // Not renewed here: the refresh token belongs to the Grok CLI.
  if (creds.expiresAt !== null && creds.expiresAt <= ctx.now().getTime()) throw new UsageError('token expired; run grok login');
  const json = await getJson(ctx, URL_, { Authorization: `Bearer ${creds.accessToken}`, 'X-XAI-Token-Auth': 'xai-grok-cli', Accept: 'application/json' }, 'auth rejected; run grok login');
  const windows = parseGrokCredits(json);
  if (!windows.length) throw new UsageError('nothing metered on this account yet');
  return { windows };
}
