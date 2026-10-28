import pg, { type Pool } from 'pg';

// One dedicated connection per service pool, shared by all HTTP handlers/streams.
// It carries only wake-ups: durable, authorized reads remain in the stream handler.
const listeners = new WeakMap<Pool, EventWakeup>();
export function eventWakeup(pool: Pool): EventWakeup {
  let listener = listeners.get(pool);
  if (!listener) { listener = new EventWakeup(pool); listeners.set(pool, listener); }
  return listener;
}

class EventWakeup {
  private callbacks = new Set<() => void>();
  private client?: pg.Client;
  private connecting?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private delay = 100;
  constructor(private pool: Pool) {}

  async subscribe(wake: () => void): Promise<() => void> {
    this.callbacks.add(wake);
    await this.connect();
    return () => {
      this.callbacks.delete(wake);
      if (!this.callbacks.size) {
        clearTimeout(this.retry);
        this.retry = undefined;
        const client = this.client;
        this.client = undefined;
        void client?.end().catch(() => {});
      }
    };
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.client || !this.callbacks.size || this.retry) return Promise.resolve();
    const client = new pg.Client({ ...this.pool.options, connectionTimeoutMillis: 5000 });
    this.client = client;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = undefined;
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
      if (n.channel === 'swarmaa_events') for (const wake of this.callbacks) wake();
    });
    this.connecting = (async () => {
      try {
        await client.connect();
        await client.query('LISTEN swarmaa_events');
        this.delay = 100;
        for (const wake of this.callbacks) wake();
      } catch { disconnected(); }
      finally { this.connecting = undefined; }
    })();
    return this.connecting;
  }
}
