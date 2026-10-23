import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { clampPct, isObj, isoFromText, num, TIMEOUT_MS, UsageError, type Ctx, type ProviderResult, type UsageWindow } from './types.js';

const run = promisify(execFile);
const RPC = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const CSRF_HEADER = 'x-codeium-csrf-token';

// ---- parser: port of NotchTrader's AntigravityQuotaParser (server reports what is LEFT; we report what is USED) ----
interface Bucket { modelId?: string; bucketId?: string; name?: string; displayName?: string; fraction?: number; used?: number; limit?: number; resetTime?: string; window?: string; disabled?: boolean }
interface Group { displayName?: string; buckets: Bucket[] }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
function bucket(b: unknown): Bucket | null {
  if (!isObj(b)) return null;
  const rem = isObj(b.remaining) ? (num(b.remaining.remainingFraction) ?? (b.remaining.case === 'remainingFraction' ? num(b.remaining.value) : undefined)) : undefined;
  return { modelId: str(b.modelId), bucketId: str(b.bucketId), name: str(b.name), displayName: str(b.displayName), fraction: num(b.remainingFraction) ?? rem, used: num(b.used), limit: num(b.limit), resetTime: str(b.resetTime), window: str(b.window), disabled: b.disabled === true };
}
const buckets = (v: unknown): Bucket[] => (Array.isArray(v) ? v.map(bucket).filter((b): b is Bucket => b !== null) : []);
const groups = (v: unknown): Group[] => (Array.isArray(v) ? v.filter(isObj).map((g) => ({ displayName: str(g.displayName), buckets: buckets(g.buckets) })) : []);

