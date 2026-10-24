// Pure helpers for scripts/setup.ts. No side effects at import.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Package root: the nearest ancestor of `from` that has a package.json (works from scripts/ in a checkout and dist/scripts/ in a compiled runtime). */
export function packageRoot(from: string): string {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) throw new Error(`no package.json above ${from}`);
  }
}

/** Compiled layout (the app's bundled runtime): dist/ exists and tsx (a devDependency) does not. */
export const isCompiled = (root: string): boolean => existsSync(join(root, 'dist')) && !existsSync(join(root, 'node_modules/tsx'));

/**
 * Arguments to pass to node to run a script, e.g. scriptCommand(root, 'scripts/admin', { envFile: true }).
 * `name` is the path without extension: compiled -> <root>/dist/<name>.js, dev checkout -> --import tsx <root>/<name>.ts.
 * The script path is always the last element.
 */
export function scriptCommand(root: string, name: string, o: { envFile?: boolean } = {}): string[] {
  const env = o.envFile ? [`--env-file=${join(root, '.env')}`] : [];
  return isCompiled(root) ? [...env, join(root, 'dist', `${name}.js`)] : [...env, '--import', 'tsx', join(root, `${name}.ts`)];
}

export interface ScopeRoot { scope: string; root: string }

export const AGY_TOOLS = ['inbox_get', 'message_send', 'task_watch', 'artifact_get', 'context_get', 'events_poll', 'lesson_list', 'lesson_propose', 'lesson_search', 'memory_get', 'memory_propose', 'memory_search', 'session_get', 'session_list', 'swarm_status', 'task_cancel', 'task_continue', 'task_get', 'task_list', 'task_submit'];

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    out[line.slice(0, eq).trim().replace(/^export\s+/, '')] = value;
  }
  return out;
}

export function yes(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === '') return defaultYes;
  if (/^(y|yes)$/.test(a)) return true;
  if (/^(n|no)$/.test(a)) return false;
  return defaultYes;
}

/** project:<slug> per path. Slug = lowercase basename, non [a-z0-9-] -> '-', trimmed of '-'; collisions get -2, -3. `taken` pre-reserves slugs (e.g. 'demo'). */
/** A folder entry is "/abs/path" or "name=/abs/path"; the name becomes the scope (project:<name>). */
export function splitFolder(entry: string): { name?: string; path: string } {
  const m = /^([a-z][a-z0-9-]{0,40})=(\/.*)$/.exec(entry);
  return m ? { name: m[1], path: m[2]! } : { path: entry };
}

