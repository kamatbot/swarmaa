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
  '.npmrc', '.pypirc', '.env', '.env.local', '.env.production', '.local', '.swarmaa',
  'Library/Cookies', 'Library/Application Support/Google', 'Library/Safari', 'Library/Messages', 'Library/Mail'];

/**
 * Light macOS Seatbelt profile: allow the CLI what it can do in the user's shell, then deny credential
 * folders, service env files, and `~/.swarma` except the patch worktrees. Keychains and the provider's
 * own config (`.claude`, `.codex`) stay reachable because the CLIs keep their logins there.
 * Seatbelt uses the last matching rule, so the worktree allow comes after the `~/.swarma` deny.
 */
export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  const project = real(o.projectRoot);
  const denies = [
    ...CREDENTIAL_PATHS.map(d => sub(join(home, d))),
    sub(join(project, '.env')),
    sub(join(project, '.env.local')),
    sub(join(project, '.local')),
  ];
  const swarma = join(home, '.swarma');
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* ${denies.join(' ')})`,
    `(deny file-read* file-write* ${sub(swarma)})`,
    `(allow file-read* file-write* ${sub(join(swarma, 'worktrees'))})`,
  ].join('\n') + '\n';
}

export function sandboxAvailable(): boolean { return existsSync(SANDBOX_EXEC); }

/** Wrap a provider command line so it runs under the Seatbelt profile. */
export function wrapCommand(command: string, args: string[], o: SandboxOptions): { command: string; args: string[] } {
  if (process.platform !== 'darwin' || !sandboxAvailable()) throw new Error('sandbox-exec is unavailable; set sandbox:false for this agent to run it unconfined');
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(o), command, ...args] };
}
