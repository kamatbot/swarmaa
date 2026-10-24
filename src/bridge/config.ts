import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentConfig, BridgeConfig, ProjectConfig, Provider } from './types.js';

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`${field} must be a nonempty string without control characters`);
  return value;
}
function bool(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}
function integer(value: unknown, fallback: number, field: string, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return n;
}
function absolute(value: unknown, field: string): string {
  const path = text(value, field);
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path`);
  return path;
}

/** Deliberately allow cleartext only on loopback for local setup. Never follow redirects. */
export function serviceUrl(value: unknown): string {
  const url = new URL(text(value, 'service_url'));
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('service_url must be an origin without credentials, path, query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('service_url requires HTTPS except on loopback');
  return url.origin;
}

export function parseBridgeConfig(value: unknown): BridgeConfig {
  const raw = record(value, 'config');
  const token_env = text(raw.token_env ?? 'COLLECTIVE_WORKER_TOKEN', 'token_env', 100);
  if (!/^(?:COLLECTIVE|SWARMAA)_[A-Z0-9_]+$/u.test(token_env)) throw new Error('token_env must be a COLLECTIVE_ or SWARMAA_ environment variable name');
  if (!Array.isArray(raw.agents) || raw.agents.length < 1 || raw.agents.length > 15) throw new Error('agents requires 1–15 entries');
  const agents: AgentConfig[] = raw.agents.map((entry, index) => {
    const a = record(entry, `agents[${index}]`);
    const id = text(a.id, 'agent.id', 50);
    if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new Error('agent.id must be lowercase letters, digits, _ or -');
    const provider = text(a.provider, 'agent.provider') as Provider;
    if (!['claude', 'codex', 'antigravity'].includes(provider)) throw new Error(`Unsupported provider for ${id}`);
    const enable_patch = bool(a.enable_patch, 'agent.enable_patch');
    if (a.sandbox !== undefined && typeof a.sandbox !== 'boolean') throw new Error('agent.sandbox must be a boolean');
    const sandbox = a.sandbox !== false;
    // agy has no read-only enforcement of its own: the outer Seatbelt profile is its only file boundary.
    if (provider === 'antigravity' && !sandbox) throw new Error('Antigravity workers require sandbox:true (the Seatbelt profile is their read boundary)');
    return { id, provider, sandbox, binary: absolute(a.binary, 'agent.binary'), model: a.model === undefined ? undefined : text(a.model, 'agent.model', 200), enable_patch };
  });
  if (new Set(agents.map(a => a.id)).size !== agents.length) throw new Error('Agent IDs must be unique');
  if (!Array.isArray(raw.projects) || raw.projects.length < 1 || raw.projects.length > 512) throw new Error('projects requires 1–512 entries');
  const projects: ProjectConfig[] = raw.projects.map((entry, index) => {
    const p = record(entry, `projects[${index}]`);
    const scope = text(p.scope, 'project.scope', 100);
    if (!/^[a-z][a-z0-9:_/.-]*$/u.test(scope)) throw new Error('Invalid project scope');
    if (!Array.isArray(p.agents) || p.agents.length < 1 || p.agents.some(a => typeof a !== 'string' || !agents.some(agent => agent.id === a))) throw new Error('project.agents must reference configured agent IDs');
    let checks:ProjectConfig['checks'];
    if (p.checks !== undefined) {
      const configured = record(p.checks,'project.checks'); checks = {};
      for (const [kind,value] of Object.entries(configured)) {
        if (kind!=='tests_pass' && kind!=='build_passes') throw new Error('Only tests_pass/build_passes commands are configurable');
        const c = record(value,`checks.${kind}`);
        if (Object.keys(c).some(k => !['command','args','timeout_seconds'].includes(k))) throw new Error('Unknown check command setting');
        if (!Array.isArray(c.args) || c.args.length>30 || c.args.some(a => typeof a!=='string' || a.length>2048 || /[\x00-\x1f]/u.test(a))) throw new Error('check args must be a bounded string array');
        checks[kind] = {command:absolute(c.command,'check.command'),args:c.args as string[],timeout_seconds:integer(c.timeout_seconds,600,'check.timeout_seconds',1,7200)};
      }
    }
    return { scope, root: absolute(p.root, 'project.root'), agents: [...new Set(p.agents as string[])], allow_patch: bool(p.allow_patch, 'project.allow_patch'), ...(checks ? {checks} : {}) };
  });
  if (new Set(projects.map(p => p.scope)).size !== projects.length) throw new Error('Each scope must have exactly one static project root in this bridge');
  const lease_seconds = integer(raw.lease_seconds, 120, 'lease_seconds', 30, 300);
  const heartbeat_seconds = integer(raw.heartbeat_seconds, 20, 'heartbeat_seconds', 2, 120);
  const request_timeout_ms = integer(raw.request_timeout_ms, 10000, 'request_timeout_ms', 1000, 30000);
  if (heartbeat_seconds * 3 > lease_seconds || request_timeout_ms / 1000 + heartbeat_seconds * 2 >= lease_seconds) throw new Error('Lease must leave time for heartbeat, request timeout and process termination');
  let reason: BridgeConfig['reason'];
  if (raw.reason !== undefined && raw.reason !== null) {
    const r = record(raw.reason, 'reason');
    const recipient = text(r.recipient, 'reason.recipient', 200);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(recipient)) throw new Error('reason.recipient must name one person/session; broadcasts are not supported');
    reason = { binary: absolute(r.binary, 'reason.binary'), recipient, cwd: absolute(r.cwd, 'reason.cwd') };
  }
  return {
    service_url: serviceUrl(raw.service_url), token_env, agents,
    token_file: raw.token_file === undefined ? undefined : absolute(raw.token_file, 'token_file'), projects, reason,
    poll_seconds: integer(raw.poll_seconds, 5, 'poll_seconds', 1, 300),
    usage_seconds: integer(raw.usage_seconds, 300, 'usage_seconds', 0, 3600),
    lease_seconds, heartbeat_seconds, request_timeout_ms,
    task_timeout_seconds: integer(raw.task_timeout_seconds, 3600, 'task_timeout_seconds', 10, 7200),
    max_concurrent: integer(raw.max_concurrent, 10, 'max_concurrent', 1, 16),
    max_output_bytes: integer(raw.max_output_bytes, 4 * 1024 * 1024, 'max_output_bytes', 4096, 8 * 1024 * 1024),
    max_prompt_bytes: integer(raw.max_prompt_bytes, 128 * 1024, 'max_prompt_bytes', 4096, 512 * 1024)
  };
}

/** Reads an owner-only JSON credential file, as written by `npm run admin -- create --out`. */
export async function readTokenFile(filename: string): Promise<string> {
  const info = await stat(filename);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('token_file must be a small regular file');
  if (info.mode & 0o077) throw new Error('token_file must not be readable by group or others (chmod 600)');
  const token = (JSON.parse(await readFile(filename, 'utf8')) as { token?: unknown }).token;
  if (typeof token !== 'string' || !token) throw new Error('token_file does not contain a token');
  return token;
}

export async function loadBridgeConfig(filename: string): Promise<BridgeConfig> {
  const info = await stat(filename);
  if (info.size > 64 * 1024) throw new Error('Bridge config is too large');
  const config = parseBridgeConfig(JSON.parse(await readFile(filename, 'utf8')) as unknown);
  for (const project of config.projects) {
    project.root = await realpath(project.root);
    if (!(await stat(project.root)).isDirectory()) throw new Error('Project root is not a directory');
    for (const command of Object.values(project.checks ?? {})) await access(command.command,constants.X_OK);
  }
  for (const agent of config.agents) {
    agent.binary = await realpath(agent.binary);
    if (!(await stat(agent.binary)).isFile()) throw new Error('Agent binary is not a file');
    await access(agent.binary, constants.X_OK);
  }
  if (config.reason) {
    config.reason.binary = await realpath(config.reason.binary);
    await access(config.reason.binary, constants.X_OK);
    config.reason.cwd = await realpath(config.reason.cwd);
  }
  return config;
}
