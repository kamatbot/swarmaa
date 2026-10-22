import { AppError } from '../errors.js';
import type { Principal } from '../types.js';
import { audit, type Db } from './shared.js';

export const ROUTING_PROVIDERS = ['claude', 'codex', 'antigravity'] as const;
export const ROUTING_KINDS = ['review', 'research', 'patch'] as const;
export type RoutingProvider = typeof ROUTING_PROVIDERS[number];
export type RoutingKind = typeof ROUTING_KINDS[number];
export interface ProviderPolicy { provider: RoutingProvider; enabled: boolean; max_five_hour_pct: number; max_weekly_pct: number; kinds: RoutingKind[] }
export interface RoutingPolicy { providers: ProviderPolicy[]; fallback: 'most_headroom' | 'none' }

export const DEFAULT_POLICY: RoutingPolicy = {
  providers: [
    { provider: 'claude', enabled: true, max_five_hour_pct: 90, max_weekly_pct: 90, kinds: ['review', 'research', 'patch'] },
    { provider: 'codex', enabled: true, max_five_hour_pct: 95, max_weekly_pct: 95, kinds: ['review', 'research', 'patch'] },
    // Antigravity cannot reach outside the project, so it takes reviews and in-project edits, not research.
    { provider: 'antigravity', enabled: true, max_five_hour_pct: 95, max_weekly_pct: 95, kinds: ['review', 'patch'] },
  ],
  fallback: 'most_headroom',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict validation; every problem is listed so a client can fix them all at once. */
export function validatePolicy(input: unknown): RoutingPolicy {
  const problems: string[] = [];
  const out: ProviderPolicy[] = [];
  let fallback: RoutingPolicy['fallback'] = 'most_headroom';
  if (!isObject(input)) problems.push('policy must be an object.');
  else {
    for (const k of Object.keys(input)) if (k !== 'providers' && k !== 'fallback') problems.push(`policy.${k} is not allowed.`);
    if (input.fallback === 'most_headroom' || input.fallback === 'none') fallback = input.fallback;
    else problems.push('fallback must be "most_headroom" or "none".');
    if (!Array.isArray(input.providers)) problems.push('providers must be an array.');
    else {
      const seen = new Set<string>();
      input.providers.forEach((v, i) => {
        const at = `providers[${i}]`;
        if (!isObject(v)) { problems.push(`${at} must be an object.`); return; }
        for (const k of Object.keys(v)) if (!['provider', 'enabled', 'max_five_hour_pct', 'max_weekly_pct', 'kinds'].includes(k)) problems.push(`${at}.${k} is not allowed.`);
        const provider = v.provider as RoutingProvider;
        if (!(ROUTING_PROVIDERS as readonly unknown[]).includes(provider)) problems.push(`${at}.provider must be one of ${ROUTING_PROVIDERS.join(', ')}.`);
        else if (seen.has(provider)) problems.push(`${at}.provider ${provider} is listed twice.`);
        else seen.add(provider);
        if (typeof v.enabled !== 'boolean') problems.push(`${at}.enabled must be a boolean.`);
        for (const key of ['max_five_hour_pct', 'max_weekly_pct'] as const) {
          const n = v[key];
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100) problems.push(`${at}.${key} must be an integer from 1 to 100.`);
        }
        const kinds = v.kinds;
        if (!Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || !kinds.every(k => (ROUTING_KINDS as readonly unknown[]).includes(k))) {
          problems.push(`${at}.kinds must be a non-empty list of distinct values from ${ROUTING_KINDS.join(', ')}.`);
        }
        out.push(v as unknown as ProviderPolicy);
      });
      for (const p of ROUTING_PROVIDERS) if (!seen.has(p)) problems.push(`providers must include ${p}.`);
    }
  }
  if (!problems.length) {
    for (const kind of ROUTING_KINDS) {
      if (!out.some(p => p.enabled && p.kinds.includes(kind))) problems.push(`At least one enabled provider must allow ${kind} tasks.`);
    }
  }
  if (problems.length) throw new AppError(400, 'invalid_policy', `Invalid routing policy: ${problems.join(' ')}`, { problems });
  return { providers: out.map(p => ({ provider: p.provider, enabled: p.enabled, max_five_hour_pct: p.max_five_hour_pct, max_weekly_pct: p.max_weekly_pct, kinds: [...p.kinds] })), fallback };
}

export async function getPolicy(db: Db, tenantId: string): Promise<{ policy: RoutingPolicy; is_default: boolean; updated_at: string | null; default_policy: RoutingPolicy }> {
  const r = await db.query<{ policy: RoutingPolicy; updated_at: Date }>('SELECT policy,updated_at FROM routing_policies WHERE tenant_id=$1', [tenantId]);
  const row = r.rows[0];
  return row ? { policy: row.policy, is_default: false, updated_at: row.updated_at.toISOString(), default_policy: DEFAULT_POLICY } : { policy: DEFAULT_POLICY, is_default: true, updated_at: null, default_policy: DEFAULT_POLICY };
}

