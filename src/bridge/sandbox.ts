import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Provider } from './types.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** SBPL string literal: only backslash and double quote need escaping; control characters are refused. */
export function sbplString(value: string): string {
  if (/[\x00-\x1f]/u.test(value)) throw new Error('Sandbox path contains control characters');
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}
const sub = (p: string): string => `(subpath ${sbplString(p)})`;
function real(path: string): string { try { return realpathSync(path); } catch { return path; } }

export interface SandboxOptions {
  provider: Provider;
  binary: string;
  /** Provider working directory: the project root for read, the task's git worktree for patch. */
  projectRoot: string;
  /** Patch only: the repo's .git dir (shared object store, refs, worktree metadata) that git must write. */
  gitDir?: string;
  patch?: boolean;
  /** Claude patch only: the worker's own ~/.claude/projects/<slug(worktree)> dir, opened read+write (nothing else under projects/). */
  ownHistoryDir?: string;
  home?: string;
  tmp?: string;
}

/** Credential and private-data locations under $HOME that workers never touch. */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.gnupg', '.netrc', '.git-credentials', '.config/gh',
  '.npmrc', '.pypirc', 'Library/Cookies', 'Library/Application Support/Google', 'Library/Safari', 'Library/Messages', 'Library/Mail'];

/**
 * Light macOS Seatbelt profile: the worker can do what the CLI can do in the user's shell, except read or
 * write credential folders. Keychains stay reachable because the CLIs keep their own logins there.
 */
export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  return ['(version 1)', '(allow default)', `(deny file-read* file-write* ${CREDENTIAL_PATHS.map(d => sub(join(home, d))).join(' ')})`].join('\n') + '\n';
}

export function sandboxAvailable(): boolean { return existsSync(SANDBOX_EXEC); }

/** Wrap a provider command line so it runs under the Seatbelt profile. */
export function wrapCommand(command: string, args: string[], o: SandboxOptions): { command: string; args: string[] } {
  if (process.platform !== 'darwin' || !sandboxAvailable()) throw new Error('sandbox-exec is unavailable; set sandbox:false for this agent to run it unconfined');
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(o), command, ...args] };
}
