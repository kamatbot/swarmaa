// Frozen shared contract for the ring voice agent (docs/RING-AGENT.md §8.1). Do not change without updating the doc.

export type LocalAction =
  | { type: 'reminder.create'; title: string; due_at?: string; notes?: string; list?: 'default' | 'todo' }
  | { type: 'event.create'; title: string; start_at: string; end_at: string; all_day?: boolean; location?: string; notes?: string }
  | { type: 'note.append'; text: string; notebook?: 'daily' | 'inbox' | 'meetings'; title?: string }
  | { type: 'timer.start'; label: string; fire_at: string }; // all times ISO 8601 UTC

export type LocalActionType = LocalAction['type'];
export type AssistantHint = 'freeform' | 'multi' | 'unparsed_time' | 'meeting' | 'no_transcript';

export type Intent =
  | { route: 'local'; action: LocalAction }
  | { route: 'delegate'; bot_id: string; body: string }
  | { route: 'assistant'; hint: AssistantHint };

export interface IntentInput {
  transcript: string;
  spokenAt: Date;
  timeZone: string;
  durationSeconds?: number;
  bots: { id: string; name: string }[];
}

export type LocalActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'undone';
export type LocalActionCode = 'permission_denied' | 'action_disabled' | 'timeout' | 'unavailable' | 'failed';

export interface LocalActionResult { ok: boolean; code?: LocalActionCode; handle?: string; summary: string }

export type LocalApp = 'reminders' | 'calendar' | 'notes';
export type LocalAppState = 'ok' | 'permission_denied' | 'disabled';

/** Optional per-run hints (additive, latency review F7/F18). */
export interface LocalActionRunOptions {
  /** First attempt of a freshly claimed row: no earlier run can have created the item, so the marker lookup is skipped. */
  fresh?: boolean;
  /** IANA zone for the card summary (the memo's phone zone); default is the runner's zone. */
  timeZone?: string;
}

export interface LocalActionRunner {
  run(id: string, action: LocalAction, opts?: LocalActionRunOptions): Promise<LocalActionResult>;
  undo(id: string, action: LocalAction, handle: string): Promise<LocalActionResult>;
  check(): Promise<Record<LocalApp, LocalAppState>>;
  /** Best effort: start the action helper and launch apps whose last check or run was ok. Never throws. */
  warm?(): Promise<void>;
}

export interface LocalActionRunnerOptions {
  exec?: (script: string, stdin: string) => Promise<{ stdout: string; code: number }>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Bounds for transcript-derived text (docs/RING-AGENT.md §7). */
export const LIMITS = { title: 200, notes: 4000, text: 16384 } as const;
