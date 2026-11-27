import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Provider } from './types.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** SBPL string literal: only backslash and double quote need escaping; control characters are refused. */
export function sbplString(value: string): string {
  if (/[\x00-\x1f]/u.test(value)) throw new Error('Sandbox path contains control characters');
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}
const sub = (p: string): string => `(subpath ${sbplString(p)})`;
const lit = (p: string): string => `(literal ${sbplString(p)})`;

/** Resolve symlinks (e.g. /var -> /private/var, /tmp -> /private/tmp) even if the leaf does not exist yet. */
export function real(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { /* walk up to deepest existing ancestor */ }
  const parts: string[] = [];
  let cur = abs;
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    parts.unshift(cur.slice(parent.endsWith(sep) ? parent.length : parent.length + 1));
    cur = parent;
    try { return join(realpathSync(cur), ...parts); } catch { /* keep climbing */ }
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

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
export const CREDENTIAL_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.gnupg',
  '.netrc',
  '.git-credentials',
  '.config/gh',
  '.npmrc',
  '.pypirc',
  'Library/Cookies',
  'Library/Application Support/Google',
  'Library/Safari',
  'Library/Messages',
  'Library/Mail',
  '.swarmaa',
  '.swarma',
  'Library/LaunchAgents',
  '.pgpass',
  '.zsh_history',
  '.bash_history',
  '.config/op',
  '.local/relay-host.key',
  '.env',
];

function providerRuntimeDirs(provider: Provider, home: string): string[] {
  if (provider === 'claude') return [join(home, '.claude')];
  if (provider === 'codex') return [join(home, '.codex')];
  return [join(home, '.gemini')];
}

/** Build tool caches and state the CLIs and the builds they run write to (xcodebuild, simulators, npm, SwiftPM, pip).
 *  Without them every task that builds or tests fails, so they stay writable for all tasks. */
export const TOOLCHAIN_WRITE_PATHS = ['Library/Caches', 'Library/Developer', 'Library/Logs', 'Library/org.swift.swiftpm', '.npm', '.cache', '.swiftpm', '.cargo', '.gradle', '.bun', '.pnpm-store'];

/**
 * Hardened macOS Seatbelt profile:
 * - Denies all file writes globally, then allows writes ONLY to temp dirs, /dev/null, /dev/tty,
 *   the provider's minimal runtime dir, and (for patch tasks only) projectRoot, gitDir, and ownHistoryDir.
 * - Denies read and write access to all credential/private paths (including .swarma, .swarmaa, LaunchAgents,
 *   .pgpass, shell histories, .config/op, relay-host.key, .env).
 * - Keychains stay reachable because CLIs keep their own logins there.
 * - For worktrees living inside ~/.swarma/worktrees/, only the task's own projectRoot is carved out.
 */
export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  const tmp = real(o.tmp ?? tmpdir());
  const projectRoot = real(o.projectRoot);
  const gitDir = o.gitDir ? real(o.gitDir) : undefined;
  const ownHistoryDir = o.ownHistoryDir ? real(o.ownHistoryDir) : undefined;
  const swarmaDir = join(home, '.swarma');
  const worktreesDir = join(swarmaDir, 'worktrees');
  const projectInWorktrees = isWithin(projectRoot, worktreesDir) && projectRoot !== worktreesDir;

  const writeSubpaths = new Set<string>([tmp, '/tmp', '/private/tmp', ...providerRuntimeDirs(o.provider, home).map(real),
    ...TOOLCHAIN_WRITE_PATHS.map(d => real(join(home, d)))]);
  if (o.patch) {
    writeSubpaths.add(projectRoot);
    if (gitDir) writeSubpaths.add(gitDir);
    if (ownHistoryDir) writeSubpaths.add(ownHistoryDir);
  }

  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${lit('/dev/null')} ${lit('/dev/tty')} ${[...writeSubpaths].map(sub).join(' ')})`,
  ];
  // Claude keeps its settings in ~/.claude.json and rewrites it (plus backup/temp siblings) on every run.
  if (o.provider === 'claude') lines.push(`(allow file-write* (regex ${sbplString(`^${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude\\.json`)}))`);

  // For Claude patch tasks with a dedicated project transcript dir, deny writes to sibling project transcripts.
  if (o.provider === 'claude' && ownHistoryDir) {
    const claudeProjects = real(join(home, '.claude', 'projects'));
    lines.push(`(deny file-write* ${sub(claudeProjects)})`);
    lines.push(`(allow file-write* ${sub(ownHistoryDir)})`);
  }

  // Defense-in-depth for read-only tasks: even if projectRoot happens to sit under /tmp or $TMPDIR, deny writing to it.
  if (!o.patch && projectRoot !== tmp && projectRoot !== '/tmp' && projectRoot !== '/private/tmp') {
    lines.push(`(deny file-write* ${sub(projectRoot)})`);
  }

  // Deny reads and writes to every credential/private location AFTER write allows so nothing can bypass them.
  const deniedCreds = CREDENTIAL_PATHS.map(d => sub(real(join(home, d))));
  lines.push(`(deny file-read* file-write* ${deniedCreds.join(' ')})`);

  // Carve out ONLY this task's worktree when it resides under ~/.swarma/worktrees/ (keeping ~/.swarma/* denied).
  if (projectInWorktrees) {
    const ancestors: string[] = [swarmaDir, worktreesDir];
    const parent = dirname(projectRoot);
    if (parent !== worktreesDir && isWithin(parent, worktreesDir)) ancestors.push(parent);
    lines.push(`(allow file-read-metadata ${ancestors.map(lit).join(' ')})`);
    lines.push(o.patch
      ? `(allow file-read* file-write* ${sub(projectRoot)})`
      : `(allow file-read* ${sub(projectRoot)})`);
  }

  return `${lines.join('\n')}\n`;
}

export function sandboxAvailable(): boolean { return existsSync(SANDBOX_EXEC); }

/** Wrap a provider command line so it runs under the Seatbelt profile. */
export function wrapCommand(command: string, args: string[], o: SandboxOptions): { command: string; args: string[] } {
  if (process.platform !== 'darwin' || !sandboxAvailable()) throw new Error('sandbox-exec is unavailable; set sandbox:false for this agent to run it unconfined');
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(o), command, ...args] };
}
