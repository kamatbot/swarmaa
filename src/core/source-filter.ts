import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, requireCondition } from '../errors.js';
import { INVISIBLE } from '../safety/lint.js';
import { redactSecrets } from '../safety/redact.js';

export interface SourceRules {
  events: string[];
  allow_authors: string[];
  mention: string;
  candidate_events: string[];
  base_branches: string[];
  ci_conclusions: string[];
  ignore_bots: boolean;
  auto_subscribe_branches: boolean;
}

export const DEFAULT_SOURCE_RULES: SourceRules = {
  events: ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'issues', 'check_suite', 'check_run', 'workflow_run'],
  allow_authors: [],
  mention: '@swarmaa',
  candidate_events: ['issues.opened', 'ci.failure_default_branch'],
  base_branches: ['main'],
  ci_conclusions: ['failure', 'timed_out', 'action_required'],
  ignore_bots: true,
  auto_subscribe_branches: true,
};

export interface NormalizedDigest {
  repo: string;
  event: string;
  action: string | null;
  number: number | null;
  is_pr: boolean;
  title: string | null;
  author_login: string | null;
  author_type: string | null;
  author_association: string | null;
  url: string | null;
  head_ref: string | null;
  head_sha: string | null;
  base_ref: string | null;
  review_state: string | null;
  ci_name: string | null;
  ci_conclusion: string | null;
  body_excerpt: string | null;
  pull_requests: number[];
}

export interface ClassificationResult {
  classification: 'explicit' | 'candidate' | 'ignore';
  reason: string;
}

export interface FilterContext {
  subscribedRefs: Set<string>;
  selfLogins?: Set<string>;
}

const GITHUB_REPO_RE = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;
const GITHUB_REPO_ANYCASE_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const CI_EVENTS = new Set(['check_suite', 'check_run', 'workflow_run']);

function cleanString(text: unknown, maxChars: number): string | null {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(new RegExp(INVISIBLE.source, 'gu'), '');
  const redacted = redactSecrets(stripped);
  return redacted.slice(0, maxChars);
}

function cleanUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('https://github.com/')) return null;
  return url.slice(0, 1024);
}

export function normalizeGithubEvent(eventType: string, payload: Record<string, any>): NormalizedDigest {
  const repo = typeof payload.repository?.full_name === 'string'
    ? payload.repository.full_name.toLowerCase()
    : '';

  const isPr = Boolean(
    payload.pull_request !== undefined ||
    payload.issue?.pull_request !== undefined ||
    ['pull_request', 'pull_request_review', 'pull_request_review_comment'].includes(eventType)
  );

  let num: number | null = null;
  if (typeof payload.pull_request?.number === 'number') num = payload.pull_request.number;
  else if (typeof payload.issue?.number === 'number') num = payload.issue.number;
  else if (typeof payload.number === 'number') num = payload.number;

  const pullRequests: number[] = [];
  const rawPrs = payload.check_run?.pull_requests ?? payload.check_suite?.pull_requests ?? payload.workflow_run?.pull_requests ?? payload.pull_requests;
  if (Array.isArray(rawPrs)) {
    for (const pr of rawPrs) {
      if (typeof pr?.number === 'number' && Number.isInteger(pr.number) && pr.number > 0) {
        if (!pullRequests.includes(pr.number)) pullRequests.push(pr.number);
        if (pullRequests.length >= 5) break;
      }
    }
  }
  if (pullRequests.length === 0 && isPr && typeof num === 'number' && num > 0) {
    pullRequests.push(num);
  }

  const rawTitle = payload.pull_request?.title ?? payload.issue?.title;
  const rawBody = payload.comment?.body ?? payload.review?.body ?? payload.issue?.body ?? payload.pull_request?.body;
  const rawAuthorLogin = payload.comment?.user?.login ?? payload.review?.user?.login ?? payload.issue?.user?.login ?? payload.pull_request?.user?.login ?? payload.sender?.login;
  const rawAuthorType = payload.comment?.user?.type ?? payload.review?.user?.type ?? payload.issue?.user?.type ?? payload.pull_request?.user?.type ?? payload.sender?.type;
  const rawAuthorAssoc = payload.comment?.author_association ?? payload.review?.author_association ?? payload.issue?.author_association ?? payload.pull_request?.author_association;
  const rawUrl = payload.comment?.html_url ?? payload.review?.html_url ?? payload.pull_request?.html_url ?? payload.issue?.html_url ?? payload.check_run?.html_url ?? payload.check_suite?.html_url ?? payload.workflow_run?.html_url;

  const headRef = payload.pull_request?.head?.ref ?? payload.check_suite?.head_branch ?? payload.check_run?.check_suite?.head_branch ?? payload.workflow_run?.head_branch ?? null;
  const headSha = payload.pull_request?.head?.sha ?? payload.check_suite?.head_sha ?? payload.check_run?.head_sha ?? payload.workflow_run?.head_sha ?? null;
  const baseRef = payload.pull_request?.base?.ref ?? payload.check_suite?.pull_requests?.[0]?.base?.ref ?? null;

  const ciName = payload.check_run?.name ?? payload.check_suite?.app?.name ?? payload.workflow_run?.name ?? null;
  const ciConclusion = payload.check_run?.conclusion ?? payload.check_suite?.conclusion ?? payload.workflow_run?.conclusion ?? null;
  const reviewState = payload.review?.state ? String(payload.review.state).toLowerCase() : null;

  return {
    repo,
    event: eventType,
    action: typeof payload.action === 'string' ? payload.action : null,
    number: typeof num === 'number' && Number.isInteger(num) && num > 0 ? num : null,
    is_pr: isPr,
    title: cleanString(rawTitle, 200),
    author_login: cleanString(rawAuthorLogin, 39),
    author_type: typeof rawAuthorType === 'string' ? rawAuthorType : null,
    author_association: typeof rawAuthorAssoc === 'string' ? rawAuthorAssoc : null,
    url: cleanUrl(rawUrl),
    head_ref: typeof headRef === 'string' ? headRef : null,
    head_sha: typeof headSha === 'string' ? headSha : null,
    base_ref: typeof baseRef === 'string' ? baseRef : null,
    review_state: reviewState,
    ci_name: cleanString(ciName, 100),
    ci_conclusion: typeof ciConclusion === 'string' ? ciConclusion.toLowerCase() : null,
    body_excerpt: cleanString(rawBody, 2000),
    pull_requests: pullRequests,
  };
}