const norm = (s: string) => s.trim().toLowerCase().replace(/_/g, '-');
const groupRank = (n?: string) => { const v = norm(n ?? ''); return v.includes('gemini') ? 0 : v.includes('claude') || v.includes('gpt') ? 1 : 2; };
const cadenceValue = (raw?: string) => { if (!raw) return undefined; const v = norm(raw); return v.endsWith(' limit') ? v.slice(0, -6) : v || undefined; };
const isWeeklyV = (v: string) => v === 'weekly' || v.endsWith('-weekly') || v.endsWith(' weekly');
const isSessionV = (v: string) => ['session', '5h', '5-hour', 'five hour', 'five-hour', 'hourly'].includes(v) || ['-session', '-5h', '-5-hour', '-five-hour', '-hourly'].some((s) => v.endsWith(s));
/** 0 = session/5h, 1 = weekly, 2 = unknown */
function cadence(b: Bucket): number {
  const vs = [b.window, b.bucketId, b.displayName].map(cadenceValue).filter((v): v is string => !!v);
  return vs.some(isWeeklyV) ? 1 : vs.some(isSessionV) ? 0 : 2;
}
const bucketId = (b: Bucket, group?: string) => [b.bucketId, b.modelId, b.name, group].map((v) => v?.trim()).find((v) => !!v) ?? 'quota';
const win = (name: string, usedFrac: number, b: Bucket): UsageWindow => ({ name, used_percent: clampPct(usedFrac * 100), resets_at: isoFromText(b.resetTime) });
const byRank = <T,>(items: T[], rank: (t: T) => number) => items.map((t, i) => [t, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);

function fromBucket(b: Bucket, group?: string): UsageWindow | null {
  if (b.disabled) return null;
  const id = bucketId(b, group);
  if (b.fraction !== undefined && b.fraction >= 0 && b.fraction <= 1) return win(id, 1 - b.fraction, b);
  if (b.limit !== undefined && b.limit > 0 && b.used !== undefined && b.used >= 0 && b.used <= b.limit * 1.5) return win(id, b.used / b.limit, b);
  return null;
}

/** Per-model buckets (direct Cloud Code shape) folded into gemini/3p x hourly/weekly, taking the most-used bucket of each. */
function modelWindows(bs: Bucket[], now: Date): UsageWindow[] {
  const slots: Record<string, { rem: number; reset: string | null }> = {};
  for (const b of bs) {
    if (b.fraction === undefined || b.fraction < 0 || b.fraction > 1) continue;
    const model = norm(bucketId(b));
    if (!model || model.startsWith('chat-')) continue;
    const reset = isoFromText(b.resetTime);
    const weekly = cadence(b) === 1 || (reset !== null && Date.parse(reset) - now.getTime() > 24 * 3600_000);
    const fam = model.includes('gemini') ? 'gemini' : /claude|gpt|openai/.test(model) ? '3p' : null;
    if (!fam) continue;
    const key = `${fam}-${weekly ? 'weekly' : 'hourly'}`;
    if (!slots[key] || b.fraction < slots[key]!.rem) slots[key] = { rem: b.fraction, reset };
  }
  return ['gemini-hourly', 'gemini-weekly', '3p-hourly', '3p-weekly'].filter((k) => slots[k]).map((k) => ({ name: k, used_percent: clampPct((1 - slots[k]!.rem) * 100), resets_at: slots[k]!.reset }));
}

/** Pure: normalise the quota envelopes (local language server `response.groups`, `groups`, `quotaGroups`, legacy `buckets`, direct Cloud Code per-model `buckets`). */
export function parseAntigravityQuota(json: unknown, now: Date = new Date()): UsageWindow[] {
  if (!isObj(json)) return [];
  const gs = [isObj(json.response) ? json.response.groups : undefined, isObj(json.summary) ? json.summary.groups : undefined, json.groups, json.quotaGroups].map(groups).find((g) => g.length) ?? [];
  const seen = new Set<string>();
  const dedupe = (ws: (UsageWindow | null)[]) => ws.filter((w): w is UsageWindow => !!w && !seen.has(w.name) && !!seen.add(w.name));
  if (gs.length) return dedupe(byRank(gs, (g) => groupRank(g.displayName)).flatMap((g) => byRank(g.buckets, cadence).map((b) => fromBucket(b, g.displayName))));
  const bs = buckets(json.buckets);
  if (!bs.length) return [];
  return bs.some((b) => b.limit !== undefined) ? dedupe(bs.map((b) => (b.limit !== undefined && b.limit > 0 && b.used !== undefined && b.used >= 0 && b.used <= b.limit * 1.5 ? win(bucketId(b), b.used / b.limit, b) : null))) : modelWindows(bs, now);
}

// ---- discovery: prefer the IDE or `agy` CLI, otherwise keep a headless server of our own ----
export interface Endpoint { ports: number[]; csrf?: string; pid: number }

const tokenAfter = (flag: string, line: string) => { const p = line.split(/\s+/); const i = p.indexOf(flag); return i >= 0 ? p[i + 1] : undefined; };
const isCli = (line: string) => { const f = line.trim().split(/\s+/); return f.length >= 2 && f[1]!.split('/').pop() === 'agy'; };

/** Pure given `ports`: find the IDE server (needs CSRF token) first, then the `agy` CLI (needs none). */
export async function discoverEndpoint(table: string, ports: (pid: number) => Promise<number[]>): Promise<Endpoint | null> {
  const lines = table.split('\n');
  const ide = lines.find((l) => l.includes('language_server') && l.includes('--csrf_token'));
  const cli = lines.find(isCli);
  for (const [line, csrf] of [[ide, ide && tokenAfter('--csrf_token', ide)], [cli, undefined]] as const) {
    const pid = line ? Number(line.trim().split(/\s+/)[0]) : NaN;
    if (!line || !Number.isInteger(pid) || (line === ide && !csrf)) continue;
    const p = await ports(pid);
    if (p.length) return { ports: p, csrf, pid };
  }
  return null;
}

export const parsePorts = (lsof: string): number[] => lsof.split('\n').map((l) => Number(l.split(/\s+/).filter((f) => f.includes(':')).pop()?.split(':').pop())).filter((n) => Number.isInteger(n) && n > 0);

export interface AntigravityProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error' | 'exit', listener: () => void): unknown;
}

export interface AntigravityIO {
  ps(): Promise<string>;
  ports(pid: number): Promise<number[]>;
  binary(): Promise<string | null>;
  spawn(binary: string, args: string[], options: { detached: false; stdio: 'ignore' }): AntigravityProcess;
  sleep(ms: number): Promise<unknown>;
  now(): number;
  /** POST the quota RPC to one loopback port; returns parsed JSON or throws. */
  post(port: number, csrf: string | undefined): Promise<unknown>;
}

