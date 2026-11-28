import pg, { type Pool } from 'pg';

// One dedicated connection per service pool, shared by all HTTP handlers/streams.
// It carries only wake-ups: durable, authorized reads remain in the stream handler.
const listeners = new WeakMap<Pool, EventWakeup>();
export function eventWakeup(pool: Pool): EventWakeup {
  let listener = listeners.get(pool);
  if (!listener) { listener = new EventWakeup(pool); listeners.set(pool, listener); }
  return listener;
}

interface WakeupSubscription {
  tenantId: string;
  /** null means all scopes (wildcard); otherwise only wake on matching scopes. */
  scopes: Set<string> | null;
}

class EventWakeup {
  private callbacks = new Map<() => void, WakeupSubscription>();
  private client?: pg.Client;
  private listening = false;
  private connecting?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private delay = 100;
  constructor(private pool: Pool) {}

  isConnected(): boolean {
    return this.listening && this.client !== undefined;
  }

  async subscribe(wake: () => void, tenantId: string, scopes?: readonly string[] | null): Promise<() => void> {
    this.callbacks.set(wake, {
      tenantId,
      scopes: scopes && scopes.length > 0 ? new Set(scopes) : null,
    });
    await this.connect();
    return () => {
      this.callbacks.delete(wake);
      if (!this.callbacks.size) {
        clearTimeout(this.retry);
        this.retry = undefined;
        this.delay = 100;
        this.connecting = undefined;
        this.listening = false;
        const client = this.client;
        this.client = undefined;
        void client?.end().catch(() => {});
      }
    };
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.client || !this.callbacks.size || this.retry) return Promise.resolve();
    const client = new pg.Client({ ...this.pool.options, connectionTimeoutMillis: 30_000 });
    this.client = client;
    this.listening = false;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.listening = false;
      this.connecting = undefined;
      void client.end().catch(() => {});
      if (this.callbacks.size && !this.retry) {
        this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, this.delay);
        this.retry.unref();
        this.delay = Math.min(this.delay * 2, 30_000);
      }
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', n => {
      if (this.client === client && n.channel === 'swarmaa_events') {
        const payload = n.payload ?? '';
        const tabIdx = payload.indexOf('\t');
        const notifTenant = tabIdx >= 0 ? payload.slice(0, tabIdx) : payload;
        const notifScope = tabIdx >= 0 ? payload.slice(tabIdx + 1) : null;
        for (const [wake, sub] of this.callbacks) {
          if (sub.tenantId !== notifTenant) continue;
          if (notifScope !== null && sub.scopes !== null && !sub.scopes.has(notifScope)) continue;
          wake();
        }
      }
    });
    this.connecting = (async () => {
      try {
        await client.connect();
        if (this.client !== client) return;
        await client.query('LISTEN swarmaa_events');
        if (this.client !== client) return;
        this.listening = true;
        this.delay = 100;
        for (const wake of this.callbacks.keys()) wake();
      } catch { disconnected(); }
    })();
    const connecting = this.connecting;
    // An abandoned attempt must not clear a replacement connection's promise.
    void connecting.finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
    });
    return connecting;
  }
}
