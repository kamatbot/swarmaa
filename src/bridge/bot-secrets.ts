import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sanitizedEnv } from './worktree.js';

const execFileAsync = promisify(execFile);

/** Keychain service for secrets the owner added in the Mac app when a bot asked (question_ask credential). */
export const BOT_SECRET_SERVICE = 'app.swarmaa.bot-secret';
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  secrets: Record<string, string>;
}

const cache = new Map<string, CacheEntry>();

export function clearBotSecretsCache(): void {
  cache.clear();
}

async function defaultReadKeychain(account: string): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/security',
    ['find-generic-password', '-s', BOT_SECRET_SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', timeout: 3000, env: sanitizedEnv() }
  );
  return stdout;
}

/**
 * Secrets for one project scope: names come from the Mac app's index (~/.swarma/bot-secrets.json,
 * {"project:x": ["GITHUB_TOKEN"]}), values from the login Keychain (account "<scope>/<NAME>").
 * Reads are async and concurrent with a short TTL cache so the event loop is never blocked.
 * Missing or unreadable items are skipped; Swarmaa service tokens can never be supplied this way.
 */
export async function botSecrets(
  scope: string,
  indexPath = join(homedir(), '.swarma', 'bot-secrets.json'),
  read: (account: string) => Promise<string> | string = defaultReadKeychain,
  opts?: { ttlMs?: number; now?: () => number }
): Promise<Record<string, string>> {
  const now = opts?.now ?? Date.now;
  const ttlMs = opts?.ttlMs ?? CACHE_TTL_MS;
  const cacheKey = `${indexPath}\0${scope}`;
  if (read === defaultReadKeychain || opts?.ttlMs !== undefined) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return { ...cached.secrets };
  }

  let names: unknown;
  try {
    names = (JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>)[scope];
  } catch {
    return {};
  }
  if (!Array.isArray(names)) return {};

  const validNames = names
    .slice(0, 32)
    .filter((name): name is string => typeof name === 'string' && NAME.test(name) && !/^(?:COLLECTIVE|SWARMAA)_/u.test(name));

  const entries = await Promise.all(
    validNames.map(async name => {
      try {
        const raw = await read(`${scope}/${name}`);
        const value = raw.replace(/\n$/u, '');
        if (value && value.length <= 8192) return [name, value] as const;
      } catch {
        /* not added yet */
      }
      return null;
    })
  );

  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (entry) out[entry[0]] = entry[1];
  }
  if (read === defaultReadKeychain || opts?.ttlMs !== undefined) {
    cache.set(cacheKey, { expiresAt: now() + ttlMs, secrets: { ...out } });
  }
  return out;
}

/** Replaces every secret value (8+ characters) in provider output, so it never reaches the chat or artifacts. */
export function scrubSecrets(text: string, secrets: Record<string, string>): string {
  for (const [name, value] of Object.entries(secrets)) if (value.length >= 8) text = text.split(value).join(`[${name}]`);
  return text;
}
