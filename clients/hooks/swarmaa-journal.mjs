#!/usr/bin/env node
// Chat journal hook: records the latest window of a Claude Code / Codex / Antigravity / Kiro / Windsurf / Qwen chat into the local Swarmaa service.
// Usage: node swarmaa-journal.mjs <claude|codex|agy|kiro|windsurf|qwen> [payload-json]
// Never breaks or slows the harness: swallows every error, exits 0, prints nothing (except `{}` for agy, whose hook contract wants JSON).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_TURNS = 40;
export const MAX_TEXT = 8000;
export const MAX_BODY = 120 * 1024; // service limit is 128 KiB; leave headroom
export const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 64 * 1024;

export const HARNESS = {
  claude: { service: 'claude-code', tokenFile: 'claude.json' },
  codex: { service: 'codex', tokenFile: 'codex.json' },
  agy: { service: 'antigravity', tokenFile: 'antigravity.json' },
  kiro: { service: 'kiro', tokenFile: 'kiro.json' },
  windsurf: { service: 'windsurf', tokenFile: 'windsurf.json' }, // also Devin Desktop (same hooks.json)
  qwen: { service: 'other', tokenFile: 'qwen.json' }, // the session_record contract has no qwen value
};
/** Harnesses whose hooks fire once per event (prompt, reply) and so need the rolling per-session cache. */
const EVENT_HARNESSES = ['kiro', 'windsurf', 'qwen'];

// ---------- pure helpers ----------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bcn_[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

export function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');

export function parseJson(text) {
  try { const v = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

/** Claude Code hook stdin (Stop / SessionEnd): session_id, transcript_path, cwd, hook_event_name, last_assistant_message. */
export function parseClaudePayload(p) {
  if (!isObj(p) || !str(p.session_id)) return null;
  return {
    session_id: p.session_id, cwd: str(p.cwd), transcriptPath: str(p.transcript_path),
    ended: p.hook_event_name === 'SessionEnd', lastAssistant: str(p.last_assistant_message),
  };
}

/** Codex notify argv JSON: type agent-turn-complete, thread-id, turn-id, cwd, input-messages, last-assistant-message. */
export function parseCodexPayload(p) {
  if (!isObj(p)) return null;
  const get = (...keys) => { for (const k of keys) if (typeof p[k] === 'string' && p[k]) return p[k]; return ''; };
  const type = get('type');
  if (type && type !== 'agent-turn-complete') return null;
  const session_id = get('thread-id', 'thread_id', 'conversation-id', 'conversation_id', 'session_id');
  if (!session_id) return null;
  const im = p['input-messages'] ?? p.input_messages;
  const inputMessages = (Array.isArray(im) ? im : typeof im === 'string' ? [im] : []).filter(m => typeof m === 'string' && m.trim());
  return {
    session_id, cwd: get('cwd'), turnId: get('turn-id', 'turn_id'), inputMessages,
    lastAssistant: get('last-assistant-message', 'last_assistant_message'), ended: false,
  };
}

/** Antigravity hook stdin (camelCase): conversationId, workspacePaths, transcriptPath, terminationReason. */
export function parseAgyPayload(p) {
  if (!isObj(p) || !str(p.conversationId)) return null;
  const ws = Array.isArray(p.workspacePaths) ? p.workspacePaths.find(w => typeof w === 'string' && w) : '';
  return { session_id: p.conversationId, cwd: ws || '', transcriptPath: str(p.transcriptPath), ended: false };
}

/**
 * Kiro hook stdin (UserPromptSubmit / Stop): session_id, cwd, hook_event_name, prompt, assistant_response (Stop).
 * Adapted from Asymptote Labs agent-beacon (MIT). Kiro feeds hook stdout to the agent, so this hook never prints.
 */
export function parseKiroPayload(p) {
  if (!isObj(p)) return null;
  const get = (...keys) => { for (const k of keys) if (typeof p[k] === 'string' && p[k]) return p[k]; return ''; };
  const cwd = get('cwd', 'workspace_root', 'workspaceRoot');
  const session_id = get('session_id', 'sessionId', 'conversation_id') || (cwd ? `cwd-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}` : '');
  if (!session_id) return null;
  return { session_id, cwd, event: get('hook_event_name'), prompt: get('prompt', 'user_prompt'), reply: get('assistant_response') };
}

/**
 * Windsurf / Devin Desktop hook stdin: agent_action_name pre_user_prompt (tool_info.user_prompt) or post_cascade_response
 * (tool_info.response), trajectory_id as the session. The payload has no cwd, so these chats scope to project:general.
 * Adapted from Asymptote Labs agent-beacon (MIT).
 */
export function parseWindsurfPayload(p) {
  if (!isObj(p)) return null;
  const session_id = str(p.trajectory_id) || str(p.session_id) || str(p.conversation_id);
  if (!session_id) return null;
  const info = isObj(p.tool_info) ? p.tool_info : isObj(p.toolInfo) ? p.toolInfo : {};
  const action = str(p.agent_action_name);
  return { session_id, cwd: '', event: action, prompt: action === 'pre_user_prompt' ? str(info.user_prompt) || str(info.userPrompt) : '', reply: action === 'post_cascade_response' ? str(info.response) : '' };
}

/**
 * Qwen Code hook stdin (Claude-style): session_id, cwd, hook_event_name, prompt (UserPromptSubmit).
 * The reply is read from last_assistant_message / assistant_response when Stop carries one (not documented upstream: unverified).
 */
export function parseQwenPayload(p) {
  if (!isObj(p) || !str(p.session_id)) return null;
  return { session_id: p.session_id, cwd: str(p.cwd), event: str(p.hook_event_name), prompt: str(p.prompt), reply: str(p.last_assistant_message) || str(p.assistant_response) };
}

const WRAPPED_USER = /^\s*<(?:command-name|command-message|local-command-|task-notification|bash-(?:input|stdout|stderr))/;

function cleanUserText(text) {
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || WRAPPED_USER.test(t) || t.startsWith('[Request interrupted')) return '';
  return t;
}

function textOf(content, blockType = 'text') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => isObj(b) && b.type === blockType && typeof b.text === 'string').map(b => b.text).join('\n\n');
}