export function slugScopes(paths: string[], taken: string[] = []): ScopeRoot[] {
  const used = new Set(taken);
  const seenRoots = new Set<string>();
  const out: ScopeRoot[] = [];
  for (const entry of paths) {
    const { name, path: root } = splitFolder(entry);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const base = (name ?? basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')) || 'project';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.push({ scope: `project:${slug}`, root });
  }
  return out;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface PlistOptions {
  workingDirectory?: string; env?: Record<string, string>; stdout?: string; stderr?: string;
  /** One-shot jobs: run every N seconds (StartInterval). Implies no KeepAlive. */
  startInterval?: number;
  /** One-shot jobs: run daily at this time (StartCalendarInterval). Implies no KeepAlive. */
  calendar?: { hour: number; minute: number };
  /** Default true for daemons, and also for interval jobs; pass false to wait for the first interval. */
  runAtLoad?: boolean;
}

export function plist(label: string, programArguments: string[], opts: PlistOptions = {}): string {
  const str = (k: string, v: string) => `\t<key>${xml(k)}</key>\n\t<string>${xml(v)}</string>\n`;
  const flag = (k: string) => `\t<key>${k}</key>\n\t<true/>\n`;
  const int = (k: string, v: number) => `\t<key>${k}</key>\n\t<integer>${Math.trunc(v)}</integer>\n`;
  const oneShot = opts.startInterval !== undefined || opts.calendar !== undefined;
  const env = Object.entries(opts.env ?? {}).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>\n`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n'
    + str('Label', label)
    + `\t<key>ProgramArguments</key>\n\t<array>\n${programArguments.map(a => `\t\t<string>${xml(a)}</string>\n`).join('')}\t</array>\n`
    + (opts.workingDirectory ? str('WorkingDirectory', opts.workingDirectory) : '')
    + (env ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${env}\t</dict>\n` : '')
    + (opts.runAtLoad === false ? '' : flag('RunAtLoad')) + (oneShot ? '' : flag('KeepAlive'))
    + (opts.startInterval !== undefined ? int('StartInterval', opts.startInterval) : '')
    + (opts.calendar ? `\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>${Math.trunc(opts.calendar.hour)}</integer>\n\t\t<key>Minute</key>\n\t\t<integer>${Math.trunc(opts.calendar.minute)}</integer>\n\t</dict>\n` : '')
    + (oneShot ? '' : '\t<key>ThrottleInterval</key>\n\t<integer>10</integer>\n')
    // Background puts a job in the lowest macOS tier (priority 4, throttled disk), which starved Postgres and the
    // service whenever a build or agents were busy. Long-running jobs get the normal tier; one-shot chores stay low.
    + str('ProcessType', oneShot ? 'Background' : 'Standard')
    + (opts.stdout ? str('StandardOutPath', opts.stdout) : '')
    + (opts.stderr ? str('StandardErrorPath', opts.stderr) : '')
    + '</dict>\n</plist>\n';
}

/** Adds mcp(swarma/<tool>) to permissions.allow, preserving every other key and entry. Returns a new object. */
export function mergeAgyPermissions(settings: unknown, tools: string[], server = 'swarma'): Record<string, unknown> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const base = isObj(settings) ? settings : {};
  const permissions = isObj(base.permissions) ? base.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ...base, permissions: { ...permissions, allow: [...new Set([...allow, ...tools.map(t => `mcp(${server}/${t})`)])] } };
}

export interface BridgeConfigInput {
  port: string | number;
  tokenFile: string;
  agent: { id: string; binary: string; model?: string; provider?: string };
  projects: ScopeRoot[];
  /** Opt-in: sandboxed edits in git worktrees. Default read-only (research/review), which needs no task:patch grant. */
  edit?: boolean;
  /** Empty folder that project:general (research with no codebase) runs in; omitted = no general project. */
  generalRoot?: string;
}

export function bridgeConfig({ port, tokenFile, agent, projects, edit = false, generalRoot }: BridgeConfigInput): Record<string, unknown> {
  return {
    service_url: `http://127.0.0.1:${port}`,
    token_file: tokenFile,
    poll_seconds: 3, lease_seconds: 120, heartbeat_seconds: 20, request_timeout_ms: 10000,
    task_timeout_seconds: 3600, max_output_bytes: 4194304, max_prompt_bytes: 131072,
    agents: [{ id: agent.id, provider: agent.provider ?? agent.id, binary: agent.binary, ...(agent.model ? { model: agent.model } : {}), enable_patch: edit, ...(agent.provider === 'antigravity' ? { sandbox: true } : {}) }],
    projects: [...projects.map(p => ({ scope: p.scope, root: p.root, agents: [agent.id], allow_patch: edit })),
      // project:general has no codebase: read-only research/review only.
      ...(generalRoot ? [{ scope: GENERAL_SCOPE, root: generalRoot, agents: [agent.id], allow_patch: false }] : [])],
    reason: null,
  };
}

