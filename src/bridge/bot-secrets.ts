import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Keychain service for secrets the owner added in the Mac app when a bot asked (question_ask credential). */
export const BOT_SECRET_SERVICE = 'app.swarmaa.bot-secret';
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;

/**
 * Secrets for one project scope: names come from the Mac app's index (~/.swarma/bot-secrets.json,
 * {"project:x": ["GITHUB_TOKEN"]}), values from the login Keychain (account "<scope>/<NAME>").
 * Missing or unreadable items are skipped; Swarmaa service tokens can never be supplied this way.
 */
export function botSecrets(scope: string, indexPath = join(homedir(), '.swarma', 'bot-secrets.json'),
  read: (account: string) => string = account => execFileSync('/usr/bin/security',
    ['find-generic-password', '-s', BOT_SECRET_SERVICE, '-a', account, '-w'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })): Record<string, string> {
  let names: unknown;
  try { names = (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>)[scope]; } catch { return {}; }
  if (!Array.isArray(names)) return {};
  const out: Record<string, string> = {};
  for (const name of names.slice(0, 32)) {
    if (typeof name !== 'string' || !NAME.test(name) || /^(?:COLLECTIVE|SWARMAA)_/u.test(name)) continue;
    try { const value = read(`${scope}/${name}`).replace(/\n$/u, ''); if (value && value.length <= 8192) out[name] = value; } catch { /* not added yet */ }
  }
  return out;
}

/** Replaces every secret value (8+ characters) in provider output, so it never reaches the chat or artifacts. */
export function scrubSecrets(text: string, secrets: Record<string, string>): string {
  for (const [name, value] of Object.entries(secrets)) if (value.length >= 8) text = text.split(value).join(`[${name}]`);
  return text;
}