export async function setPolicy(db: Db, p: Principal, input: unknown): Promise<{ policy: RoutingPolicy; updated_at: string }> {
  const policy = validatePolicy(input);
  const r = await db.query<{ updated_at: Date }>(`INSERT INTO routing_policies (tenant_id,policy,updated_by) VALUES ($1,$2::jsonb,$3)
    ON CONFLICT (tenant_id) DO UPDATE SET policy=EXCLUDED.policy,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
    RETURNING updated_at`, [p.tenantId, JSON.stringify(policy), p.id]);
  await audit(db, p, '', 'routing.set', p.tenantId, { policy });
  return { policy, updated_at: r.rows[0]!.updated_at.toISOString() };
}

export interface UsageRow { provider: string; ok: boolean; headroom: number; windows: { name: string; used_percent: number }[]; fresh: boolean; live: boolean }
export interface Decision { provider: string | null; /** True when no usable readings exist, so any enabled+allowed worker may claim. */ anyone: boolean; reason: string }

/** Whether a provider may run this kind. Providers outside the policy (for example demo) are not governed by it. */
export function policyAllows(policy: RoutingPolicy, provider: string, kind: string): boolean {
  const p = policy.providers.find(x => x.provider === provider);
  return !p || (p.enabled && (p.kinds as string[]).includes(kind));
}

const gauge = (windows: UsageRow['windows'], name: string): number => {
  const hit = windows.find(w => w.name.toLowerCase() === name);
  return hit ? hit.used_percent : Math.max(...windows.map(w => w.used_percent));
};
const label = (u: UsageRow) => `5-hour ${Math.round(gauge(u.windows, '5h'))}%, weekly ${Math.round(gauge(u.windows, 'weekly'))}%`;

/** Pure routing decision for one task kind. The claim path and swarm_status both use it. */
export function decide(policy: RoutingPolicy, kind: RoutingKind, usage: UsageRow[]): Decision {
  const candidates = policy.providers.filter(p => p.enabled && p.kinds.includes(kind));
  const usable = (provider: string) => usage.find(u => u.provider === provider && u.ok && u.fresh && u.live && u.windows.length > 0);
  const notes: string[] = [];
  for (const c of candidates) {
    const u = usable(c.provider);
    if (!u) { notes.push(`${c.provider}: no live fresh quota reading`); continue; }
    const five = gauge(u.windows, '5h'), week = gauge(u.windows, 'weekly');
    if (five >= c.max_five_hour_pct) { notes.push(`${c.provider}: 5-hour window at ${Math.round(five)}% ≥ ${c.max_five_hour_pct}% limit`); continue; }
    if (week >= c.max_weekly_pct) { notes.push(`${c.provider}: weekly window at ${Math.round(week)}% ≥ ${c.max_weekly_pct}% limit`); continue; }
    return { provider: c.provider, anyone: false, reason: `${notes.length ? `${notes.join('; ')} → ` : ''}${c.provider} (${label(u)})` };
  }
  const live = candidates.map(c => usable(c.provider)).filter((u): u is UsageRow => !!u);
  if (!live.length) return { provider: null, anyone: true, reason: `No fresh quota reading from a live ${kind} worker; any enabled worker that allows ${kind} may take auto work.` };
  if (policy.fallback === 'none') return { provider: null, anyone: false, reason: `${notes.join('; ')}; fallback is none, so auto ${kind} tasks wait.` };
  // Ties keep policy order because sort is stable and candidates are in priority order.
  const best = live.slice().sort((a, b) => b.headroom - a.headroom)[0]!;
  return { provider: best.provider, anyone: false, reason: `${notes.join('; ')} → ${best.provider} by most headroom (${label(best)})` };
}

export function decideAll(policy: RoutingPolicy, usage: UsageRow[]): Record<RoutingKind, Decision> {
  return { review: decide(policy, 'review', usage), research: decide(policy, 'research', usage), patch: decide(policy, 'patch', usage) };
}

/** Usage rows for one scope: a reading counts as live only when its reporter is a live worker serving the scope. */
export async function scopeUsage(db: Db, tenantId: string, scope: string): Promise<UsageRow[]> {
  const r = await db.query<{ provider: string; ok: boolean; headroom: number; windows: { windows?: UsageRow['windows'] } }>(`SELECT u.provider,u.ok,u.headroom::float AS headroom,u.windows,
      (u.fetched_at>clock_timestamp()-interval '15 minutes') AS fresh,
      (NOT w.disabled AND w.last_seen_at>clock_timestamp()-interval '60 seconds' AND $2=ANY(w.scopes)) AS live
    FROM provider_usage u JOIN principals w ON w.id=u.reporter_id WHERE u.tenant_id=$1`, [tenantId, scope]);
  return r.rows.map((x: any) => ({ provider: x.provider, ok: x.ok, headroom: x.headroom, windows: x.windows?.windows ?? [], fresh: x.fresh, live: x.live }));
}
