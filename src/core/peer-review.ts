// Peer review of an interactive turn: another agent reads one turn's diff and the owner decides what to do with it.
// The review hook (clients/hooks/swarmaa-review.mjs) submits a review task with resource_key `peer-review:<session>`;
// this module turns the reviewer's answer into the notice that reaches the reviewed session's inbox.

export const PEER_REVIEW_RESOURCE = 'peer-review:';
export const SEVERITIES = ['Important', 'Worth fixing', 'Small detail'] as const;
export type Severity = typeof SEVERITIES[number];
export type ReviewVerdict = 'complete' | 'fix' | 'decision' | 'unclear';
export interface ParsedReview { verdict: ReviewVerdict; findings: { severity: Severity; text: string }[]; notes: string[]; question: string | null }

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' };
export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Reads the reply format the review objective asks for:
 *   VERDICT: complete | fix | decision
 *   - [Important|Worth fixing|Small detail] finding
 *   - [Note] something that does not need a change
 *   QUESTION: what the owner must decide
 * Anything else is "unclear": nothing is decided and the owner should read the full review.
 */
export function parseReview(answer: unknown): ParsedReview {
  const text = typeof answer === 'string' ? answer : '';
  const empty: ParsedReview = { verdict: 'unclear', findings: [], notes: [], question: null };
  const m = text.match(/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(?:\*\*)?\s*(complete|fix|decision)\b/im);
  if (!m) return empty;
  const findings: ParsedReview['findings'] = [], notes: string[] = [];
  let question: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const q = raw.match(/^\s*(?:\*\*)?QUESTION(?:\*\*)?\s*:\s*(.+)$/i);
    if (q) { question ??= oneLine(q[1]!, 400); continue; }
    const f = raw.match(/^\s*(?:[-*•]|\d+[.)])\s*\[(important|worth fixing|small detail|note)\]\s*(.+)$/i);
    if (!f) continue;
    const tag = f[1]!.toLowerCase(), body = oneLine(f[2]!, 400);
    if (!body) continue;
    if (tag === 'note') notes.push(body);
    else findings.push({ severity: SEVERITIES.find(s => s.toLowerCase() === tag)!, text: body });
  }
  let verdict = m[1]!.toLowerCase() as ReviewVerdict;
  // The label must match what the owner sees: "fix" with no findings is not a list of things to fix.
  if (verdict === 'fix' && !findings.length) verdict = 'unclear';
  if (verdict === 'decision' && !question && !findings.length) verdict = 'unclear';
  return { verdict, findings, notes, question };
}

/** The status line, as the owner reads it. */
export function reviewHeadline(review: ParsedReview): string {
  if (review.verdict === 'complete') return 'Review complete';
  if (review.verdict === 'decision') return 'Your decision needed';
  if (review.verdict === 'unclear') return 'Review needs a closer look';
  const n = review.findings.length;
  const counts = SEVERITIES.map(s => [s, review.findings.filter(f => f.severity === s).length] as const).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`);
  return `${n} thing${n === 1 ? '' : 's'} to fix (${counts.join(', ')})`;
}

const SHOW_AND_WAIT = 'Show the user this review as written, then stop. Change nothing unless they ask you to fix the findings.';

/** Inbox body for a finished peer-review task. Capped at 2000 characters like every inbox body. */
export function peerReviewNotice(task: { id: string; status: string }, provider: string, answer: unknown, failure?: { code?: string } | null): string {
  const who = providerName(provider);
  const tail = ` Full review: task_get ${task.id}.`;
  if (task.status !== 'completed') {
    const why = failure?.code ? ` (${failure.code})` : task.status === 'cancelled' ? ' (cancelled)' : '';
    return `Review did not finish${why}: the change from your last turn was not reviewed. The user can type /swarm review again to retry.${tail}`.slice(0, 2000);
  }
  const review = parseReview(answer);
  const head = `Peer review of your last turn by ${who}: ${reviewHeadline(review)}.`;
  if (review.verdict === 'unclear') return `${head} The reply could not be read as a verdict, so nothing was decided. Tell the user to read the full review.${tail}`.slice(0, 2000);
  const lines = [
    ...SEVERITIES.flatMap(s => review.findings.filter(f => f.severity === s).map(f => `- [${s}] ${f.text}`)),
    ...(review.question ? [`- Question for you: ${review.question}`] : []),
    ...review.notes.slice(0, 3).map(n => `- Note: ${n}`),
  ];
  const ask = review.verdict === 'complete' ? 'Show the user this result in one line; there is nothing to change.' : SHOW_AND_WAIT;
  const budget = 2000 - head.length - ask.length - tail.length - 4;
  let list = '';
  for (const l of lines) { if (list.length + l.length + 1 > budget) { list += '\n- …more in the full review'; break; } list += `\n${l}`; }
  return `${head}${list}\n${ask}${tail}`.slice(0, 2000);
}

/** Inbox body for a finished handoff task: the original session learns where its work went. */
export function handoffNotice(task: { id: string; status: string }, provider: string, answer: unknown, result: Record<string, unknown>): string {
  const who = providerName(provider);
  const branch = typeof result.branch === 'string' ? ` Its changes are on local branch ${result.branch}.` : '';
  const resume = typeof (result.native_session as { resume?: unknown } | undefined)?.resume === 'string' ? ` Continue there: ${(result.native_session as { resume: string }).resume}.` : '';
  const summary = typeof answer === 'string' ? oneLine(answer, 600) : '';
  const verb = task.status === 'completed' ? `picked up your conversation and finished` : `picked up your conversation and ended as ${task.status}`;
  return `${who} ${verb} while this session was out of usage.${summary ? ` Its answer: ${summary}` : ''}${branch}${resume} Show the user this before continuing. Full result: task_get ${task.id}.`.slice(0, 2000);
}
export const HANDOFF_RESOURCE = 'handoff:';
