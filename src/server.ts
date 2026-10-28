import { PushWorker } from './push.js';
import { tickBotSchedules } from './core/bot-routing.js';
import { createServer } from 'node:http';
import { AuthService } from './auth.js';
import { loadConfig } from './config.js';
import { CoreService } from './core/index.js';
import { createPool } from './db.js';
import { EventService } from './events.js';
import { createHttpHandler } from './http.js';
import { OAuthService } from './oauth.js';

const config = loadConfig();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createPool(process.env.DATABASE_URL);
const auth = new AuthService(pool);
const core = new CoreService(pool);
const push = new PushWorker(pool);
const oauth = config.oauthEnabled ? new OAuthService(pool, auth, config) : undefined;
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
  oauth?.start();
  events?.start();
  push.start();
});

// B2 schedule tick: serialize sweeps and drain before closing the pool.
let scheduleSweep:Promise<void>|undefined;
const scheduleTimer = setInterval(() => {
  if (!scheduleSweep) scheduleSweep = tickBotSchedules(pool).catch(() => {
    process.stderr.write('Bot schedule sweep failed. Check schedule configuration and database health.\n');
  }).finally(() => { scheduleSweep = undefined; });
},30000);
scheduleTimer.unref();

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(scheduleTimer);
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 20000);
  deadline.unref();
  await Promise.all([
    new Promise<void>(resolve => { server.close(() => resolve()); }),
    oauth?.stop() ?? Promise.resolve(),
    events?.stop() ?? Promise.resolve(),
    push.stop(),
    scheduleSweep ?? Promise.resolve(),
  ]);
  await pool.end();
  clearTimeout(deadline);
  process.exitCode = code;
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
