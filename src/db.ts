import pg, { type Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 30_000 });
  // Idle connections can fail between requests during a database restart. Avoid
  // an unhandled EventEmitter error, and never print connection credentials.
  pool.on('error', () => process.stderr.write('An idle database connection failed; the next request will reconnect.\n'));
  // A connection that is checked out when the database restarts also emits 'error'.
  // Its query already rejects, so swallowing the event keeps the process alive.
  pool.on('connect', client => client.on('error', () => process.stderr.write('A database connection failed mid-request; the request returns an error and the next one reconnects.\n')));
  return pool;
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