/** Turns from Claude Code transcript JSONL text (text blocks only; no tool calls/results, thinking, meta, sidechains). */
export function extractClaudeTurns(jsonl) {
  const turns = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const o = parseJson(line);
    if (!o || o.isMeta || o.isSidechain || !isObj(o.message)) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const role = o.type;
    let text = textOf(o.message.content);
    if (role === 'user') text = cleanUserText(text);
    text = text.trim();
    if (!text) continue;
    turns.push({ role, text, ...(typeof o.timestamp === 'string' ? { at: o.timestamp } : {}) });
  }
  return turns;
}

/** Turns from Antigravity transcript JSONL (USER_INPUT steps and PLANNER_RESPONSE steps with text content). */
export function extractAgyTurns(jsonl) {
  const turns = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const o = parseJson(line);
    if (!o || typeof o.content !== 'string') continue;
    let role = '';
    let text = o.content;
    if (o.type === 'USER_INPUT') {
      role = 'user';
      const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      text = m ? m[1] : text.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, '');
    } else if (o.type === 'PLANNER_RESPONSE' && o.source === 'MODEL') role = 'assistant';
    else continue;
    text = text.trim();
    if (!text) continue;
    turns.push({ role, text, ...(typeof o.created_at === 'string' ? { at: o.created_at } : {}) });
  }
  return turns;
}

export function firstUserPrompt(turns) {
  return turns.find(t => t.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? '';
}

/** projects: [{scope, root}]. Longest path-prefix match on a directory boundary, else project:general. */
export function resolveScope(cwd, projects) {
  const norm = p => String(p).replace(/\/+$/, '') || '/';
  const c = norm(cwd || '');
  let best = null;
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!isObj(p) || typeof p.scope !== 'string' || typeof p.root !== 'string' || !p.root) continue;
    const r = norm(p.root);
    if (c === r || c.startsWith(r === '/' ? '/' : r + '/')) if (!best || r.length > best.len) best = { scope: p.scope, len: r.length };
  }
  return best ? best.scope : 'project:general';
}

