import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { inboxStatus } from './core/inbox-status.js';
import { transaction } from './db.js';
import { AppError, requireCondition } from './errors.js';
import { narrowGrant } from './oauth.js';
import { canAccessScope, hasPermission, requirePermission, requireScope } from './policy.js';
import type { AuthBackend, EventBackend, Principal, ServerConfig } from './types.js';
import { enumValue, integer, object, scopeName, string } from './validation.js';
import { callbackUrl, createWebhookSender, decodeWebhookSecret, SecretBox, signedHeaders, type WebhookSender } from './webhook.js';

const EVENT_NAMES = ['task.updated', 'memory.changed'] as const;
type EventName = typeof EVENT_NAMES[number];
const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const MAX_TTL = 7 * DEFAULT_TTL;
const MAX_ATTEMPTS = 8;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_PER_HOST = 2;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

interface SubscriptionRow {
  id: string; principal_id: string; oauth_grant_id: string | null; credential_version: number; revision: number; tenant_id: string; scope: string; name: EventName;
  mode: 'mcp' | 'generic'; callback_url: string; secret_ciphertext: string;
  previous_secret_ciphertext: string | null; previous_secret_until: Date | null;
  verified_until: Date; starts_at: Date; expires_at: Date; active: boolean; last_seq: string;
}
interface DeliveryRow {
  subscription_id: string; event_id: string; attempts: number; lock_token: string; callback_url?: string;
}

export interface EventServiceOptions {
  maxConcurrent?: number;
  maxPerHost?: number;
}

export function subscriptionId(principal: Principal, mode: string, url: string, name: string, scope: string): string {
  // Arguments have one recognized key; canonical construction avoids input key-order ambiguity.
  return `sub_${createHash('sha256').update(JSON.stringify([principal.tenantId, principal.id, mode, url, name, { scope }])).digest('hex')}`;
}

function allowsEvent(principal: Principal, name: EventName): boolean {
  return hasPermission(principal, 'events:read') && hasPermission(principal, name === 'task.updated' ? 'task:read' : 'memory:read');
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  requireCondition(Object.keys(value).every(key => allowed.includes(key)), 400, 'invalid_arguments', 'The request contains an unsupported field.');
}

export class EventService implements EventBackend {
  private readonly box: SecretBox;
  private readonly send: WebhookSender;
  private readonly maxConcurrent: number;
  private readonly maxPerHost: number;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly inFlightByHost = new Map<string, number>();

  constructor(private readonly pool: Pool, private readonly auth: AuthBackend, private readonly config: ServerConfig, sender?: WebhookSender, options?: EventServiceOptions) {
    this.box = new SecretBox(config.eventEncryptionKey);
    this.send = sender ?? createWebhookSender(config.eventCallbackHosts);
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.maxPerHost = Math.max(1, options?.maxPerHost ?? DEFAULT_MAX_PER_HOST);
  }

