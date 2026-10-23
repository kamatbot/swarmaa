import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { clampPct, getJson, isObj, isoFromText, num, UsageError, type Ctx, type ProviderResult, type UsageWindow } from './types.js';

const run = promisify(execFile);
const URL_ = 'https://api.anthropic.com/api/oauth/usage';
const SERVICE = 'Claude Code-credentials';

export interface ClaudeCreds { accessToken: string; expiresAt: number; subscriptionType?: string }

/** Parse the credential JSON Claude Code stores (`{claudeAiOauth:{accessToken,expiresAt(ms),subscriptionType}}`). */
export function parseClaudeCreds(text: string): ClaudeCreds | null {
  try {
    const o = (JSON.parse(text) as { claudeAiOauth?: unknown }).claudeAiOauth;
    if (!isObj(o) || typeof o.accessToken !== 'string') return null;
    return { accessToken: o.accessToken, expiresAt: num(o.expiresAt) ?? 0, subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined };
  } catch { return null; }
}

/** Read-only: macOS keychain via `security` (stdout is the secret and is never echoed), then ~/.claude/.credentials.json. Prefers an unexpired source. */
export async function readClaudeCreds(now: Date = new Date()): Promise<ClaudeCreds | null> {
  const found: ClaudeCreds[] = [];
  if (process.platform === 'darwin') {
    try { const c = parseClaudeCreds((await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], { timeout: 10_000 })).stdout); if (c) found.push(c); } catch { /* not in keychain */ }
  }
  try { const c = parseClaudeCreds(await readFile(`${process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude`}/.credentials.json`, 'utf8')); if (c) found.push(c); } catch { /* no file */ }
  return found.find((c) => c.accessToken && c.expiresAt > now.getTime()) ?? found[0] ?? null;
}

const KIND: Record<string, string> = { session: '5h', five_hour: '5h', weekly_all: 'weekly', seven_day: 'weekly', weekly_opus: 'weekly_opus', seven_day_opus: 'weekly_opus', weekly_sonnet: 'weekly_sonnet', seven_day_sonnet: 'weekly_sonnet' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function amount(a: unknown): number | undefined {
  if (!isObj(a)) return undefined;
  const m = num(a.amount_minor);
  return m === undefined ? undefined : m / 10 ** (num(a.exponent) ?? 2);
}

/** Pure: map GET /api/oauth/usage to windows (limits[] preferred, named windows merged in, spend as 'spend'). */
export function parseClaudeUsage(json: unknown, now: Date = new Date()): UsageWindow[] {
  if (!isObj(json)) return [];
  const out = new Map<string, UsageWindow>();
  const add = (name: string, pct: unknown, reset: unknown) => {
    const p = num(pct);
    if (p !== undefined && !out.has(name)) out.set(name, { name, used_percent: clampPct(p), resets_at: isoFromText(reset) });
  };
  if (Array.isArray(json.limits)) {
    for (const l of json.limits) {
      if (!isObj(l) || typeof l.kind !== 'string') continue;
      const model = isObj(l.scope) && isObj(l.scope.model) && typeof l.scope.model.display_name === 'string' ? slug(l.scope.model.display_name) : '';
      add(KIND[l.kind] ?? (l.kind.endsWith('scoped') && model ? `weekly_${model}` : l.kind), l.percent, l.resets_at);
    }
  }
  // Windows that just rolled over vanish from limits[] while the named ones still carry them.
  for (const k of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const w = json[k];
    if (isObj(w)) add(KIND[k]!, w.utilization, w.resets_at);
  }
  // Credit seats: used/limit of the monthly spend; the response says monthly only via extra_usage.monthly_limit.
  const s = json.spend;
  if (isObj(s) && s.enabled !== false) {
    const used = amount(s.used), limit = amount(s.limit);
    if (used !== undefined && limit !== undefined && limit > 0) {
      const monthly = isObj(json.extra_usage) && json.extra_usage.monthly_limit != null;
      add('spend', (used / limit) * 100, monthly ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() : null);
    }
  }
  return [...out.values()];
}

export async function fetchClaude(ctx: Ctx, readCreds: (now: Date) => Promise<ClaudeCreds | null> = readClaudeCreds): Promise<ProviderResult> {
  const creds = await readCreds(ctx.now());
  if (!creds) throw new UsageError('not signed in to Claude Code');
  if (!creds.accessToken) throw new UsageError('signed out; open Claude Code to sign in');
  // Never refresh or run Claude: Claude Code owns this credential.
  if (creds.expiresAt <= ctx.now().getTime()) throw new UsageError('token expired; open Claude Code to renew');
  const json = await getJson(ctx, URL_, { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, 'auth rejected; open Claude Code to renew');
  const windows = parseClaudeUsage(json, ctx.now());
  if (!windows.length) throw new UsageError('no usage limits reported for this account');
  return { windows, plan: creds.subscriptionType };
}