/** Rolling per-session cache for harnesses that only report the latest turn (Codex). Same turn id replaces; max 40. */
export function mergeCodexCache(cache, parsed, now = new Date().toISOString()) {
  const prev = isObj(cache) && Array.isArray(cache.turns) ? cache.turns.filter(t => isObj(t) && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string') : [];
  const turn = parsed.turnId || '';
  let turns = turn ? prev.filter(t => t.turn !== turn) : prev;
  const add = (role, text) => { if (text && text.trim()) turns.push({ role, text, at: now, ...(turn ? { turn } : {}) }); };
  for (const m of parsed.inputMessages ?? []) add('user', m);
  add('assistant', parsed.lastAssistant);
  turns = turns.slice(-MAX_TURNS);
  const title = (isObj(cache) && typeof cache.title === 'string' && cache.title) || firstUserPrompt(turns);
  return { session_id: parsed.session_id, title, turns };
}

/** Rolling cache for per-event hooks (Kiro, Windsurf, Qwen): one prompt or one reply per call. Identical consecutive turns are retries. */
export function mergeEventCache(cache, parsed, now = new Date().toISOString()) {
  const prev = isObj(cache) && Array.isArray(cache.turns) ? cache.turns.filter(t => isObj(t) && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string') : [];
  const turns = prev.slice();
  const add = (role, text) => {
    const t = text.trim();
    if (!t) return;
    const last = turns.at(-1);
    if (last && last.role === role && last.text === t) return;
    turns.push({ role, text: t, at: now });
  };
  add('user', parsed.prompt ?? '');
  add('assistant', parsed.reply ?? '');
  const kept = turns.slice(-MAX_TURNS);
  const title = (isObj(cache) && typeof cache.title === 'string' && cache.title) || firstUserPrompt(kept);
  const cwd = parsed.cwd || (isObj(cache) && typeof cache.cwd === 'string' ? cache.cwd : '');
  return { session_id: parsed.session_id, title, cwd, turns: kept };
}

/** Builds the session_record body: redacted, clipped, <=40 turns, <=MAX_BODY bytes (drops oldest turns first). */
export function buildBody({ harness, session_id, scope, title, cwd, turns, ended }) {
  const cleaned = turns.slice(-MAX_TURNS).map(t => ({
    role: t.role, text: clip(redact(t.text), MAX_TEXT), ...(t.at ? { at: t.at } : {}),
  })).filter(t => t.text.trim());
  const body = {
    harness: HARNESS[harness].service, session_id: clip(session_id, 200), scope,
    ...(title ? { title: clip(redact(title).replace(/\s+/g, ' ').trim(), 120) } : {}),
    ...(cwd ? { cwd: clip(cwd, 1024) } : {}),
    turns: cleaned, ended: Boolean(ended),
  };
  while (body.turns.length > 1 && Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) body.turns.shift();
  return body;
}

export function readPort(envText) {
  for (const raw of String(envText ?? '').split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*$/);
    if (m) return Number(m[1]);
  }
  return 8787;
}

export function cacheFile(root, harness, session) {
  return join(root, '.local', 'journal', `${harness}-${createHash('sha256').update(session).digest('hex')}.json`);
}

// ---------- IO ----------

async function readParts(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead).toString('utf8'); };
    if (size <= TAIL_BYTES) { const all = await read(0, size); return { head: all, tail: all }; }
    let tail = await read(size - TAIL_BYTES, TAIL_BYTES);
    tail = tail.slice(tail.indexOf('\n') + 1); // first line is partial
    return { head: await read(0, HEAD_BYTES), tail };
  } finally { await fh.close(); }
}

function readJsonFile(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }

function log(root, harness, msg) {
  try {
    const dir = join(root, '.local', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'journal.log'), `${new Date().toISOString()} ${harness} ${msg}\n`, { mode: 0o600 });
  } catch { /* ignore */ }
}

