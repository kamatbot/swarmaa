import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('hex');
const env = [
  `POSTGRES_PASSWORD=${password}`, 'PG_PORT=54329',
  `DATABASE_URL=postgresql://collective:${password}@127.0.0.1:54329/collective`,
  'HOST=127.0.0.1', 'PORT=8787', 'PUBLIC_URL=http://127.0.0.1:8787',
  'ALLOW_INSECURE_LOCALHOST=true', 'ALLOWED_ORIGINS=http://127.0.0.1:8787',
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