export const realIO: AntigravityIO = {
  ps: async () => (await run('/bin/ps', ['-Ao', 'pid,command'], { maxBuffer: 32 << 20, timeout: TIMEOUT_MS })).stdout,
  async ports(pid) {
    try { return parsePorts((await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 1_000 })).stdout); } catch { return []; }
  },
  async binary() {
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      for (const app of await readdir(dir).catch(() => [])) {
        if (app.toLowerCase() !== 'antigravity.app') continue;
        const binary = join(dir, app, 'Contents/Resources/bin/language_server');
        try { await access(binary, constants.X_OK); return binary; } catch { /* try the next installation */ }
      }
    }
    return null;
  },
  spawn: (binary, args, options) => { const child = spawn(binary, args, options); child.unref(); return child; },
  sleep,
  now: Date.now,
  // The server uses a self-signed cert, so verification is off — for 127.0.0.1 only, never for any other host.
  post: (port, csrf) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ forceRefresh: true });
    const req = request({ host: '127.0.0.1', port, path: RPC, method: 'POST', rejectUnauthorized: false, timeout: TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(csrf ? { [CSRF_HEADER]: csrf } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { try { res.statusCode === 200 ? resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : reject(new Error('status')); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  }),
};

interface State { cached?: Endpoint; owned?: AntigravityProcess; pending?: Promise<ProviderResult> }
const states = new WeakMap<AntigravityIO, State>();
const children = new Set<AntigravityProcess>();
const running = (child: AntigravityProcess) => !!child.pid && child.exitCode === null && child.signalCode === null;
let cleanupInstalled = false;

function own(child: AntigravityProcess) {
  children.add(child);
  child.once('error', () => { if (!running(child)) children.delete(child); });
  child.once('exit', () => children.delete(child));
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const stop = () => { for (const child of children) { try { if (running(child)) child.kill('SIGTERM'); } catch { /* best effort during exit */ } } };
  process.once('exit', stop);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.prependOnceListener(signal, () => {
    stop();
    // Preserve the default signal action when there is no application shutdown handler.
    if (!process.listenerCount(signal)) process.kill(process.pid, signal);
  });
}

async function stopOwned(state: State, io: AntigravityIO) {
  state.cached = undefined;
  if (!state.owned) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!running(state.owned)) break;
    state.owned.kill(signal);
    for (let i = 0; i < 20 && running(state.owned); i++) await io.sleep(50);
  }
  if (running(state.owned)) throw new UsageError('Antigravity quota unavailable');
  children.delete(state.owned);
  state.owned = undefined;
}

async function quota(ctx: Ctx, io: AntigravityIO, ep: Endpoint): Promise<ProviderResult | null> {
  for (const port of ep.ports) {
    try {
      const windows = parseAntigravityQuota(await io.post(port, ep.csrf), ctx.now());
      if (windows.length) return { windows };
    } catch { /* the server opens two ports and only one serves this RPC */ }
  }
  return null;
}

async function probe(ctx: Ctx, io: AntigravityIO, state: State): Promise<ProviderResult> {
  if (state.owned && !running(state.owned)) await stopOwned(state, io);
  if (state.cached) {
    const result = await quota(ctx, io, state.cached);
    if (result) return result;
    const wasOwned = state.cached.pid === state.owned?.pid;
    state.cached = undefined;
    if (wasOwned) { await stopOwned(state, io); throw new UsageError('Antigravity quota unavailable'); }
  }
  // A previous stop must finish before a replacement can start.
  if (state.owned) await stopOwned(state, io);
  let ep: Endpoint | null = null;
  try { ep = await discoverEndpoint(await io.ps(), (pid) => io.ports(pid)); } catch { /* ps/lsof unavailable */ }
  if (ep) {
    const result = await quota(ctx, io, ep);
    if (result) { state.cached = ep; return result; }
    throw new UsageError('Antigravity quota unavailable');
  }
  const binary = await io.binary();
  if (!binary) throw new UsageError('Antigravity is not installed');
  const csrf = randomBytes(32).toString('hex');
  const child = io.spawn(binary, [
    '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
    '--override_user_agent_name', 'antigravity', '--https_server_port', '0', '--csrf_token', csrf,
    '--app_data_dir', 'swarmaa-bridge', '--api_server_url', 'https://generativelanguage.googleapis.com',
    '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
  ], { detached: false, stdio: 'ignore' });
  state.owned = child;
  own(child);
  const deadline = io.now() + 10_000;
  while (running(child) && io.now() < deadline) {
    const ports = await io.ports(child.pid!).catch(() => []);
    ep = { ports, csrf, pid: child.pid! };
    const result = await quota(ctx, io, ep);
    if (result) { state.cached = ep; return result; }
    // Binding precedes authentication; allow both to become ready on the first probe.
    const remaining = deadline - io.now();
    if (remaining > 0) await io.sleep(Math.min(250, remaining));
  }
  await stopOwned(state, io);
  throw new UsageError('Antigravity quota unavailable');
}

export function fetchAntigravity(ctx: Ctx, io: AntigravityIO = realIO): Promise<ProviderResult> {
  let state = states.get(io);
  if (!state) { state = {}; states.set(io, state); }
  if (!state.pending) state.pending = probe(ctx, io, state).catch((error: unknown) => {
    throw error instanceof UsageError ? error : new UsageError('Antigravity quota unavailable');
  }).finally(() => { state.pending = undefined; });
  return state.pending;
}
