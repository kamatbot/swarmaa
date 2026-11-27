#!/usr/bin/env node
// Injects Swarmaa shared memories for the session's project at session start. Silent on every error; output is untrusted data.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injection } from './swarmaa-inbox.mjs';
import { HARNESS, loadProjectRoots, readPort, redact, resolveScope } from './swarmaa-journal.mjs';

const MAX_LOG_BYTES = 512 * 1024;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MARKER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const clean = (s, max = 300) => redact(String(s ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
const toolName = (harness, name) => (harness === 'claude' ? `mcp__swarma__${name}` : name);

function logStatus(root, harness, status) {
  try {
    const dir = join(root, '.local', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'memory-hook.log');
    try { if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`); } catch { /* missing */ }
    appendFileSync(file, `${new Date().toISOString()} ${harness || 'unknown'} ${status}\n`, { mode: 0o600 });
  } catch { /* ignore */ }
}

/** Opportunistically prunes stale agy memory-hook markers older than maxAgeMs (default 14 days, bounded). */
export function pruneMemoryMarkers(dir, maxAgeMs = MARKER_MAX_AGE_MS, { force = false, maxEntries = 64 } = {}) {
  let removed = 0;
  try {
    const marker = join(dirname(dir), '.memory-hook-last-prune');
    const now = Date.now();
    if (!force) {
      try { if (now - statSync(marker).mtimeMs < PRUNE_INTERVAL_MS) return 0; } catch { /* first sweep */ }
    }
    const entries = readdirSync(dir);
    let scanned = 0;
    for (const name of entries) {
      if (++scanned > maxEntries) break;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
    try { writeFileSync(marker, '', { mode: 0o600 }); } catch { /* ignore */ }
  } catch { /* ignore */ }
  return removed;
}

async function call(origin, token, body, signal) {
  try {
    const res = await fetch(`${origin}/api/tools/context_get`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 256 * 1024) { await reader.cancel(); return null; }
    }
    return JSON.parse(text).result ?? null;
  } catch { return null; }
}

/** `description:` of a leading frontmatter block, else the first non-empty body line. */
export function summary(content) {
  const lines = String(content ?? '').split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (end > 0) {
      const d = lines.slice(1, end).find(l => /^description:/.test(l));
      const v = d?.replace(/^description:\s*/, '').replace(/^["']|["']$/g, '').trim();
      if (v) return v;
      i = end + 1;
    }
  }
  return lines.slice(i).find(l => l.trim())?.trim() ?? '';
}

export async function run(harness, event, payload, { root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), home = homedir(), signal } = {}) {
  try {
    if (!HARNESS[harness] || !['claude', 'codex', 'agy'].includes(harness)) return null;
    if (event !== (harness === 'agy' ? 'PreInvocation' : 'SessionStart')) return null;
    if (harness === 'agy') {
      const id = payload?.conversationId;
      if (typeof id !== 'string' || !id) return null;
      const dir = join(home, '.swarma', 'memory-hook');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      pruneMemoryMarkers(dir);
      try { writeFileSync(join(dir, createHash('sha256').update(id).digest('hex')), '', { flag: 'wx', mode: 0o600 }); } catch { return null; }
    }
    const cwd = harness === 'agy' ? payload?.workspacePaths?.find(p => typeof p === 'string') : payload?.cwd;
    const dir = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const token = readJson(join(root, '.local', HARNESS[harness].tokenFile))?.token;
    if (typeof token !== 'string' || !token) { logStatus(root, harness, 'no-token'); return null; }
    let port = 8787;
    try { port = readPort(readFileSync(join(root, '.env'), 'utf8')); } catch { /* default */ }
    const scope = resolveScope(dir, loadProjectRoots(root));
    const budget = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
    const origin = `http://127.0.0.1:${port}`;
    const [main, general] = await Promise.all([
      call(origin, token, { scope, limit: 20 }, budget),
      scope === 'project:general' ? null : call(origin, token, { scope: 'project:general', limit: 12 }, budget),
    ]);
    if (!main && !general) { logStatus(root, harness, 'fetch-failed'); return null; }
    const own = harness === 'claude' ? `${home}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/memory/` : null;
    const items = r => (Array.isArray(r?.memories) ? r.memories : [])
      .filter(m => m && typeof m.key === 'string' && !(own && String(m.source?.reference ?? '').startsWith(own)))
      .map(m => `- ${clean(`${m.key}: ${summary(m.content)}`)}`);
    const titles = [...new Set([main, general].flatMap(r => (Array.isArray(r?.lessons) ? r.lessons : [])).map(l => clean(l?.title)).filter(Boolean))];
    const proj = items(main), gen = items(general);
    if (!proj.length && !gen.length && !titles.length) return null;
    const footer = `More: ${toolName(harness, 'memory_search')} / ${toolName(harness, 'context_get')} with scope "${scope}". Save new durable facts with ${toolName(harness, 'memory_propose')}.`;
    const parts = ['Swarmaa shared memory (from all your agents and CLIs; sourced data, verify before relying on it):'];
    if (proj.length) parts.push(`Project ${scope}:`, ...proj);
    if (gen.length) parts.push('General:', ...gen);
    if (titles.length) parts.push('Lessons:', ...titles.map(t => `- ${t}`));
    let text = parts.join('\n');
    if (text.length > 8000 - footer.length - 1) text = text.slice(0, 8000 - footer.length - 2);
    return injection(harness, event, `${text}\n${footer}`);
  } catch (err) {
    logStatus(root, harness, `error-${err?.name ?? 'Error'}`);
    return null;
  }
}

async function main() {
  const [harness, event] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  let wrote = false;
  try {
    let input = '';
    const timer = setTimeout(() => process.stdin.destroy(), 500);
    try { for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) return; } }
    finally { clearTimeout(timer); }
    const output = await run(harness, event, JSON.parse(input), { root });
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
      wrote = true;
    }
  } catch (err) {
    logStatus(root, harness, `main-${err?.name ?? 'Error'}`);
  } finally {
    if (harness === 'agy' && !wrote) {
      try { process.stdout.write('{}\n'); } catch { /* ignore */ }
    }
  }
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