export function threadRef(repo: string, type: 'pr' | 'issue', number: number): string;
export function threadRef(repo: string, type: 'commit', sha: string): string;
export function threadRef(digest: NormalizedDigest): string | string[];
export function threadRef(
  arg1: string | NormalizedDigest,
  arg2?: 'pr' | 'issue' | 'commit',
  arg3?: number | string
): string | string[] {
  if (typeof arg1 === 'object') {
    const refs = threadRefs(arg1);
    return refs.length === 1 ? refs[0]! : refs;
  }

  const repo = arg1.toLowerCase();
  requireCondition(GITHUB_REPO_ANYCASE_RE.test(repo), 400, 'invalid_thread_ref', 'Invalid repo name.');

  if (arg2 === 'pr' || arg2 === 'issue') {
    const num = Number(arg3);
    requireCondition(Number.isInteger(num) && num >= 1 && num <= 1_000_000_000, 400, 'invalid_thread_ref', 'Thread ref number must be between 1 and 10^9.');
    return `github:${repo}#${arg2}/${num}`;
  }

  if (arg2 === 'commit') {
    const sha = String(arg3 ?? '').toLowerCase();
    requireCondition(/^[0-9a-f]{40}$/.test(sha), 400, 'invalid_thread_ref', 'Commit ref must be a 40-character hex sha.');
    return `github:${repo}@${sha}`;
  }

  throw new AppError(400, 'invalid_thread_ref', 'Invalid thread ref arguments.');
}

export function threadRefs(digest: NormalizedDigest): string[] {
  if (!digest.repo) return [];
  if (CI_EVENTS.has(digest.event)) {
    if (digest.pull_requests.length > 0) {
      return digest.pull_requests.slice(0, 5).map(n => threadRef(digest.repo, 'pr', n));
    }
    if (digest.head_sha && /^[0-9a-fA-F]{40}$/.test(digest.head_sha)) {
      return [threadRef(digest.repo, 'commit', digest.head_sha)];
    }
    return [];
  }

  if (digest.is_pr && typeof digest.number === 'number' && digest.number > 0) {
    return [threadRef(digest.repo, 'pr', digest.number)];
  }

  if (!digest.is_pr && typeof digest.number === 'number' && digest.number > 0) {
    return [threadRef(digest.repo, 'issue', digest.number)];
  }

  return [];
}

