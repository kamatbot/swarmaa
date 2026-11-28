import pg, { type Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string): Pool {
  // Keep connections open: a fresh SCRAM handshake on a heavily loaded Mac can take many seconds.
  // events_poll only returns events older than every open transaction, so a transaction left idle would stall event
  // delivery for everyone; cap that at a minute.
  const parsedMax = Number(process.env.PG_POOL_MAX);
  const max = Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= 200 ? parsedMax : 24;
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 30_000, idleTimeoutMillis: 0, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 });
  // Idle connections can fail between requests during a database restart. Avoid
  // an unhandled EventEmitter error, and never print connection credentials.
  pool.on('error', () => process.stderr.write('An idle database connection failed; the next request will reconnect.\n'));
  // A connection that is checked out when the database restarts also emits 'error'.
  // Its query already rejects, so swallowing the event keeps the process alive.
  pool.on('connect', client => client.on('error', () => process.stderr.write('A database connection failed mid-request; the request returns an error and the next one reconnects.\n')));
  return pool;
}

const postCommitHooks = new WeakMap<PoolClient, Array<() => void>>();

/** Run a best-effort callback strictly after the enclosing transaction() commits (or immediately if not in one). */
export function onCommit(db: Pool | PoolClient, fn: () => void): void {
  if ('release' in db) {
    const hooks = postCommitHooks.get(db);
    if (hooks) {
      hooks.push(fn);
      return;
    }
  }
  try { fn(); } catch { /* best effort */ }
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const hooks: Array<() => void> = [];
  postCommitHooks.set(client, hooks);
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    postCommitHooks.delete(client);
    for (const hook of hooks) {
      try { hook(); } catch { /* best effort post-commit */ }
    }
    return value;
  } catch (error) {
    postCommitHooks.delete(client);
    await client.query('ROLLBACK');
    throw error;
  } finally {
    postCommitHooks.delete(client);
    client.release();
  }
}
