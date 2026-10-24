import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse } from 'node:path';
import type { Provider } from './types.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Escape path data, never interpolate a task into policy syntax. */
export function sbplString(value: string): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error('Sandbox path contains control characters');
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}
const sub = (p: string): string => `(subpath ${sbplString(p)})`;
const literal = (p: string): string => `(literal ${sbplString(p)})`;
function real(path: string): string {
  if (!isAbsolute(path)) throw new Error('Sandbox paths must be absolute');
  try { return realpathSync(path); } catch { return path; }
}
function without(root: string, excluded: string[]): string {
  return `(require-all ${sub(root)} ${excluded.map(path => `(require-not ${sub(path)})`).join(' ')})`;
}

export interface SandboxOptions {
  provider: Provider;
  binary: string;
  /** Project checkout (read) or isolated task worktree (patch), never task-supplied. */
  projectRoot: string;
  /** Shared git metadata is readable only; the parent bridge owns commits and refs. */
  gitDir?: string;
  patch?: boolean;
  /** Only this Claude task's transcript directory can be written. */
  ownHistoryDir?: string;
  /** Private per-run home, without shared config or other Codex conversations. */
  codexHome?: string;
  claudeSessionId?: string;
  home?: string;
  /** Owner-configured Swarmaa credential files, denied even inside an otherwise readable root. */
  protectedPaths?: string[];
  /** Mandatory private per-invocation directory, never all of /tmp or $TMPDIR. */
  tmp: string;
}

export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.gnupg', '.netrc', '.git-credentials', '.config/gh',
  '.npmrc', '.pypirc', 'Library/Cookies', 'Library/Application Support/Google', 'Library/Safari', 'Library/Messages', 'Library/Mail'];
const PROJECT_PRIVATE = ['.local', '.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.mcp.json',
  '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.gemini/config/mcp_config.json'];

/** Installed application/package root derived only from the owner's executable. */
function runtimeRoot(binary: string, home: string): string {
  const path = real(binary);
  const app = /^(.*?\.app)(?:\/|$)/u.exec(path)?.[1];
  if (app) return app;
  const module = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/u.exec(path)?.[1];
  if (module) return module;
  const parent = dirname(path);
  return parent === parse(parent).root || parent === home ? path : parent;
}

/**
 * Filesystem confinement is deny-by-default. Prompts and CLI permission settings
 * are not this boundary. Writes are limited to patch worktrees, private scratch
 * and enumerated provider state. Shared git metadata remains read-only.
 *
 * Network and the listed macOS identity/TLS services stay available. Keychain
 * login cannot be confined to individual Keychain items by this filesystem
 * policy. Use a dedicated worker OS account for stronger credential isolation.
 */
export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  const root = real(o.projectRoot), tmp = real(o.tmp);
  if ([parse(tmp).root, '/tmp', '/private/tmp', home].includes(tmp)) throw new Error('Sandbox requires a private invocation temporary directory');
  const credentialPaths = [...CREDENTIAL_PATHS.map(d => join(home, d)), ...(o.protectedPaths ?? [])].flatMap(path => [path, real(path)]);
  const privatePaths = [...credentialPaths, ...PROJECT_PRIVATE.map(d => join(root, d)).flatMap(path => [path, real(path)])];
  const projectFilter = `(require-all ${without(root, privatePaths)} (require-not (regex #"/[.]env($|[./])")))`;
  const systemRoots = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer', '/opt/homebrew', '/private/var/db/dyld', '/private/var/db/timezone'];
  const runtimeRoots = [runtimeRoot(o.binary, home), join(home, '.nvm/versions'), join(home, '.volta/tools'), join(home, '.bun/bin')];
  const systemFiles = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/etc/localtime', '/private/etc/passwd', '/private/etc/group', '/private/etc/services', '/private/etc/protocols'];
  const read = [...new Set([...systemRoots, ...runtimeRoots].map(real))].map(sub);
  read.push(...systemFiles.map(p => literal(real(p))), projectFilter, sub(tmp));
  const write = [sub(tmp), literal('/dev/null')];
  if (o.gitDir) read.push(sub(real(o.gitDir)));
  if (o.patch) write.push(`(require-all ${without(root, [...privatePaths, join(root, '.git'), ...(o.gitDir ? [real(o.gitDir)] : [])])} (require-not (regex #"/[.]env($|[./])")))`);

  if (o.provider === 'claude') {
    // Exact provider login files, never arbitrary settings/plugins/other chats.
    read.push(literal(join(home, '.claude.json')));
    read.push(literal(join(home, '.claude/.credentials.json')));
    write.push(literal(join(home, '.claude/.credentials.json')));
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const authSiblings = `(regex #${sbplString(`^${escapedHome}/\\.claude/\\.credentials\\.json(\\.(tmp|backup)[^/]*)?$`)})`;
    read.push(authSiblings); write.push(authSiblings);
    if (o.ownHistoryDir) { const history = real(o.ownHistoryDir); read.push(sub(history)); write.push(sub(history)); }
    if (o.claudeSessionId && /^[0-9a-f-]{36}$/iu.test(o.claudeSessionId)) {
      const diagnostic = join(home, '.claude/debug', `${o.claudeSessionId}.txt`);
      read.push(literal(diagnostic)); write.push(literal(diagnostic));
    }
  } else if (o.provider === 'codex') {
    if (!o.codexHome) throw new Error('Codex requires a private per-run home');
    const codexHome = real(o.codexHome);
    if (codexHome === join(home, '.codex') || codexHome === home) throw new Error('Codex home must be isolated from the interactive profile');
    read.push(sub(codexHome)); write.push(sub(codexHome));
  } else {
    const state = ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/config/projects'];
    const otherChats = ['.gemini/antigravity/brain', '.gemini/antigravity/conversations', '.gemini/antigravity/mcp_config.json', '.gemini/config/mcp_config.json'].map(p => join(home, p));
    for (const dir of state) { const filter = without(join(home, dir), otherChats); read.push(filter); write.push(filter); }
    for (const file of ['.gemini/oauth_creds.json', '.gemini/google_accounts.json']) { read.push(literal(join(home, file))); write.push(literal(join(home, file))); }
  }

  const protect = (filter: string): string => `(require-all ${filter} ${credentialPaths.map(path => `(require-not ${sub(path)})`).join(' ')} (require-not (regex #"/[.]env($|[./])")))`;
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec)', '(allow process-fork)', '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)',
    '(allow file-read-metadata)', // stat/traversal, not unrelated contents or listings.
    `(allow file-read* ${protect(`(require-any ${read.join(' ')})`)})`, `(allow file-write* ${protect(`(require-any ${write.join(' ')})`)})`,
    '(allow network-outbound)',
    '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.networkd") (global-name "com.apple.ocspd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd"))',
    '(allow ipc-posix-sem)',
  ].join('\n') + '\n';
}

export function sandboxAvailable(): boolean { return process.platform === 'darwin' && existsSync(SANDBOX_EXEC); }
export function assertSandboxAvailable(): void {
  if (!sandboxAvailable()) throw new Error('Worker execution requires macOS sandbox-exec; unconfined execution is not supported');
}

/** Pure construction: a missing wrapper fails at spawn; there is no CLI fallback. */
export function wrapCommand(command: string, args: string[], o: SandboxOptions): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(o), command, ...args] };
}
