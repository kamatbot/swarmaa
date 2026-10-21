import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { clampPct, getJson, isObj, isoOrNull, num, UsageError, type Ctx, type ProviderResult, type UsageWindow } from './types.js';

const URL_ = 'https://chatgpt.com/backend-api/wham/usage';

export interface CodexCreds { accessToken: string; accountId: string }

/** exp (seconds) from a JWT payload, if readable. Only a local expiry hint; the server validates the token. */
export function jwtExp(token: string): number | undefined {
  try { return num((JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp); } catch { return undefined; }
}

export function parseCodexAuth(text: string): CodexCreds | null {
  try {
    const t = (JSON.parse(text) as { tokens?: unknown }).tokens;
    if (!isObj(t) || typeof t.access_token !== 'string' || typeof t.account_id !== 'string') return null;
    return t.access_token.trim() && t.account_id.trim() ? { accessToken: t.access_token, accountId: t.account_id } : null;
  } catch { return null; }
}

export async function readCodexCreds(): Promise<CodexCreds | null> {
  try { return parseCodexAuth(await readFile(`${process.env.CODEX_HOME ?? `${homedir()}/.codex`}/auth.json`, 'utf8')); } catch { return null; }
}

/** 18000s -> '5h', 604800 -> 'weekly', 2592000 -> 'monthly'; any other length is named from itself rather than dropped. */
export function windowName(seconds: number | undefined, fallback: string): string {
  if (!seconds || seconds <= 0) return fallback;
  const m = seconds / 60;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const d = Math.round(m / 1440);
  return d === 7 ? 'weekly' : d === 30 ? 'monthly' : `${d}d`;
}

/**
 * Pure: map /wham/usage to windows. Main rate_limit pair only (Spark / code-review extras are separate pools and would
 * distort headroom); credit seats with no rolling windows fall back to spend_control as 'credits'. A window with a null
 * used_percent is skipped without discarding its sibling, as in NotchTrader.
 */
export function parseCodexUsage(json: unknown, now: Date = new Date()): { windows: UsageWindow[]; plan?: string } {
  if (!isObj(json)) return { windows: [] };
  const windows: UsageWindow[] = [];
  const rl = isObj(json.rate_limit) ? json.rate_limit : {};
  for (const [key, fallback] of [['primary_window', 'primary'], ['secondary_window', 'secondary']] as const) {
    const w = rl[key];
    const pct = isObj(w) ? num(w.used_percent) : undefined;
    if (!isObj(w) || pct === undefined) continue;
    const at = num(w.reset_at), after = num(w.reset_after_seconds);
    windows.push({ name: windowName(num(w.limit_window_seconds), fallback), used_percent: clampPct(pct), resets_at: isoOrNull(at !== undefined ? at * 1000 : after !== undefined ? now.getTime() + after * 1000 : null) });
  }
  const credit = isObj(json.spend_control) && isObj(json.spend_control.individual_limit) ? json.spend_control.individual_limit : undefined;
  if (!windows.length && credit && num(credit.used_percent) !== undefined) {
    const at = num(credit.reset_at);
    windows.push({ name: 'credits', used_percent: clampPct(num(credit.used_percent)!), resets_at: isoOrNull(at !== undefined ? at * 1000 : null) });
  }
  return { windows, plan: typeof json.plan_type === 'string' && json.plan_type ? json.plan_type : undefined };
}

export async function fetchCodex(ctx: Ctx, readCreds: () => Promise<CodexCreds | null> = readCodexCreds): Promise<ProviderResult> {
  const creds = await readCreds();
  if (!creds) throw new UsageError('not signed in to Codex');
  const exp = jwtExp(creds.accessToken);
  if (exp !== undefined && exp * 1000 <= ctx.now().getTime()) throw new UsageError('token expired; open Codex to renew');
  const json = await getJson(ctx, URL_, { Authorization: `Bearer ${creds.accessToken}`, 'ChatGPT-Account-Id': creds.accountId, Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' }, 'auth rejected; open Codex to renew');
  const r = parseCodexUsage(json, ctx.now());
  if (!r.windows.length) throw new UsageError('Codex reported no usage windows');
  return r;
}