// ---- Setup plan: shared by the terminal wizard and the browser onboarding ----
export const HARNESS_KEYS = ['claude', 'codex', 'agy', 'grok', 'dot', 'notchtrader'] as const;
export type HarnessKey = typeof HARNESS_KEYS[number];
export const WORKER_HARNESSES: readonly HarnessKey[] = ['claude', 'codex', 'agy'];
/** Apps that share chats through their own hooks (no MCP connection): Kiro, Windsurf (also Devin Desktop), Qwen Code. */
export const HOOK_APP_KEYS = ['kiro', 'windsurf', 'qwen'] as const;
export type HookAppKey = typeof HOOK_APP_KEYS[number];
export const SHARING_HARNESSES: readonly HarnessKey[] = ['claude', 'codex', 'agy'];
export const GENERAL_SCOPE = 'project:general';
export const DEFAULT_HOSTNAME = '';

/** `edit` is the worker's explicit opt-in to edits (needs the task:patch grant); it implies `worker`. */
export interface HarnessPlan { connect: boolean; worker: boolean; edit: boolean; share: boolean }
export interface SetupPlan {
  /** Print optional idle-wake aliases; never install them or edit a shell profile. Off by default. */
  wrapAliases?: boolean;
  harnesses: Partial<Record<HarnessKey, HarnessPlan>>;
  /** Poll chats of the other installed AI coding apps (Cursor, OpenCode, ...). Off unless the plan says so. */
  capture: { enabled: boolean };
  hookApps: Partial<Record<HookAppKey, { share: boolean }>>;
  folders: string[];
  remote?: { hostname: string };
  autostart: boolean;
}
export interface State { folders?: string[]; projects?: ScopeRoot[]; agents?: string[]; workers?: string[]; edits?: string[]; sharing?: string[]; capture?: boolean; hookApps?: string[]; autostart?: boolean; remote?: { hostname: string } }

/** Every identity sees every project plus project:general; workers run general (research) tasks in an empty, read-only folder. */
export function identityScopes(_kind: 'interactive' | 'worker', projects: ScopeRoot[]): string[] {
  return [...projects.map(p => p.scope), GENERAL_SCOPE];
}

/** Contents of .local/setup.json; the chat-journal hooks read `projects`. */
export function stateFile(s: { folders: string[]; projects: ScopeRoot[]; agents: string[]; workers: string[]; edits?: string[]; sharing: string[]; capture?: boolean; hookApps?: string[]; autostart: boolean; remote?: { hostname: string } }): State {
  return { folders: s.folders, projects: s.projects.map(p => ({ scope: p.scope, root: p.root })), agents: s.agents, workers: s.workers, ...(s.edits ? { edits: s.edits } : {}), sharing: s.sharing, ...(s.capture !== undefined ? { capture: s.capture } : {}), ...(s.hookApps ? { hookApps: s.hookApps } : {}), autostart: s.autostart, ...(s.remote ? { remote: s.remote } : {}) };
}

/** Lowercased DNS name with at least two labels and an alphabetic (or punycode) TLD; undefined if invalid. */
export function validHostname(h: unknown): string | undefined {
  if (typeof h !== 'string') return undefined;
  const s = h.trim().toLowerCase().replace(/\.$/, '');
  return s.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/.test(s) ? s : undefined;
}

