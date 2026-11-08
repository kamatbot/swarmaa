import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectWindow, type ThreadMessage } from './adapters.js';
import type { Task } from './types.js';

const run = promisify(execFile);

type Evidence = { path: string; commit: string };
type Memory = { id?: string; key?: string; version?: number; included_reason?: string; content_truncated?: boolean;
  source?: { evidence?: Evidence[] } | null; validity?: string };
type Context = { memories?: Memory[]; lessons?: Array<{ id?: string; title?: string }>; omitted?: unknown[];
  task?: { thread_messages?: ThreadMessage[] } } | null;

/** Blob id of path at rev, null when the file (or the rev) does not exist there. */
async function blob(root: string, rev: string, path: string): Promise<string | null> {
  try { return (await run('git', ['-C', root, 'rev-parse', '--verify', '-q', `${rev}:${path}`], { timeout: 10_000 })).stdout.trim() || null; }
  catch { return null; }
}

/**
 * Label each memory that names repository evidence: current when every file is unchanged between the commit it was
 * checked at and base, source_changed when one differs, source_missing when one is gone at base, unverified when the
 * pinned commit is not in this checkout. File-level and conservative: an unchanged file stays current at a new commit.
 * The label goes into the prompt so the agent verifies before relying on a changed memory.
 */
export async function annotateEvidence(context: unknown, root: string, base: string): Promise<void> {
  if (!base || base.startsWith('-') || /[\x00-\x20:]/u.test(base)) base = 'HEAD';
  for (const m of (context as Context)?.memories ?? []) {
    const evidence = m.source?.evidence;
    if (!Array.isArray(evidence) || !evidence.length) continue;
    let state = 'current';
    for (const e of evidence.slice(0, 8)) {
      const [then, now] = await Promise.all([blob(root, e.commit, e.path), blob(root, base, e.path)]);
      const s = then === null ? 'unverified' : now === null ? 'source_missing' : then !== now ? 'source_changed' : 'current';
      if (s === 'source_missing' || (s === 'source_changed' && state !== 'source_missing') || (s === 'unverified' && state === 'current')) state = s;
    }
    m.validity = state;
    if (state === 'source_changed' || state === 'source_missing') (m as Record<string, unknown>).validity_note = 'A file this memory relies on changed since it was recorded; verify against the current code before relying on it.';
  }
}

const swarmCard = /^Swarm "(.+?)" \(id [^)]+\) is (\w+)/u;

/** What reached the model: hash and size of the exact prompt, and which memories, lessons and thread messages it held. */
export function contextReceipt(task: Task, context: unknown, prompt: string | undefined, limitBytes: number, baseRef: string | null): Record<string, unknown> {
  const ctx = context as Context;
  const text = prompt ?? '';
  const promptBytes = Buffer.byteLength(text, 'utf8');
  const items: Record<string, unknown>[] = [];
  // Turns render only the thread (memories are not part of a turn prompt), so only plain tasks list them.
  if (task.kind !== 'turn') {
    for (const m of ctx?.memories ?? []) items.push({ kind: 'memory', id: m.id, key: m.key, version: m.version, reason: m.included_reason ?? 'recent',
      validity: m.validity ?? 'unverified', truncated: Boolean(m.content_truncated), ...(m.source?.evidence?.length ? { evidence: m.source.evidence } : {}) });
    for (const l of ctx?.lessons ?? []) items.push({ kind: 'lesson', id: l.id, title: l.title, reason: 'lesson_match' });
  } else {
    const messages: ThreadMessage[] = (task as unknown as { thread_messages?: ThreadMessage[] }).thread_messages ?? ctx?.task?.thread_messages ?? [];
    const window = selectWindow(messages);
    if (window.length) items.push({ kind: 'thread', first_seq: Number(window[0]!.seq), last_seq: Number(window.at(-1)!.seq), count: window.length });
    const seen = new Set<string>();
    for (const msg of window) {
      const id = (msg as unknown as { ref?: { swarm_id?: string } }).ref?.swarm_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const card = swarmCard.exec(msg.body ?? '');
      items.push({ kind: 'swarm', id, ...(card ? { title: card[1], status: card[2] } : {}) });
    }
  }
  return {
    prompt_sha256: createHash('sha256').update(text).digest('hex'), prompt_bytes: promptBytes,
    estimated_tokens: Math.ceil(promptBytes / 4), limit_bytes: limitBytes, base_ref: baseRef,
    items, omitted: task.kind !== 'turn' ? (ctx?.omitted ?? []) : []
  };
}