export function parseThreadRef(ref: string): {
  kind: 'pr' | 'issue' | 'commit';
  repo: string;
  number?: number;
  sha?: string;
} {
  requireCondition(typeof ref === 'string' && ref.length <= 300 && ref.length > 0, 400, 'invalid_thread_ref', 'Thread ref length must be between 1 and 300 characters.');
  requireCondition(ref.startsWith('github:'), 400, 'invalid_thread_ref', 'Thread ref must start with github:.');

  const rest = ref.slice(7);
  const hashIdx = rest.indexOf('#');
  const atIdx = rest.indexOf('@');

  if (hashIdx !== -1 && atIdx === -1) {
    const repo = rest.slice(0, hashIdx);
    requireCondition(GITHUB_REPO_RE.test(repo), 400, 'invalid_thread_ref', 'Repository must be lowercase and valid.');

    const target = rest.slice(hashIdx + 1);
    const m = target.match(/^(pr|issue)\/([1-9][0-9]{0,8})$/);
    requireCondition(Boolean(m), 400, 'invalid_thread_ref', 'Invalid PR or issue thread ref target.');

    const num = Number(m![2]);
    requireCondition(num >= 1 && num <= 1_000_000_000, 400, 'invalid_thread_ref', 'Number out of bounds.');
    return { kind: m![1] as 'pr' | 'issue', repo, number: num };
  }

  if (atIdx !== -1 && hashIdx === -1) {
    const repo = rest.slice(0, atIdx);
    requireCondition(GITHUB_REPO_RE.test(repo), 400, 'invalid_thread_ref', 'Repository must be lowercase and valid.');

    const sha = rest.slice(atIdx + 1);
    requireCondition(/^[0-9a-f]{40}$/.test(sha), 400, 'invalid_thread_ref', 'Commit ref must be 40 lowercase hex characters.');
    return { kind: 'commit', repo, sha };
  }

  throw new AppError(400, 'invalid_thread_ref', 'Malformed thread ref.');
}

export function validateSourceRules(raw?: unknown, existing?: SourceRules): SourceRules {
  if (raw === undefined || raw === null) {
    return existing ?? { ...DEFAULT_SOURCE_RULES };
  }

  requireCondition(typeof raw === 'object' && !Array.isArray(raw), 400, 'invalid_arguments', 'rules must be an object.');
  const input = raw as Record<string, unknown>;

  const allowedKeys = [
    'events',
    'allow_authors',
    'mention',
    'candidate_events',
    'base_branches',
    'ci_conclusions',
    'ignore_bots',
    'auto_subscribe_branches',
  ];
  for (const k of Object.keys(input)) {
    requireCondition(allowedKeys.includes(k), 400, 'invalid_arguments', `Unknown rule: ${k}.`);
  }

  const base = existing ?? DEFAULT_SOURCE_RULES;
  const result: SourceRules = { ...base };

  if (input.events !== undefined) {
    requireCondition(Array.isArray(input.events), 400, 'invalid_arguments', 'events must be an array.');
    for (const ev of input.events) {
      requireCondition(typeof ev === 'string' && DEFAULT_SOURCE_RULES.events.includes(ev), 400, 'invalid_arguments', `Unsupported event: ${ev}`);
    }
    result.events = [...new Set(input.events as string[])];
  }

  if (input.allow_authors !== undefined) {
    requireCondition(Array.isArray(input.allow_authors) && input.allow_authors.length <= 50, 400, 'invalid_arguments', 'allow_authors must be an array of at most 50 logins.');
    for (const author of input.allow_authors) {
      requireCondition(typeof author === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(author), 400, 'invalid_arguments', `Invalid author login: ${author}`);
    }
    result.allow_authors = [...new Set(input.allow_authors as string[])];
  }

  if (input.mention !== undefined) {
    requireCondition(typeof input.mention === 'string' && input.mention.length <= 40 && input.mention.length > 0, 400, 'invalid_arguments', 'mention must be a string up to 40 characters.');
    result.mention = input.mention;
  }

  if (input.candidate_events !== undefined) {
    requireCondition(Array.isArray(input.candidate_events), 400, 'invalid_arguments', 'candidate_events must be an array.');
    for (const ce of input.candidate_events) {
      requireCondition(['issues.opened', 'ci.failure_default_branch'].includes(ce), 400, 'invalid_arguments', `Unknown candidate event: ${ce}`);
    }
    result.candidate_events = [...new Set(input.candidate_events as string[])];
  }

  if (input.base_branches !== undefined) {
    requireCondition(Array.isArray(input.base_branches) && input.base_branches.length <= 20, 400, 'invalid_arguments', 'base_branches must be an array of at most 20 branches.');
    for (const b of input.base_branches) {
      requireCondition(typeof b === 'string' && b.length > 0 && b.length <= 100, 400, 'invalid_arguments', 'Invalid base branch.');
    }
    result.base_branches = [...new Set(input.base_branches as string[])];
  }

  if (input.ci_conclusions !== undefined) {
    requireCondition(Array.isArray(input.ci_conclusions) && input.ci_conclusions.length <= 10, 400, 'invalid_arguments', 'ci_conclusions must be an array of at most 10 conclusions.');
    for (const c of input.ci_conclusions) {
      requireCondition(typeof c === 'string' && c.length > 0 && c.length <= 40, 400, 'invalid_arguments', 'Invalid ci conclusion.');
    }
    result.ci_conclusions = [...new Set((input.ci_conclusions as string[]).map(c => c.toLowerCase()))];
  }

  if (input.ignore_bots !== undefined) {
    requireCondition(typeof input.ignore_bots === 'boolean', 400, 'invalid_arguments', 'ignore_bots must be boolean.');
    result.ignore_bots = input.ignore_bots;
  }

  if (input.auto_subscribe_branches !== undefined) {
    requireCondition(typeof input.auto_subscribe_branches === 'boolean', 400, 'invalid_arguments', 'auto_subscribe_branches must be boolean.');
    result.auto_subscribe_branches = input.auto_subscribe_branches;
  }

  return result;
}