export class PlanError extends Error {
  constructor(readonly errors: string[]) { super(errors.join('; ')); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates untrusted input (the browser page) into a SetupPlan. Throws PlanError listing every problem. */
export function validatePlan(input: unknown): SetupPlan {
  const errors: string[] = [];
  if (!isObj(input)) throw new PlanError(['plan must be an object']);
  for (const k of Object.keys(input)) if (!['harnesses', 'capture', 'hookApps', 'folders', 'remote', 'autostart', 'wrapAliases'].includes(k)) errors.push(`unknown field "${k}"`);
  if (input.wrapAliases!==undefined && typeof input.wrapAliases!=='boolean') errors.push('wrapAliases must be true or false');
  const harnesses: SetupPlan['harnesses'] = {};
  if (!isObj(input.harnesses)) errors.push('harnesses must be an object');
  else for (const [key, v] of Object.entries(input.harnesses)) {
    if (!(HARNESS_KEYS as readonly string[]).includes(key)) { errors.push(`unknown harness "${key.slice(0, 40)}"`); continue; }
    const k = key as HarnessKey;
    if (!isObj(v)) { errors.push(`harness ${k} must be an object`); continue; }
    for (const f of Object.keys(v)) if (!['connect', 'worker', 'edit', 'share'].includes(f)) errors.push(`harness ${k}: unknown field "${f.slice(0, 40)}"`);
    for (const f of ['connect', 'worker', 'edit', 'share']) if (v[f] !== undefined && typeof v[f] !== 'boolean') errors.push(`harness ${k}: ${f} must be true or false`);
    if (v.worker === true && !WORKER_HARNESSES.includes(k)) errors.push(`harness ${k} cannot run as a background worker`);
    if (v.edit === true && v.worker !== true) errors.push(`harness ${k}: edit requires worker`);
    if (v.share === true && !SHARING_HARNESSES.includes(k)) errors.push(`harness ${k} does not support chat sharing`);
    const connect = v.connect === true;
    const worker = connect && v.worker === true;
    harnesses[k] = { connect, worker, edit: worker && v.edit === true, share: connect && SHARING_HARNESSES.includes(k) && v.share !== false };
  }
  let capture = false;
  if (input.capture !== undefined) {
    const c = input.capture;
    if (!isObj(c)) errors.push('capture must be an object');
    else {
      for (const f of Object.keys(c)) if (f !== 'enabled') errors.push(`capture: unknown field "${f.slice(0, 40)}"`);
      if (c.enabled !== undefined && typeof c.enabled !== 'boolean') errors.push('capture: enabled must be true or false');
      capture = c.enabled === true;
    }
  }
  const hookApps: SetupPlan['hookApps'] = {};
  if (input.hookApps !== undefined) {
    if (!isObj(input.hookApps)) errors.push('hookApps must be an object');
    else for (const [key, v] of Object.entries(input.hookApps)) {
      if (!(HOOK_APP_KEYS as readonly string[]).includes(key)) { errors.push(`unknown hook app "${key.slice(0, 40)}"`); continue; }
      if (!isObj(v)) { errors.push(`hook app ${key} must be an object`); continue; }
      for (const f of Object.keys(v)) if (f !== 'share') errors.push(`hook app ${key}: unknown field "${f.slice(0, 40)}"`);
      if (v.share !== undefined && typeof v.share !== 'boolean') errors.push(`hook app ${key}: share must be true or false`);
      hookApps[key as HookAppKey] = { share: v.share !== false };
    }
  }
  const folders: string[] = [];
  if (!Array.isArray(input.folders) || input.folders.length + 2 > 512) errors.push('folders must be a list of at most 510 paths (512 scopes including demo and general)');
  else for (const entry of input.folders) {
    if (typeof entry !== 'string' || !entry || entry.length > 4096 || entry.includes('\0')) { errors.push('folder must be a path string'); continue; }
    const { name, path: f } = splitFolder(entry);
    if (!isAbsolute(f)) { errors.push(`folder is not an absolute path: ${f}`); continue; }
    try { if (!statSync(f).isDirectory()) throw new Error('not a directory'); } catch { errors.push(`folder is not an existing directory: ${f}`); continue; }
    const r = name ? `${name}=${resolve(f)}` : resolve(f);
    if (!folders.includes(r)) folders.push(r);
  }
  let remote: SetupPlan['remote'];
  if (input.remote !== undefined && input.remote !== null) {
    const host = isObj(input.remote) ? validHostname(input.remote.hostname) : undefined;
    if (!host) errors.push('remote.hostname must be a valid DNS name such as swarm.example.com');
    else remote = { hostname: host };
  }
  if (typeof input.autostart !== 'boolean') errors.push('autostart must be true or false');
  if (errors.length) throw new PlanError(errors);
  return { harnesses, capture: { enabled: capture }, hookApps, folders, ...(remote ? { remote } : {}), autostart: input.autostart === true, ...(input.wrapAliases===true ? {wrapAliases:true} : {}) };
}
