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
const lit = (p: string): string => `(literal ${sbplString(p)})`;

/** Lock/temp siblings such as ~/.claude.json.tmp.123 (SBPL regex literals take backslashes raw). */
function fileSiblings(file: string): string {
  if (file.includes('"')) throw new Error('Sandbox path contains a quote');
  return `(regex #"^${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\..*")`;
}
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

/**
 * macOS Seatbelt profile. Shape: allow everything (exec, network, mach, sysctl, signals) EXCEPT
 * the filesystem, which is deny-by-default for read and write; then explicit allows; then explicit
 * credential denies LAST (SBPL: last matching rule wins), so they beat the allows above them.
 * file-read-metadata (stat) stays global: path traversal needs it; contents stay protected.
 */
export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  const root = real(o.projectRoot);
  const binary = real(o.binary);
  const tmp = real(o.tmp ?? tmpdir());
  const binDirs = [dirname(binary)];
  const agy = o.provider === 'antigravity';
  const stateDirs = o.provider === 'claude' ? [join(home, '.claude')] : agy ? [join(home, '.gemini/antigravity-cli'), join(home, '.gemini/antigravity'), join(home, '.gemini/config/projects')] : [join(home, '.codex')];
  const stateFiles = o.provider === 'claude' ? [join(home, '.claude.json')] : [];
  const git = o.patch && o.gitDir ? [real(o.gitDir)] : [];
  // Build caches (go, npm, pnpm, golangci-lint), writable for patch so builds and tests run.
  const caches = ['go', 'Library/Caches/go-build', 'Library/Caches/golangci-lint', '.npm', '.cache', 'Library/Caches/pnpm', 'Library/pnpm'].map(d => join(home, d));
  const toolchains = ['/opt/homebrew', '/usr/local', '/Library/Developer', '/Applications/Xcode.app', join(home, 'go'), join(home, '.npm'), join(home, '.nvm'), join(home, '.local/bin')];
  const readTrees = [
    root, ...binDirs, tmp, ...stateDirs, ...toolchains, ...git, ...(o.patch ? [...caches, join(home, '.config/git')] : []),
    '/System', '/usr/lib', '/usr/share', '/usr/libexec', '/Library/Apple', '/Library/Preferences', '/private/var/db/timezone', '/private/etc/ssl',
    '/private/etc/resolv.conf', '/private/var/db/mds', '/private/var/db/DetachedSignatures', '/Library/Keychains', join(home, 'Library/Keychains'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const writeTrees = [tmp, ...stateDirs, ...(o.patch ? [root, ...git, ...caches] : [])];
  const readLiterals = ['/', '/tmp', '/var', '/etc', '/dev/null', '/dev/urandom', '/dev/random', '/dev/zero', '/dev/tty', '/private/etc/hosts', '/private/etc/passwd', '/private/etc/localtime', '/private/etc/resolv.conf', ...stateFiles, ...(o.patch ? [join(home, '.gitconfig')] : [])]; // git fails hard (EPERM) if ~/.gitconfig is unreadable
  const deniedHomeSubdirs = ['.ssh', '.aws', '.config/gh', '.gnupg', '.kube', '.docker', '.azure', '.config/gcloud', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'Library/Cookies', 'Library/Application Support/Google', 'Library/Safari', 'Library/Messages', 'Library/Mail'];
  // Cross-project and conversation history under the provider's own state dir.
  const deniedState = agy
    ? ['conversations', 'conversation_summaries.db', 'annotations', 'implicit', 'mcp', 'settings.json'].map(n => join(home, '.gemini/antigravity-cli', n))
    : o.provider === 'claude'
    ? ['projects', 'history.jsonl', 'file-history', 'todos', 'shell-snapshots', 'sessions', 'transcripts'].map(n => join(home, '.claude', n))
    : ['sessions', 'archived_sessions', 'history.jsonl', 'log', 'logs_1.sqlite', 'state_5.sqlite'].map(n => join(home, '.codex', n));
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-read* file-write*)',
    '(allow file-read-metadata)',
    `(allow file-read* ${[...readTrees.map(sub), ...readLiterals.map(lit)].join(' ')})`,
    `(allow file-write* ${[...writeTrees.map(sub), '(literal "/dev/null")', '(literal "/dev/tty")', '(regex #"^/dev/ttys[0-9]+$")', ...stateFiles.flatMap(f => [lit(f), fileSiblings(f)])].join(' ')})`,
    // Credential-like paths, denied last. The project root is exempt only when it is not itself inside one.
    // agy writes its plan artifact under brain/<conversation>/ but never needs other conversations' content back.
    ...(agy ? [`(deny file-read* ${sub(join(home, '.gemini/antigravity-cli/brain'))} ${sub(join(home, '.gemini/antigravity/brain'))} ${sub(join(home, '.gemini/antigravity/conversations'))} ${sub(join(home, '.gemini/antigravity/knowledge'))})`] : []),
    `(deny file-read* file-write* ${[...deniedHomeSubdirs.map(d => sub(join(home, d))), ...deniedState.map(sub)].join(' ')})`,
    // Exempt only the worker's own history dir (its transcript, which the bridge copies out afterwards).
    ...(o.ownHistoryDir && o.provider === 'claude' ? [`(allow file-read* file-write* ${sub(real(o.ownHistoryDir))})`] : []),
  ];
  return lines.join('\n') + '\n';
}

export function sandboxAvailable(): boolean { return existsSync(SANDBOX_EXEC); }

/** Wrap a provider command line so it runs under the Seatbelt profile. */
export function wrapCommand(command: string, args: string[], o: SandboxOptions): { command: string; args: string[] } {
  if (process.platform !== 'darwin' || !sandboxAvailable()) throw new Error('sandbox-exec is unavailable; set sandbox:false for this agent to run it unconfined');
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(o), command, ...args] };
}
