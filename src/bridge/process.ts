import { spawn } from 'node:child_process';
import type { ProcessRequest, ProcessResult } from './types.js';

/** No shell; a fixed executable + argv. POSIX process groups terminate descendants too. */
export async function runBoundedProcess(request: ProcessRequest): Promise<ProcessResult> {
  const started = Date.now();
  if (request.signal?.aborted) return { exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0, stop_reason: 'aborted' };
  return new Promise(resolve => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
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
      if (available) destination.push(chunk.subarray(0, available));
      bytes += chunk.byteLength;
      request.on_progress?.({ output_bytes: bytes, stdout_tail: Buffer.concat(output).subarray(-8192).toString('utf8') });
      if (bytes > request.max_output_bytes) stop('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    child.once('error', () => { stopReason = 'spawn_error'; finish(null, null); });
    child.once('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* EPIPE when provider exits early is reflected by exit status. */ });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stdin.end(request.input, 'utf8');
  });
}
