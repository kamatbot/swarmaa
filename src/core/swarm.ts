import type { Pool } from 'pg';
import { requireCondition } from '../errors.js';
import type { Principal } from '../types.js';
import { object, optionalString, scopeName, string } from '../validation.js';
import { inboxStatus } from './inbox-status.js';
import { LessonService } from './lessons.js';
import { decideAll, getPolicy, type RoutingPolicy, type UsageRow } from './routing.js';
import { SessionService } from './sessions.js';
import { assertKnownScope, noExtraKeys, scopeSql, type Db } from './shared.js';

/** Capability a submitter uses to let the service route read work to the provider with most quota left. */
export const AUTO_READ = 'auto.read';
/** Same for edit work: the worker runs it in an isolated git worktree and returns a local branch. */
export const AUTO_PATCH = 'auto.patch';
const PROVIDER = /^[a-z][a-z0-9_-]{0,49}$/u;

/** Providers a worker serves, from its advertised `<agent>.read` capabilities. */
export function workerProviders(capabilities: string[]): string[] {
  return capabilities.filter(c => c.endsWith('.read') && c !== AUTO_READ).map(c => c.slice(0, -5));
}

export async function touchWorker(db: Db, p: Principal): Promise<void> {
  await db.query(`UPDATE principals SET last_seen_at=clock_timestamp() WHERE id=$1
    AND (last_seen_at IS NULL OR last_seen_at<clock_timestamp()-interval '10 seconds')`, [p.id]);
}

interface Window { name: string; used_percent: number; resets_at: string | null }
interface UsageView { provider: string; ok: boolean; headroom: number; windows?: Window[]; fetched_at: Date | string }

/** Explains auto.read routing for people and front ends; the claim path applies the same decision per scope. */
export function routing(usage: UsageView[], liveProviders: Set<string>, policy: RoutingPolicy, isDefault: boolean, now = Date.now()) {
  const providers = usage.map(u => ({ provider: u.provider, headroom: u.headroom, live_worker: liveProviders.has(u.provider), windows: u.windows ?? [],
    fresh: now - new Date(u.fetched_at).getTime() < 15 * 60e3, ok: u.ok }));
  const rows: UsageRow[] = providers.map(x => ({ provider: x.provider, ok: x.ok, headroom: x.headroom, windows: x.windows, fresh: x.fresh, live: x.live_worker }));
  const by_kind = decideAll(policy, rows);
  return { recommended: by_kind.review.provider, reason: by_kind.review.reason, policy, is_default: isDefault, by_kind,
    providers: providers.map(({ fresh, ok, ...rest }) => ({ ...rest, ok, fresh })) };
}

function headroom(windows: { used_percent: number }[], ok: boolean): number {
  return ok && windows.length ? Math.max(0, 100 - Math.max(...windows.map(w => w.used_percent))) : 0;
}

export class SwarmService {
  private readonly sessions: SessionService;
  private readonly lessons: LessonService;
  constructor(private readonly pool: Pool) { this.sessions = new SessionService(pool); this.lessons = new LessonService(pool); }