export function classifyGithubEvent(
  rules: SourceRules,
  digest: NormalizedDigest,
  ctx: FilterContext
): ClassificationResult {
  if (!rules.events.includes(digest.event)) {
    return { classification: 'ignore', reason: 'unsupported_event' };
  }

  if (digest.base_ref && !rules.base_branches.includes(digest.base_ref)) {
    return { classification: 'ignore', reason: 'base_branch' };
  }
  if (CI_EVENTS.has(digest.event) && (!digest.pull_requests || digest.pull_requests.length === 0)) {
    if (digest.head_ref && !rules.base_branches.includes(digest.head_ref)) {
      return { classification: 'ignore', reason: 'base_branch' };
    }
  }

  const isHumanAuthored = ['pull_request_review', 'pull_request_review_comment', 'issue_comment', 'issues'].includes(digest.event) ||
    (digest.event === 'pull_request' && ['opened', 'reopened', 'edited'].includes(digest.action ?? ''));

  if (isHumanAuthored) {
    if (digest.author_type === 'Bot' && rules.ignore_bots) {
      return { classification: 'ignore', reason: 'bot_author' };
    }
    const author = digest.author_login?.toLowerCase();
    const allowed = rules.allow_authors.map(a => a.toLowerCase());
    if (!author || !allowed.includes(author)) {
      return { classification: 'ignore', reason: 'author_not_allowed' };
    }
  }

  const eventRefs = threadRefs(digest);
  const isSubscribed = eventRefs.some(ref => ctx.subscribedRefs.has(ref));

  if (isSubscribed) {
    if (digest.event === 'pull_request' && digest.action === 'closed') {
      return { classification: 'ignore', reason: 'closed' };
    }
    if (CI_EVENTS.has(digest.event)) {
      if (digest.ci_conclusion && rules.ci_conclusions.includes(digest.ci_conclusion.toLowerCase())) {
        return { classification: 'explicit', reason: 'subscribed_thread' };
      }
      if (digest.ci_conclusion === 'success') {
        return { classification: 'ignore', reason: 'ci_success' };
      }
      return { classification: 'ignore', reason: 'ci_conclusion' };
    }
    if (digest.event === 'pull_request_review') {
      if (['changes_requested', 'commented'].includes(digest.review_state ?? '')) {
        return { classification: 'explicit', reason: 'subscribed_thread' };
      }
      return { classification: 'ignore', reason: 'review_state' };
    }
    if (['pull_request_review_comment', 'issue_comment'].includes(digest.event)) {
      return { classification: 'explicit', reason: 'subscribed_thread' };
    }
  }

  if (rules.mention && digest.body_excerpt) {
    const escaped = rules.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionRegex = new RegExp(`(^|\\s)${escaped}($|\\s|[.,!?;:])`, 'i');
    if (mentionRegex.test(digest.body_excerpt)) {
      return { classification: 'explicit', reason: 'mention' };
    }
  }

  if (digest.event === 'issues' && digest.action === 'opened') {
    if (rules.candidate_events.includes('issues.opened')) {
      return { classification: 'candidate', reason: 'new_issue' };
    }
  }

  if (CI_EVENTS.has(digest.event) && (!digest.pull_requests || digest.pull_requests.length === 0)) {
    if (digest.head_ref && rules.base_branches.includes(digest.head_ref)) {
      if (digest.ci_conclusion && rules.ci_conclusions.includes(digest.ci_conclusion.toLowerCase())) {
        if (rules.candidate_events.includes('ci.failure_default_branch')) {
          return { classification: 'candidate', reason: 'ci_failure_main' };
        }
      }
    }
  }

  return { classification: 'ignore', reason: 'no_rule' };
}

export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  previousSecret?: string | null,
  previousUntil?: Date | string | null,
  now: Date = new Date()
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const providedHex = signatureHeader.slice(7);
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;

  const check = (sec: string): boolean => {
    const expectedHex = createHmac('sha256', sec).update(rawBody).digest('hex');
    const a = Buffer.from(providedHex, 'utf8');
    const b = Buffer.from(expectedHex, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  if (check(secret)) return true;

  if (previousSecret && previousUntil) {
    const until = typeof previousUntil === 'string' ? new Date(previousUntil) : previousUntil;
    if (until.getTime() > now.getTime()) {
      if (check(previousSecret)) return true;
    }
  }

  return false;
}
