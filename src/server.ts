import { createServer } from 'node:http';
import { AuthService } from './auth.js';
import { loadConfig } from './config.js';
import { CoreService } from './core/index.js';
import { createPool } from './db.js';
import { EventService } from './events.js';
import { createHttpHandler } from './http.js';

const config = loadConfig();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createPool(process.env.DATABASE_URL);
const auth = new AuthService(pool);
const core = new CoreService(pool);
const events = config.eventCallbackHosts.length && config.eventEncryptionKey ? new EventService(pool, auth, config) : undefined;
const server = createServer(createHttpHandler({ pool, core, auth, events, config }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.on('error', () => { process.stderr.write('HTTP server error. Check address and port configuration.\n'); void shutdown(1); });
server.listen(config.port, config.host, () => {
  process.stderr.write(`Swarmaa listening on ${config.host}:${config.port}; public origin ${config.publicUrl}\n`);
  events?.start();
});

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 20000);
  deadline.unref();
  await Promise.all([
    new Promise<void>(resolve => { server.close(() => resolve()); }),
    events?.stop() ?? Promise.resolve(),
  ]);
  await pool.end();
  clearTimeout(deadline);
  process.exitCode = code;
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