  /** Worker-reported quota readings for the providers it runs. Readings are data, never authority. */
  async report(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['reports', 'slots']);
    requireCondition(input.slots === undefined || (Number.isInteger(input.slots) && (input.slots as number) >= 0 && (input.slots as number) <= 16), 400, 'invalid_arguments', 'slots must be an integer from 0 to 16.');
    requireCondition(p.role === 'worker', 403, 'forbidden', 'Only worker connections report provider usage.');
    requireCondition(Array.isArray(input.reports) && input.reports.length <= 10 && (input.reports.length >= 1 || input.slots !== undefined), 400, 'invalid_arguments', 'reports needs 1–10 entries (or none with slots).');
    const rows = input.reports.map(value => {
      const r = object(value);
      noExtraKeys(r, ['provider', 'ok', 'windows', 'fetched_at', 'plan', 'error']);
      const provider = string(r.provider, 'provider', 50);
      requireCondition(PROVIDER.test(provider), 400, 'invalid_arguments', 'provider must be a lowercase identifier.');
      requireCondition(typeof r.ok === 'boolean', 400, 'invalid_arguments', 'ok must be a boolean.');
      requireCondition(Array.isArray(r.windows) && r.windows.length <= 10, 400, 'invalid_arguments', 'windows needs at most 10 entries.');
      const windows = r.windows.map(w => {
        const win = object(w);
        noExtraKeys(win, ['name', 'used_percent', 'resets_at']);
        const used = win.used_percent;
        requireCondition(typeof used === 'number' && Number.isFinite(used), 400, 'invalid_arguments', 'used_percent must be a number.');
        const resets = win.resets_at === null || win.resets_at === undefined ? null : string(win.resets_at, 'resets_at', 40);
        requireCondition(resets === null || !Number.isNaN(Date.parse(resets)), 400, 'invalid_arguments', 'resets_at must be a date-time.');
        return { name: string(win.name, 'name', 40), used_percent: Math.min(100, Math.max(0, used)), resets_at: resets };
      });
      const fetched = string(r.fetched_at, 'fetched_at', 40);
      requireCondition(!Number.isNaN(Date.parse(fetched)), 400, 'invalid_arguments', 'fetched_at must be a date-time.');
      return { provider, ok: r.ok as boolean, windows, fetched, plan: optionalString(r.plan, 'plan', 80) ?? null, error: optionalString(r.error, 'error', 200) ?? null };
    });
    for (const r of rows) {
      // Clamp future timestamps so a skewed worker clock cannot keep a reading fresh forever.
      await this.pool.query(`INSERT INTO provider_usage (tenant_id,provider,reporter_id,ok,headroom,windows,fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,LEAST($7::timestamptz,clock_timestamp()))
        ON CONFLICT (tenant_id,provider) DO UPDATE SET reporter_id=EXCLUDED.reporter_id,ok=EXCLUDED.ok,headroom=EXCLUDED.headroom,
          windows=EXCLUDED.windows,fetched_at=EXCLUDED.fetched_at,updated_at=clock_timestamp()`,
        [p.tenantId, r.provider, p.id, r.ok, headroom(r.windows, r.ok), JSON.stringify({ windows: r.windows, plan: r.plan, error: r.error }), r.fetched]);
    }
    if (input.slots !== undefined) await this.pool.query('UPDATE principals SET worker_slots=$2 WHERE id=$1', [p.id, input.slots]);
    await touchWorker(this.pool, p);
    return { accepted: rows.length };
  }

  /** One read for dashboards and routing decisions: live workers, provider quota and task counts per scope. */
  async status(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope']);
    let [all, scopes] = scopeSql(p);
    if (input.scope !== undefined) {
      const scope = scopeName(input.scope);
      assertKnownScope(p, scope);
      [all, scopes] = [false, [scope]];
    }
    const [workers, usage, counts, recent, sessions, lessonsPending, policy, inbox] = await Promise.all([
      this.pool.query(`SELECT w.name,w.last_seen_at,coalesce(w.last_seen_at>clock_timestamp()-interval '60 seconds',false) AS live,coalesce(w.worker_slots,1) AS slots,
          (SELECT coalesce(json_agg(json_build_object('task_id',t.id,'scope',t.scope,'kind',t.kind,'objective',left(t.objective,140),'required_capability',t.required_capability,'started_at',coalesce((SELECT r.started_at FROM task_runs r WHERE r.task_id=t.id AND r.generation=t.lease_generation),t.updated_at))),'[]') FROM tasks t
            WHERE t.lease_owner=w.id AND t.status='running' AND ($2::boolean OR t.scope=ANY($3::text[]))) AS running,
          (SELECT coalesce(json_agg(u.provider ORDER BY u.provider),'[]') FROM provider_usage u WHERE u.reporter_id=w.id) AS providers
        FROM principals w WHERE w.tenant_id=$1 AND w.role='worker' AND NOT w.disabled AND ($2::boolean OR w.scopes && $3::text[])
        ORDER BY w.name`, [p.tenantId, all, scopes]),
      this.pool.query(`SELECT provider,ok,headroom::float AS headroom,windows,fetched_at FROM provider_usage WHERE tenant_id=$1 ORDER BY headroom DESC,provider`, [p.tenantId]),
      this.pool.query(`SELECT scope,
          count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='running')::int AS running,
          count(*) FILTER (WHERE status='blocked')::int AS blocked,
          count(*) FILTER (WHERE status='completed' AND updated_at>now()-interval '24 hours')::int AS completed_24h,
          count(*) FILTER (WHERE status='failed' AND updated_at>now()-interval '24 hours')::int AS failed_24h
        FROM tasks WHERE tenant_id=$1 AND ($2::boolean OR scope=ANY($3::text[])) GROUP BY scope ORDER BY scope`, [p.tenantId, all, scopes]),
      this.pool.query(`SELECT t.id,t.scope,t.kind,t.status,t.version,left(t.objective,140) AS objective,t.required_capability,t.updated_at,w.name AS worker,
          t.result->>'provider' AS provider,t.result->>'branch' AS branch,(CASE WHEN jsonb_typeof(t.result->'changed_files')='number' THEN (t.result->>'changed_files')::int END) AS changed_files
        FROM tasks t LEFT JOIN principals w ON w.id=t.lease_owner
        WHERE t.tenant_id=$1 AND ($2::boolean OR t.scope=ANY($3::text[])) ORDER BY t.updated_at DESC LIMIT 15`, [p.tenantId, all, scopes]),
      this.sessions.active(p, all, scopes),
      this.lessons.pending(p, all, scopes),
      getPolicy(this.pool, p.tenantId),
      inboxStatus(this.pool,p,all,scopes),
    ]);
    const usageView: UsageView[] = usage.rows.map(r => ({ provider: r.provider, ok: r.ok, headroom: r.headroom, ...r.windows, fetched_at: r.fetched_at }));
    const live = new Set<string>(workers.rows.filter(w => w.live && w.slots > 0).flatMap(w => w.providers as string[]));
    // List every permitted project, not just those with tasks, so a client can see what it can work in.
    const zero = { queued: 0, running: 0, blocked: 0, completed_24h: 0, failed_24h: 0 };
    const byScope = new Map<string, Record<string, unknown>>(counts.rows.map(r => [r.scope as string, r]));
    if (!all) for (const scope of scopes) if (!byScope.has(scope)) byScope.set(scope, { scope, ...zero });
    return {
      workers: workers.rows.map(w => ({ ...w, free_slots: w.live ? Math.max(0, w.slots - (w.running as unknown[]).length) : 0 })), usage: usageView, routing: routing(usageView, live, policy.policy, policy.is_default), sessions,
      scopes: [...byScope.values()].sort((a, b) => String(a.scope).localeCompare(String(b.scope))),
      recent: recent.rows, inbox, lessons_pending: lessonsPending, generated_at: new Date().toISOString(),
    };
  }
}
