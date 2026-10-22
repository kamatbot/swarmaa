// Shared shapes for the poll-based chat capture (scripts/capture.ts). One module per source implements Source.
export type Role = 'user' | 'assistant';
export interface Turn { role: Role; text: string; at?: string }

/** One session whose stored content changed since the last successful send. */
export interface SessionUpdate {
  /** Native session id sent as session_id. */
  id: string;
  /** Key in the per-source state file (unique within the source). */
  key: string;
  /** Cursor stored under `key` once the session was sent (or had nothing to send). */
  sig: Record<string, unknown>;
  title?: string;
  cwd?: string;
  turns: Turn[];
  updatedMs: number;
}

export type SessionSigs = Record<string, Record<string, unknown>>;
export interface SourceState { version: 1; sessions: SessionSigs }

export interface Where { home: string; env: NodeJS.ProcessEnv }
export interface ScanCtx extends Where {
  now: number;
  /** First-run window: sessions without a stored cursor must have been updated at or after this. */
  sinceMs: number;
  sessions: SessionSigs;
  expired: () => boolean;
  /** Records a recoverable per-part failure (status words only). */
  fail: (err: unknown) => void;
}
export interface ScanResult { found: number; updates: SessionUpdate[] }

export interface Source {
  id: string;
  /** session_record harness value. */
  harness: string;
  label: string;
  exists: (w: Where) => boolean;
  scan: (ctx: ScanCtx) => ScanResult;
}