async function readStdin(ms = 1000) {
  if (process.stdin.isTTY) return '';
  return await new Promise(res => {
    let data = '';
    const done = () => { clearTimeout(t); res(data); };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

export async function run(harness, argvPayload, stdinText, root) {
  if (!HARNESS[harness]) return 'bad-harness';
  const raw = argvPayload || stdinText || '';
  const payload = parseJson(raw);
  if (!payload) return 'no-payload';
  let session_id, cwd, turns, title = '', ended = false;

  if (EVENT_HARNESSES.includes(harness)) {
    const p = { kiro: parseKiroPayload, windsurf: parseWindsurfPayload, qwen: parseQwenPayload }[harness](payload);
    if (!p) return 'ignored-payload';
    if (!p.prompt && !p.reply) return 'no-turns';
    const file = cacheFile(root, harness, p.session_id);
    const merged = mergeEventCache(readJsonFile(file), p);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(merged), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* ignore */ }
    ({ session_id, turns, title, cwd } = merged);
  } else if (harness === 'codex') {
    const p = parseCodexPayload(payload);
    if (!p) return 'ignored-payload';
    const file = cacheFile(root, harness, p.session_id);
    const merged = mergeCodexCache(readJsonFile(file), p);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(merged), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* ignore */ }
    ({ session_id, turns, title } = merged); cwd = p.cwd;
  } else {
    const p = harness === 'claude' ? parseClaudePayload(payload) : parseAgyPayload(payload);
    if (!p) return 'ignored-payload';
    if (!p.transcriptPath) return 'no-transcript';
    const { head, tail } = await readParts(p.transcriptPath);
    const extract = harness === 'claude' ? extractClaudeTurns : extractAgyTurns;
    turns = extract(tail).slice(-MAX_TURNS);
    if (harness === 'claude' && p.lastAssistant && !turns.some(t => t.role === 'assistant' && t.text === p.lastAssistant.trim())) {
      turns = [...turns, { role: 'assistant', text: p.lastAssistant.trim() }].slice(-MAX_TURNS);
    }
    title = firstUserPrompt(extract(head).slice(0, 5)) || firstUserPrompt(turns);
    ({ session_id, cwd, ended } = p);
  }
  if (!turns.length) return 'no-turns';
  if (!title && cwd) title = basename(cwd);

  const token = readJsonFile(join(root, '.local', HARNESS[harness].tokenFile))?.token;
  if (typeof token !== 'string' || !token) return 'no-token';
  let port = 8787;
  try { port = readPort(readFileSync(join(root, '.env'), 'utf8')); } catch { /* default */ }
  const setup = readJsonFile(join(root, '.local', 'setup.json'));
  const scope = resolveScope(cwd, setup?.projects);
  const body = buildBody({ harness, session_id, scope, title, cwd, turns, ended });

  const res = await fetch(`http://127.0.0.1:${port}/api/tools/session_record`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  return res.ok ? 'ok' : `http-${res.status}`;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [harness, ...rest] = process.argv.slice(2);
  setTimeout(() => process.exit(0), 2500).unref(); // hard budget
  let status = 'error';
  try {
    const then = rest.indexOf('--then');
    // Codex chaining: start the notify program this hook replaced, with the payload Codex appended, before our own work.
    if (then !== -1 && rest.length > then + 2) {
      spawn(rest[then + 1], [...rest.slice(then + 2, -1), rest[rest.length - 1]], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
    const argvPayload = rest.length ? rest[rest.length - 1] : '';
    status = await run(harness, argvPayload, argvPayload ? '' : harness === 'codex' ? '' : await readStdin(), root);
  } catch (err) {
    status = `error ${err?.name ?? 'Error'}`; // name only: never message text, which could carry chat content or URLs
  }
  if (status !== 'ok') log(root, harness, status);
  if (harness === 'agy') process.stdout.write('{}\n'); // Antigravity hooks expect a JSON object on stdout
  process.exit(0);
}

const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main().catch(() => process.exit(0));
