import { execFileSync, spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import type { ProcessRequest, ProcessResult } from './types.js';

/** Process start time; with the pid it identifies one process even after the pid is recycled. */
export function processStart(pid: number): string {
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { LC_ALL: 'C' } }).trim(); }
  catch { return ''; }
}

const STDOUT_TAIL_BYTES = 8192;
const LINE_HEAD = 2048;

/** Last `limit` bytes of `tail` plus `chunk`, without copying the earlier transcript. */
export function slideTail(tail: Uint8Array, chunk: Uint8Array, limit = STDOUT_TAIL_BYTES): Uint8Array {
  if (chunk.length === 0) return tail;
  const prev = Buffer.isBuffer(tail) ? tail : Buffer.from(tail);
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const total = prev.length + incoming.length;
  const size = Math.min(limit, total);
  const start = total - size;
  const next = Buffer.allocUnsafe(size);
  if (start < prev.length) {
    const fromTail = prev.length - start;
    prev.copy(next, 0, start, prev.length);
    incoming.copy(next, fromTail);
  } else {
    incoming.copy(next, 0, start - prev.length, start - prev.length + size);
  }
  return next;
}

/** No shell; a fixed executable + argv. POSIX process groups terminate descendants too. */
export async function runBoundedProcess(request: ProcessRequest): Promise<ProcessResult> {
  const started = Date.now();
  if (request.signal?.aborted) return { exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0, stop_reason: 'aborted' };
  return new Promise(resolve => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    if (request.pidfile && child.pid && process.platform !== 'win32') {
      try { writeFileSync(request.pidfile, JSON.stringify({ pid: child.pid, pgid: child.pid, started: processStart(child.pid) }), { mode: 0o600 }); } catch { /* best effort */ }
    }
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let stdoutTail: Uint8Array = Buffer.alloc(0);
    let bytes = 0;
    let stopReason: ProcessResult['stop_reason'] = null;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      request.signal?.removeEventListener('abort', abort);
      // A child could exit while a descendant retained its pipes. Do not leave it behind.
      signalGroup('SIGKILL');
      if (request.pidfile) try { unlinkSync(request.pidfile); } catch { /* absent */ }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      resolve({ exit_code: exitCode, signal, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), duration_ms: Date.now() - started, stop_reason: stopReason });
    };
    const stop = (reason: NonNullable<ProcessResult['stop_reason']>): void => {
      if (stopReason || settled) return;
      stopReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1500);
      finalTimer = setTimeout(() => finish(null, 'SIGKILL'), 3000);
    };
    const abort = (): void => stop('aborted');
    const timeout = setTimeout(() => stop('timeout'), request.timeout_ms);
    const collect = (destination: Buffer[], chunk: Buffer): void => {
      const available = Math.max(0, request.max_output_bytes - bytes);
      const kept = available ? chunk.subarray(0, available) : Buffer.alloc(0);
      if (kept.length) destination.push(kept);
      if (destination === output && kept.length) stdoutTail = slideTail(stdoutTail, kept);
      bytes += chunk.byteLength;
      request.on_progress?.({ output_bytes: bytes, stdout_tail: Buffer.from(stdoutTail).toString('utf8') });
      if (bytes > request.max_output_bytes) stop('output_limit');
    };
    // Line head and tail for on_line: bounded per line, so a huge event never buffers more than 2 x LINE_HEAD.
    // Key order is not fixed (Claude's result event puts "type" near its end), so callers get both ends.
    let lineHead = '';
    let lineTail: Uint8Array = Buffer.alloc(0);
    const lines = (chunk: Buffer): void => {
      let start = 0, newline: number;
      while ((newline = chunk.indexOf(10, start)) >= 0) {
        const piece = chunk.subarray(start, newline);
        if (lineHead.length < LINE_HEAD) lineHead += piece.subarray(0, LINE_HEAD).toString('utf8');
        lineTail = slideTail(lineTail, piece, LINE_HEAD);
        const head = lineHead.slice(0, LINE_HEAD), tail = Buffer.from(lineTail).toString('utf8');
        lineHead = ''; lineTail = Buffer.alloc(0);
        start = newline + 1;
        try { request.on_line!(head, tail); } catch { /* a caller bug must not kill the run */ }
      }
      const rest = chunk.subarray(start);
      if (lineHead.length < LINE_HEAD) lineHead += rest.subarray(0, LINE_HEAD).toString('utf8');
      lineTail = slideTail(lineTail, rest, LINE_HEAD);
    };
    child.stdout.on('data', (chunk: Buffer) => { collect(output, chunk); if (request.on_line) lines(chunk); });
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    child.once('error', () => { stopReason = 'spawn_error'; finish(null, null); });
    child.once('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* EPIPE when provider exits early is reflected by exit status. */ });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    if (!request.keep_stdin_open) { child.stdin.end(request.input, 'utf8'); return; }
    child.stdin.write(request.input, 'utf8');
    const open = (): boolean => !settled && !child.stdin.destroyed && !child.stdin.writableEnded;
    request.on_stdin?.({
      write: text => { if (!open()) return false; child.stdin.write(text, 'utf8'); return true; },
      end: () => { if (open()) child.stdin.end(); }
    });
  });
}
