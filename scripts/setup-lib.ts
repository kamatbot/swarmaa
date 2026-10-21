// Pure helpers for scripts/setup.ts. No side effects at import.
import { basename } from 'node:path';

export interface ScopeRoot { scope: string; root: string }

export const AGY_TOOLS = ['artifact_get', 'context_get', 'events_poll', 'memory_get', 'memory_propose', 'memory_search', 'task_cancel', 'task_continue', 'task_get', 'task_list', 'task_submit'];

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
export function slugScopes(paths: string[], taken: string[] = []): ScopeRoot[] {
  const used = new Set(taken);
  const seenRoots = new Set<string>();
  const out: ScopeRoot[] = [];
  for (const root of paths) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const base = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.push({ scope: `project:${slug}`, root });
  }
  return out;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface PlistOptions { workingDirectory?: string; env?: Record<string, string>; stdout?: string; stderr?: string }

export function plist(label: string, programArguments: string[], opts: PlistOptions = {}): string {
  const str = (k: string, v: string) => `\t<key>${xml(k)}</key>\n\t<string>${xml(v)}</string>\n`;
  const flag = (k: string) => `\t<key>${k}</key>\n\t<true/>\n`;
  const env = Object.entries(opts.env ?? {}).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>\n`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n'
    + str('Label', label)
    + `\t<key>ProgramArguments</key>\n\t<array>\n${programArguments.map(a => `\t\t<string>${xml(a)}</string>\n`).join('')}\t</array>\n`
    + (opts.workingDirectory ? str('WorkingDirectory', opts.workingDirectory) : '')
    + (env ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${env}\t</dict>\n` : '')
    + flag('RunAtLoad') + flag('KeepAlive')
    + '\t<key>ThrottleInterval</key>\n\t<integer>10</integer>\n'
    + str('ProcessType', 'Background')
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
  agent: { id: string; binary: string; model?: string };
  projects: ScopeRoot[];
}

export function bridgeConfig({ port, tokenFile, agent, projects }: BridgeConfigInput): Record<string, unknown> {
  return {
    service_url: `http://127.0.0.1:${port}`,
    token_file: tokenFile,
    poll_seconds: 3, lease_seconds: 120, heartbeat_seconds: 20, request_timeout_ms: 10000,
    task_timeout_seconds: 900, max_output_bytes: 131072, max_prompt_bytes: 131072,
    agents: [{ id: agent.id, provider: agent.id, binary: agent.binary, ...(agent.model ? { model: agent.model } : {}), enable_patch: false }],
    projects: projects.map(p => ({ scope: p.scope, root: p.root, agents: [agent.id], allow_patch: false })),
    reason: null,
  };
}
