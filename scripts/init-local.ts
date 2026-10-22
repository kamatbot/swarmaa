import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const password = randomBytes(24).toString('hex');
// Ports can be overridden (the app picks free ones); defaults match the dev install.
const pgPort = process.env.SWARMAA_PG_PORT || '54329', port = process.env.SWARMAA_PORT || '8787';
for (const p of [pgPort, port]) if (!/^\d{2,5}$/.test(p) || Number(p) > 65535) throw new Error('SWARMAA_PG_PORT and SWARMAA_PORT must be port numbers.');
const key = randomBytes(32).toString('hex');
const env = [
  `POSTGRES_PASSWORD=${password}`, `PG_PORT=${pgPort}`,
  `DATABASE_URL=postgresql://collective:${password}@127.0.0.1:${pgPort}/collective`,
  'HOST=127.0.0.1', `PORT=${port}`, `PUBLIC_URL=http://127.0.0.1:${port}`,
  'ALLOW_INSECURE_LOCALHOST=true', `ALLOWED_ORIGINS=http://127.0.0.1:${port}`,
  'OAUTH_ENABLED=true', 'OAUTH_REDIRECT_HOSTS=', 'EVENT_CALLBACK_HOSTS=', `EVENT_ENCRYPTION_KEY=${key}`, '',
].join('\n');
try {
  await writeFile('.env', env, { flag: 'wx', mode: 0o600 });
  await mkdir('.local', { recursive: true, mode: 0o700 });
  process.stderr.write('Created .env with unique local credentials. Keep it private and backed up.\n');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('.env already exists; no file was overwritten.');
  throw error;
}