  async handle(principal: Principal, method: string, raw: unknown): Promise<unknown> {
    requirePermission(principal, 'events:read');
    if (method === 'events/list') {
      return { events: EVENT_NAMES.filter(name => allowsEvent(principal, name)).map(name => ({
        name,
        description: name === 'task.updated' ? 'A task changed within this project. Read the task to reconcile its current state.' : 'Shared memory changed within this project. Read the record to get its current revision.',
        delivery: ['webhook'],
        inputSchema: { type: 'object', properties: { scope: { type: 'string', description: 'An exact scope granted to this connection.' } }, required: ['scope'], additionalProperties: false },
        payloadSchema: { type: 'object', properties: { scope: { type: 'string' }, subject_id: { type: 'string' }, change: { type: 'object', additionalProperties: true } }, required: ['scope', 'subject_id', 'change'], additionalProperties: false },
      })) };
    }
    requireCondition(method === 'events/subscribe' || method === 'events/unsubscribe', 404, 'method_not_found', 'Unknown event method.');
    const params = object(raw ?? {});
    exactKeys(params, ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', '_meta']);
    const name = enumValue(params.name, 'name', EVENT_NAMES);
    requireCondition(allowsEvent(principal, name), 403, 'forbidden', 'This connection cannot monitor this event.');
    const args = object(params.arguments);
    exactKeys(args, ['scope']);
    const scope = scopeName(args.scope);
    requireScope(principal, scope);
    const delivery = object(params.delivery);
    exactKeys(delivery, ['mode', 'url', 'secret']);
    requireCondition(delivery.mode === 'webhook', 400, 'invalid_delivery', 'Only webhook delivery is supported.');
    const url = callbackUrl(string(delivery.url, 'delivery.url', 2048), this.config.eventCallbackHosts).href;
    const id = subscriptionId(principal, 'mcp', url, name, scope);
    if (method === 'events/unsubscribe') {
      await transaction(this.pool, async client => {
        await client.query('UPDATE event_subscriptions SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND principal_id=$2', [id, principal.id]);
        await client.query("UPDATE event_deliveries SET state='skipped',lock_token=NULL,locked_until=NULL,updated_at=clock_timestamp() WHERE subscription_id=$1 AND state IN ('pending','sending')", [id]);
      });
      return {};
    }
    requireCondition(params.cursor === undefined || params.cursor === null, 400, 'replay_not_supported', 'These event types do not support replay. Reconcile records through read tools.');
    const secret = string(delivery.secret, 'delivery.secret', 100);
    decodeWebhookSecret(secret);
    const requestedTtl = params.ttlMs === null || params.ttlMs === undefined ? DEFAULT_TTL : integer(params.ttlMs, 'ttlMs', 1000, Number.MAX_SAFE_INTEGER);
    const ttl = Math.min(requestedTtl, MAX_TTL);
    const verifiedUntil = await this.verify(principal, id, url, secret);
    const expires = await this.saveSubscription(principal, { id, scope, name, url, mode: 'mcp', secret, ttl, verifiedUntil });
    return { id, refreshBefore: expires.toISOString(), cursor: null, truncated: false };
  }

  private async verify(principal: Principal, id: string, url: string, secret: string): Promise<Date> {
    const cached = await this.pool.query<SubscriptionRow>(
      "SELECT * FROM event_subscriptions WHERE principal_id=$1 AND callback_url=$2 AND mode='mcp' AND active AND verified_until>clock_timestamp() LIMIT 32", [principal.id, url]);
    const cachedMatch = cached.rows.find(row => {
      try { return this.box.decrypt(row.secret_ciphertext, row.id) === secret; } catch { return false; }
    });
    if (cachedMatch) return cachedMatch.verified_until;
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const verificationId = `verify_${randomUUID()}`;
    try {
      const response = await this.send(url, body, signedHeaders(secret, id, verificationId, body));
      const parsed = JSON.parse(response.body) as { challenge?: unknown };
      const received = typeof parsed?.challenge === 'string' ? Buffer.from(parsed.challenge) : Buffer.alloc(0);
      const expected = Buffer.from(challenge);
      if (response.status < 200 || response.status >= 300 || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('Challenge mismatch.');
      const expiry = await this.pool.query<{ expires: Date }>("SELECT clock_timestamp()+interval '5 minutes' AS expires");
      return expiry.rows[0].expires;
    } catch (error) {
      const reason = error instanceof AppError && error.code === 'callback_timeout' ? 'timeout' : 'challenge_failed';
      throw new AppError(502, 'callback_verification_failed', 'The callback endpoint could not be verified.', { rpcCode: -32015, reason });
    }
  }

  private async saveSubscription(principal: Principal, input: { id: string; scope: string; name: EventName; url: string; mode: 'mcp' | 'generic'; secret: string; ttl: number; verifiedUntil: Date }): Promise<Date> {
    return transaction(this.pool, async client => {
      // Lock owner to serialize quota checks and refreshes. Recheck grants after network verification.
      const owner = await client.query('SELECT disabled,scopes,permissions,role,credential_version FROM principals WHERE id=$1 FOR UPDATE', [principal.id]);
      const row = owner.rows[0];
      requireCondition(row && !row.disabled, 403, 'revoked', 'This connection has been revoked.');
      requireCondition(principal.credentialVersion === row.credential_version, 403, 'revoked', 'This connection credential has been rotated.');
      const fresh: Principal = { ...principal, role: row.role, scopes: row.scopes, permissions: row.permissions, credentialVersion: row.credential_version };
      requireScope(fresh, input.scope);
      requireCondition(allowsEvent(fresh, input.name), 403, 'forbidden', 'Event access was revoked.');
      if (principal.oauthGrantId) {
        const grant = await client.query('SELECT grant_snapshot FROM oauth_grants WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE', [principal.oauthGrantId, principal.id]);
        const snapshot = grant.rows[0]?.grant_snapshot as Principal | undefined;
        const granted = snapshot ? narrowGrant(snapshot, fresh) : null;
        requireCondition(granted && canAccessScope(granted, input.scope) && allowsEvent(granted, input.name), 403, 'revoked', 'The authorizing OAuth grant is no longer valid.');
      }
      const existing = await client.query<SubscriptionRow & { live: boolean; previous_secret_live: boolean }>('SELECT *,active AND expires_at>clock_timestamp() AS live,previous_secret_until>clock_timestamp() AS previous_secret_live FROM event_subscriptions WHERE id=$1 FOR UPDATE', [input.id]);
      const previous = existing.rows[0];
      const count = await client.query('SELECT count(*)::int AS count FROM event_subscriptions WHERE principal_id=$1 AND active AND expires_at>clock_timestamp()', [principal.id]);
      requireCondition(previous?.live || count.rows[0].count < 32, 429, 'subscription_limit', 'This connection has reached its active subscription limit.');
      const cipher = this.box.encrypt(input.secret, input.id);
      let oldCipher: string | null = null;
      let oldUntil: Date | null = null;
      if (previous && input.mode === 'mcp') {
        if (this.box.decrypt(previous.secret_ciphertext, input.id) !== input.secret) {
          oldCipher = previous.secret_ciphertext;
          const clock = await client.query<{ expires: Date }>("SELECT clock_timestamp()+interval '5 minutes' AS expires");
          oldUntil = clock.rows[0].expires;
        } else if (previous.previous_secret_live) {
          oldCipher = previous.previous_secret_ciphertext;
          oldUntil = previous.previous_secret_until;
        }
      }
      const saved = await client.query<{ expires_at: Date }>(
        `INSERT INTO event_subscriptions(id,principal_id,tenant_id,scope,name,mode,callback_url,secret_ciphertext,previous_secret_ciphertext,previous_secret_until,verified_until,expires_at,oauth_grant_id,credential_version,last_seq)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$13,$12,clock_timestamp()+($10::bigint*interval '1 millisecond'),$11,$14,
           COALESCE((SELECT max(seq) FROM events WHERE tenant_id=$3 AND scope=$4 AND name=$5 AND created_at<clock_timestamp()), 0))
         ON CONFLICT(id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,
           previous_secret_ciphertext=EXCLUDED.previous_secret_ciphertext,previous_secret_until=EXCLUDED.previous_secret_until,
           verified_until=EXCLUDED.verified_until,expires_at=EXCLUDED.expires_at,oauth_grant_id=EXCLUDED.oauth_grant_id,credential_version=EXCLUDED.credential_version,
           revision=event_subscriptions.revision+1,active=true,updated_at=clock_timestamp(),
           starts_at=CASE WHEN event_subscriptions.active AND event_subscriptions.expires_at>clock_timestamp() THEN event_subscriptions.starts_at ELSE clock_timestamp() END,
           last_seq=CASE WHEN event_subscriptions.active AND event_subscriptions.expires_at>clock_timestamp() THEN event_subscriptions.last_seq ELSE EXCLUDED.last_seq END
         RETURNING expires_at`, [input.id, principal.id, principal.tenantId, input.scope, input.name, input.mode, input.url, cipher, oldCipher, input.ttl, principal.oauthGrantId ?? null, input.verifiedUntil, oldUntil, row.credential_version]);
      if (previous && !previous.live) {
        await client.query("UPDATE event_deliveries SET state='skipped',lock_token=NULL,locked_until=NULL WHERE subscription_id=$1 AND state IN ('pending','sending')", [input.id]);
      }
      await client.query('INSERT INTO audit_log(id,tenant_id,actor_id,scope,operation,subject_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [randomUUID(), principal.tenantId, principal.id, input.scope, 'events.subscribe', input.id, JSON.stringify({ name: input.name, mode: input.mode })]);
      return saved.rows[0].expires_at;
    });
  }

  /** Owner-side CLI only. HTTP/MCP cannot register arbitrary authentication headers. */
  async registerGeneric(principal: Principal, raw: { scope: string; name: string; url: string; headers: Record<string, string>; ttlDays?: number }): Promise<{ id: string; expires_at: string }> {
    const scope = scopeName(raw.scope);
    requireScope(principal, scope);
    const name = enumValue(raw.name, 'name', EVENT_NAMES);
    requireCondition(principal.role !== 'admin' && allowsEvent(principal, name), 403, 'forbidden', 'A scoped non-admin connection must own the callback.');
    const url = callbackUrl(raw.url, this.config.eventCallbackHosts).href;
    const headers = object(raw.headers);
    requireCondition(Object.keys(headers).length <= 4, 400, 'invalid_headers', 'At most four receiver headers are permitted.');
    for (const [key, value] of Object.entries(headers)) {
      requireCondition(/^(authorization|x-[a-z0-9-]+)$/i.test(key) && !/^x-(forwarded-|mcp-|collective-)/i.test(key), 400, 'invalid_headers', 'Receiver headers must be Authorization or a custom X- header.');
      requireCondition(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\u0000]/.test(value), 400, 'invalid_headers', 'Receiver header values must be bounded single-line strings.');
    }
    const id = subscriptionId(principal, 'generic', url, name, scope);
    const days = raw.ttlDays === undefined ? 7 : integer(raw.ttlDays, 'ttlDays', 1, 30);
    const expires = await this.saveSubscription(principal, { id, scope, name, url, mode: 'generic', secret: JSON.stringify(headers), ttl: days * DEFAULT_TTL, verifiedUntil: new Date(Date.now() + 5 * 60 * 1000) });
    return { id, expires_at: expires.toISOString() };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(1000);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running || this.activeRun) return;
      this.activeRun = this.tick()
        .catch(() => { process.stderr.write('Event delivery cycle failed; retrying.\n'); })
        .finally(() => {
          this.activeRun = undefined;
          if (this.running) this.schedule(1000);
        });
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.activeRun;
    await Promise.allSettled([...this.inFlight]);
  }

  private async tick(): Promise<void> {
    await this.pool.query(
      `WITH batch AS (
         SELECT s.id AS subscription_id, e.id AS event_id, e.seq
         FROM event_subscriptions s
         JOIN LATERAL (
           SELECT e.id, e.seq FROM events e
           WHERE e.tenant_id = s.tenant_id AND e.scope = s.scope AND e.name = s.name
             AND e.seq > s.last_seq AND e.created_at >= s.starts_at
           ORDER BY e.seq LIMIT 200
         ) e ON true
         WHERE s.active AND s.expires_at > clock_timestamp()
       ),
       inserted AS (
         INSERT INTO event_deliveries(subscription_id, event_id)
         SELECT subscription_id, event_id FROM batch
         ON CONFLICT DO NOTHING
       )
       UPDATE event_subscriptions s
       SET last_seq = GREATEST(s.last_seq, sub.max_seq), updated_at = clock_timestamp()
       FROM (SELECT subscription_id, max(seq) AS max_seq FROM batch GROUP BY subscription_id) sub
       WHERE s.id = sub.subscription_id`);
    await this.pool.query("UPDATE event_deliveries SET state='failed',lock_token=NULL,locked_until=NULL,last_error_code='attempt_limit' WHERE attempts >= $1 AND (state='pending' OR (state='sending' AND locked_until<clock_timestamp()))", [MAX_ATTEMPTS]);
    await this.dispatchAvailable();
  }

  private saturatedHosts(): string[] {
    const hosts: string[] = [];
    for (const [host, count] of this.inFlightByHost) if (count >= this.maxPerHost) hosts.push(host);
    return hosts;
  }

  private async dispatchAvailable(): Promise<void> {
    while (this.running && this.inFlight.size < this.maxConcurrent) {
      const delivery = await this.claim(this.saturatedHosts());
      if (!delivery) break;
      const host = new URL(delivery.callback_url!).hostname.toLowerCase();
      this.inFlightByHost.set(host, (this.inFlightByHost.get(host) ?? 0) + 1);
      const task = this.deliver(delivery)
        .catch(() => { process.stderr.write('Event delivery failed.\n'); })
        .finally(() => {
          const remaining = (this.inFlightByHost.get(host) ?? 1) - 1;
          if (remaining <= 0) this.inFlightByHost.delete(host);
          else this.inFlightByHost.set(host, remaining);
          this.inFlight.delete(task);
          if (this.running && !this.activeRun) this.schedule(10);
        });
      this.inFlight.add(task);
    }
  }

  private async claim(blockedHosts: string[]): Promise<DeliveryRow | undefined> {
    return transaction(this.pool, async client => {
      const selected = await client.query<DeliveryRow>(
        `SELECT d.*, s.callback_url FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
         WHERE s.active AND s.expires_at>clock_timestamp() AND d.attempts<$1
           AND NOT (lower(substring(s.callback_url from '^https?://([^/:]+)')) = ANY($2::text[]))
           AND ((d.state='pending' AND d.next_attempt_at<=clock_timestamp()) OR (d.state='sending' AND d.locked_until<clock_timestamp()))
         ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [MAX_ATTEMPTS, blockedHosts]);
      if (!selected.rows[0]) return undefined;
      const row = selected.rows[0];
      const token = randomUUID();
      const updated = await client.query<DeliveryRow>(
        "UPDATE event_deliveries SET state='sending',attempts=attempts+1,lock_token=$3,locked_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE subscription_id=$1 AND event_id=$2 RETURNING *", [row.subscription_id, row.event_id, token]);
      return updated.rows[0] ? { ...updated.rows[0], callback_url: row.callback_url } : undefined;
    });
  }

  private async deliver(delivery: DeliveryRow): Promise<void> {
    const result = await this.pool.query<SubscriptionRow & { subject_id: string; payload: Record<string, unknown>; event_created_at: Date }>(
      `SELECT s.*,e.subject_id,e.payload,e.created_at AS event_created_at FROM event_subscriptions s
       JOIN events e ON e.id=$2 JOIN event_deliveries d ON d.subscription_id=s.id AND d.event_id=e.id
       WHERE s.id=$1 AND s.active AND s.expires_at>clock_timestamp() AND e.created_at>=s.starts_at AND d.state='sending' AND d.lock_token=$3`, [delivery.subscription_id, delivery.event_id, delivery.lock_token]);
    const sub = result.rows[0];
    if (!sub) { await this.complete(delivery, 'skipped', null, 'inactive'); return; }
    const principal = await this.auth.getPrincipal(sub.principal_id);
    let grantAllowed = true;
    if (sub.oauth_grant_id) {
      const grant = await this.pool.query('SELECT grant_snapshot FROM oauth_grants WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()', [sub.oauth_grant_id, sub.principal_id]);
      const snapshot = grant.rows[0]?.grant_snapshot as Principal | undefined;
      const granted = snapshot ? narrowGrant(snapshot, principal) : null;
      grantAllowed = !!granted && canAccessScope(granted, sub.scope) && allowsEvent(granted, sub.name);
    }
    if (!principal || !grantAllowed || principal.credentialVersion !== sub.credential_version || principal.tenantId !== sub.tenant_id || !canAccessScope(principal, sub.scope) || !allowsEvent(principal, sub.name)) {
      const disabled = await this.pool.query('UPDATE event_subscriptions SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2', [sub.id, sub.revision]);
      await this.complete(delivery, disabled.rowCount ? 'skipped' : 'pending', null, disabled.rowCount ? 'revoked' : 'subscription_refreshed');
      return;
    }
    let status: number | null = null;
    let errorCode: string | null = null;
    try {
      let body = JSON.stringify({ eventId: delivery.event_id, name: sub.name, timestamp: sub.event_created_at.toISOString(), data: { scope: sub.scope, subject_id: sub.subject_id, change: sub.payload }, cursor: null });
      if (sub.mode === 'generic' && sub.name === 'task.updated') {
        // Generic task sinks (e.g. a chat bot's webhook) hear only about finished work, as a small summary
        // without task output: the receiver looks the result up itself with task_get.
        const status = String(sub.payload.status ?? '');
        if (!TERMINAL_STATUSES.has(status)) { await this.complete(delivery, 'skipped', null, 'not_terminal'); return; }
        const task = (await this.pool.query<{ kind: string; objective: string; provider: string | null; updated_at: Date; failure_code: string | null }>(
          "SELECT kind,objective,result->>'provider' AS provider,updated_at,result->'failure'->>'code' AS failure_code FROM tasks WHERE id=$1 AND tenant_id=$2", [sub.subject_id, sub.tenant_id])).rows[0];
        body = JSON.stringify({ event: `task.${status}`, event_id: delivery.event_id, task_id: sub.subject_id, scope: sub.scope, kind: task?.kind ?? null,
          status, provider: task?.provider ?? null, completed_at: (task?.updated_at ?? sub.event_created_at).toISOString(),
          title: (task?.objective ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
          ...(task?.failure_code ? { failure_code: task.failure_code } : {}),
          inbox_receipts: (await inboxStatus(this.pool,principal,false,[sub.scope],sub.subject_id)).counts });
      }
      const secret = this.box.decrypt(sub.secret_ciphertext, sub.id);
      const old = sub.previous_secret_ciphertext && sub.previous_secret_until && sub.previous_secret_until.getTime() > Date.now() ? this.box.decrypt(sub.previous_secret_ciphertext, sub.id) : undefined;
      // Generic sinks send the owner's headers as given, plus Swarmaa's signature headers (keyed per subscription).
      const headers = sub.mode === 'mcp' ? signedHeaders(secret, sub.id, delivery.event_id, body, old)
        : { ...JSON.parse(secret) as Record<string, string>, ...signedHeaders(this.box.derive(sub.id), sub.id, delivery.event_id, body), 'X-Collective-Event-Id': delivery.event_id };
      status = (await this.send(sub.callback_url, body, headers)).status;
      if (status >= 200 && status < 300) { await this.complete(delivery, 'delivered', status, null); return; }
      errorCode = `http_${status}`;
    } catch (error) {
      errorCode = error instanceof AppError ? error.code : 'callback_failed';
    }
    if (status === 410) {
      const disabled = await this.pool.query('UPDATE event_subscriptions SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2', [sub.id, sub.revision]);
      if (!disabled.rowCount) { await this.complete(delivery, 'pending', status, 'subscription_refreshed'); return; }
    }
    const retryable = status === null || status === 408 || status === 429 || status >= 500;
    const terminal = status === 410 || status === 413 || !retryable || delivery.attempts >= MAX_ATTEMPTS;
    if (terminal && status !== 410 && status !== 413 && delivery.attempts < MAX_ATTEMPTS) {
      // A terminal auth failure may have used credentials replaced during the
      // request. Retry against the new revision rather than discarding its event.
      const refreshed = await this.pool.query('SELECT 1 FROM event_subscriptions WHERE id=$1 AND revision<>$2 AND active AND expires_at>clock_timestamp()', [sub.id, sub.revision]);
      if (refreshed.rowCount) { await this.complete(delivery, 'pending', status, 'subscription_refreshed'); return; }
    }
    await this.complete(delivery, terminal ? 'failed' : 'pending', status, errorCode);
  }

  private async complete(delivery: DeliveryRow, state: string, status: number | null, errorCode: string | null): Promise<void> {
    const delayMs = Math.min(3600000, 1000 * 2 ** delivery.attempts) + Math.floor(Math.random() * 1000);
    await this.pool.query(
      `UPDATE event_deliveries SET state=$4,last_status=$5,last_error_code=$6,lock_token=NULL,locked_until=NULL,
       next_attempt_at=clock_timestamp()+($7::int*interval '1 millisecond'),updated_at=clock_timestamp()
       WHERE subscription_id=$1 AND event_id=$2 AND lock_token=$3 AND state='sending'`, [delivery.subscription_id, delivery.event_id, delivery.lock_token, state, status, errorCode, delayMs]);
  }
}
