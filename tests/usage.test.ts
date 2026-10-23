import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { collectUsage, headroom, _providers, _resetBackoff } from '../src/usage/index.js';
import { fetchClaude, parseClaudeCreds, parseClaudeUsage, type ClaudeCreds } from '../src/usage/claude.js';
import { fetchCodex, jwtExp, parseCodexAuth, parseCodexUsage } from '../src/usage/codex.js';
import { discoverEndpoint, fetchAntigravity, parseAntigravityQuota, parsePorts, type AntigravityIO, type AntigravityProcess } from '../src/usage/antigravity.js';
import { fetchGrok, parseGrokAuth, parseGrokCredits } from '../src/usage/grok.js';
import { UsageError, type Ctx, type UsageSnapshot } from '../src/usage/types.js';

const NOW = new Date('2026-08-28T08:00:00Z');
const ctxWith = (fetcher: typeof fetch, now: Date = NOW): Ctx => ({ fetcher, now: () => now });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---- fixtures: copied from NotchTrader Tests (UsageResponseTests, CodexUsageTests, GrokUsageTests, AntigravityTests) ----
const CLAUDE_LIVE = { five_hour: { utilization: 52.0, resets_at: '2026-08-28T09:50:00.316290+00:00', limit_dollars: null }, seven_day: { utilization: 17.0, resets_at: '2026-09-02T17:00:00.316321+00:00' }, seven_day_opus: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [{ kind: 'session', group: 'session', percent: 52, resets_at: '2026-08-28T09:50:00.316290+00:00', scope: null }, { kind: 'weekly_all', group: 'weekly', percent: 17, resets_at: '2026-09-02T17:00:00.316321+00:00', scope: null }] };
const CLAUDE_ENTERPRISE = { limits: [], five_hour: null, seven_day: null, seven_day_opus: null,
  amber_ladder: { limit_dollars: 25000, used_dollars: 0, utilization: 0, resets_at: '2026-10-02T06:59:59.000000+00:00' },
  extra_usage: { is_enabled: true, currency: 'USD', monthly_limit: 20000, used_credits: 297, utilization: 1.485, decimal_places: 2 },
  spend: { enabled: true, percent: 1, limit: { amount_minor: 20000, currency: 'USD', exponent: 2 }, used: { amount_minor: 297, currency: 'USD', exponent: 2 } } };
const CODEX_FULL = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800001000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1800600000 } },
  additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000 } } }],
  code_review_rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 604800 } }, plan_type: 'plus' };
const GROK_CREDITS = { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-05T08:21:18.802818+00:00', end: '2026-09-12T08:21:18.802818+00:00' },
  creditUsagePercent: 8.0, productUsage: [{ product: 'GrokBuild', usagePercent: 8.0 }], billingPeriodEnd: '2026-09-12T08:21:18.802818+00:00' } };
const AGY_REAL = { response: { groups: [
  { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.96262, resetTime: '2026-09-07T14:12:34Z' }] },
  { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-09-08T09:12:10Z' }] }] } };

const snap = (ok: boolean, ...used: number[]): UsageSnapshot => ({ provider: 'claude', ok, windows: used.map((u, i) => ({ name: `w${i}`, used_percent: u, resets_at: null })), fetched_at: NOW.toISOString() });

// ---- headroom ----
test('headroom is 100 minus the most-used window, and 0 when unreadable', () => {
  assert.equal(headroom(snap(true, 52, 17)), 48);
  assert.equal(headroom(snap(true, 100)), 0);
  assert.equal(headroom(snap(false, 10)), 0);
  assert.equal(headroom(snap(true)), 0);
});

// ---- claude ----
test('claude: live shape maps to 5h/weekly with resets and ignores undocumented codename blocks', () => {
  const w = parseClaudeUsage(CLAUDE_LIVE, NOW);
  assert.deepEqual(w.map((x) => x.name), ['5h', 'weekly']);
  assert.deepEqual(w.map((x) => x.used_percent), [52, 17]);
  assert.equal(w[0]!.resets_at, '2026-08-28T09:50:00.316Z');
});

test('claude: named windows are the fallback, scoped weekly is named after its model, opus/sonnet pass through', () => {
  assert.deepEqual(parseClaudeUsage({ five_hour: { utilization: 48, resets_at: '2026-08-28T09:50:00Z' }, seven_day: { utilization: 16, resets_at: '2026-09-02T17:00:00Z' }, seven_day_opus: { utilization: 5, resets_at: '2026-09-02T17:00:00Z' }, seven_day_sonnet: null }, NOW).map((x) => x.name), ['5h', 'weekly', 'weekly_opus']);
  const scoped = parseClaudeUsage({ limits: [{ kind: 'weekly_scoped', percent: 61, resets_at: '2026-09-02T17:00:00Z', scope: { model: { display_name: 'Fable', id: 'x' } } }] }, NOW);
  assert.deepEqual(scoped.map((x) => [x.name, x.used_percent]), [['weekly_fable', 61]]);
  assert.equal(parseClaudeUsage({ limits: [{ kind: 'weekly_scoped', percent: 61, resets_at: null, scope: 'fable' }] }, NOW)[0]!.name, 'weekly_scoped');
});

test('claude: enterprise credit seat reports only spend (used/limit, resets at next UTC month)', () => {
  const w = parseClaudeUsage(CLAUDE_ENTERPRISE, new Date('2026-10-12T07:29:56Z'));
  assert.deepEqual(w.map((x) => x.name), ['spend']);
  near(w[0]!.used_percent, 1.485);
  assert.equal(w[0]!.resets_at, '2026-11-01T00:00:00.000Z');
  const { extra_usage: _, ...noPeriod } = CLAUDE_ENTERPRISE;
  assert.equal(parseClaudeUsage(noPeriod, NOW)[0]!.resets_at, null);
});

test('claude: percentages are clamped to 0-100 and junk yields nothing', () => {
  const w = parseClaudeUsage({ limits: [{ kind: 'session', percent: 140, resets_at: null }, { kind: 'weekly_all', percent: -3, resets_at: null }] }, NOW);
  assert.deepEqual(w.map((x) => x.used_percent), [100, 0]);
  assert.deepEqual(parseClaudeUsage('nope', NOW), []);
  assert.deepEqual(parseClaudeUsage({}, NOW), []);
});

test('claude: credential JSON is parsed and an emptied token is kept distinguishable', () => {
  assert.deepEqual(parseClaudeCreds('{"claudeAiOauth":{"accessToken":"t","expiresAt":123,"subscriptionType":"max"}}'), { accessToken: 't', expiresAt: 123, subscriptionType: 'max' });
  assert.equal(parseClaudeCreds('{"claudeAiOauth":{"accessToken":""}}')?.accessToken, '');
  assert.equal(parseClaudeCreds('garbage'), null);
});

test('claude: an expired token is reported, not refreshed, and the network is never touched', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return json({}); }) as typeof fetch;
  const expired: ClaudeCreds = { accessToken: 'SECRET-TOKEN', expiresAt: NOW.getTime() - 1 };
  await assert.rejects(fetchClaude(ctxWith(fetcher), async () => expired), (e: Error) => e instanceof UsageError && e.message === 'token expired; open Claude Code to renew' && !e.message.includes('SECRET'));
  assert.equal(calls, 0);
});

test('claude: a valid token goes to the Anthropic endpoint with the OAuth beta header and returns plan + windows', async () => {
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const fetcher = (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string> }; return json(CLAUDE_LIVE); }) as unknown as typeof fetch;
  const r = await fetchClaude(ctxWith(fetcher), async () => ({ accessToken: 'tok', expiresAt: NOW.getTime() + 3600_000, subscriptionType: 'max' }));
  assert.equal(seen!.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen!.headers.Authorization, 'Bearer tok');
  assert.equal(seen!.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(r.plan, 'max');
  assert.equal(r.windows.length, 2);
});

test('claude: 401 and empty-limit responses become safe errors', async () => {
  const creds = async () => ({ accessToken: 'tok', expiresAt: NOW.getTime() + 1e6 });
  await assert.rejects(fetchClaude(ctxWith((async () => json({ error: 'echo tok' }, 401)) as typeof fetch), creds), /auth rejected/);
  await assert.rejects(fetchClaude(ctxWith((async () => json({ limits: [] })) as typeof fetch), creds), /no usage limits/);
});

// ---- codex ----
test('codex: primary/secondary map to 5h/weekly with epoch resets; Spark and code-review extras are excluded', () => {
  const r = parseCodexUsage(CODEX_FULL, NOW);
  assert.deepEqual(r.windows.map((x) => x.name), ['5h', 'weekly']);
  assert.deepEqual(r.windows.map((x) => x.used_percent), [25, 10]);
  assert.equal(r.windows[0]!.resets_at, new Date(1800001000 * 1000).toISOString());
  assert.equal(r.plan, 'plus');
});

test('codex: a monthly free-plan window, a weekly-only primary, countdown-only reset and a null used_percent are all handled', () => {
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 16, limit_window_seconds: 2592000, reset_at: 1790585722 }, secondary_window: null }, plan_type: 'free' }).windows.map((x) => [x.name, x.used_percent]), [['monthly', 16]]);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } } }).windows[0]!.name, 'weekly');
  const cd = parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 120 } } }, NOW).windows[0]!;
  assert.equal(cd.resets_at, new Date(NOW.getTime() + 120_000).toISOString());
  const skip = parseCodexUsage({ rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000 }, secondary_window: { used_percent: 29, limit_window_seconds: 604800, reset_at: 1800600000 } } });
  assert.deepEqual(skip.windows.map((x) => x.name), ['weekly']);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 259200 } } }).windows[0]!.name, '3d');
});

test('codex: credit seats fall back to spend_control; nothing metered yields no windows', () => {
  const w = parseCodexUsage({ spend_control: { individual_limit: { limit: '374.92', used: '10', used_percent: 3, reset_at: 1800600000 } } }).windows;
  assert.deepEqual(w.map((x) => [x.name, x.used_percent]), [['credits', 3]]);
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: null } } }).windows, []);
});

test('codex: auth.json parsing and JWT expiry; an expired token never reaches the network', async () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  assert.deepEqual(parseCodexAuth(JSON.stringify({ tokens: { access_token: 'a', account_id: 'acc' } })), { accessToken: 'a', accountId: 'acc' });
  assert.equal(parseCodexAuth(JSON.stringify({ tokens: { access_token: ' ', account_id: 'acc' } })), null);
  assert.equal(jwtExp(jwt(42)), 42);
  assert.equal(jwtExp('opaque'), undefined);
  let calls = 0;
  const fetcher = (async () => { calls++; return json(CODEX_FULL); }) as typeof fetch;
  await assert.rejects(fetchCodex(ctxWith(fetcher), async () => ({ accessToken: jwt(NOW.getTime() / 1000 - 5), accountId: 'acc' })), /token expired/);
  assert.equal(calls, 0);
  let headers: Record<string, string> = {};
  const ok = (async (_u: string, init: RequestInit) => { headers = init.headers as Record<string, string>; return json(CODEX_FULL); }) as unknown as typeof fetch;
  const r = await fetchCodex(ctxWith(ok), async () => ({ accessToken: jwt(NOW.getTime() / 1000 + 600), accountId: 'acc' }));
  assert.equal(headers['ChatGPT-Account-Id'], 'acc');
  assert.equal(r.windows.length, 2);
});

// ---- grok ----
test('grok: credits percent is the ring, with the period end as reset', () => {
  const w = parseGrokCredits(GROK_CREDITS);
  assert.deepEqual(w.map((x) => [x.name, x.used_percent, x.resets_at]), [['credits', 8, '2026-09-12T08:21:18.802Z']]);
});

test('grok: product-only, fresh weekly pool (0%), empty config and garbage', () => {
  assert.equal(parseGrokCredits({ config: { productUsage: [{ product: 'GrokBuild', usagePercent: 33.0 }], billingPeriodEnd: '2026-09-12T08:21:18Z' } })[0]!.used_percent, 33);
  const fresh = parseGrokCredits({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-14T20:59:12+00:00' } } });
  assert.deepEqual(fresh.map((x) => [x.name, x.used_percent, x.resets_at]), [['credits', 0, '2026-09-14T20:59:12.000Z']]);
  assert.deepEqual(parseGrokCredits({ config: {} }), []);
  assert.deepEqual(parseGrokCredits('not json'), []);
});

test('grok: only xAI-issued sessions are trusted (lookalike issuers are not), live entry preferred; expired token is not sent', async () => {
  const auth = (k: string, key: string, expires_at: string) => ({ [k]: { key, expires_at } });
  assert.equal(parseGrokAuth(JSON.stringify(auth('https://auth.x.ai.example.com::cli', 'evil', '2099-01-01T00:00:00Z'))), null);
  assert.equal(parseGrokAuth(JSON.stringify(auth('https://auth.x.aix::cli', 'evil', '2099-01-01T00:00:00Z'))), null);
  assert.equal(parseGrokAuth(JSON.stringify(auth('https://auth.x.ai::cli', 'good', '2099-01-01T00:00:00Z')))?.accessToken, 'good');
  const both = JSON.stringify({ ...auth('https://auth.x.ai::old', 'old', '2020-01-01T00:00:00Z'), ...auth('https://auth.x.ai::new', 'new', '2099-01-01T00:00:00Z') });
  assert.equal(parseGrokAuth(both)?.accessToken, 'new');
  let calls = 0;
  await assert.rejects(fetchGrok(ctxWith((async () => { calls++; return json(GROK_CREDITS); }) as typeof fetch), async () => ({ accessToken: 't', expiresAt: NOW.getTime() - 1 })), /token expired; run grok login/);
  assert.equal(calls, 0);
  assert.equal((await fetchGrok(ctxWith((async () => json(GROK_CREDITS)) as typeof fetch), async () => ({ accessToken: 't', expiresAt: null }))).windows[0]!.name, 'credits');
});

// ---- antigravity ----
test('antigravity: language-server envelope inverts remaining to used and keeps resets', () => {
  const w = parseAntigravityQuota(AGY_REAL, NOW);
  assert.deepEqual(w.map((x) => x.name), ['gemini-weekly', '3p-weekly']);
  near(w[0]!.used_percent, (1 - 0.96262) * 100);
  assert.equal(w[1]!.used_percent, 0);
  assert.equal(w[0]!.resets_at, '2026-09-07T14:12:34.000Z');
});

test('antigravity: grouped quotaGroups limit/used, CodexBar envelope with oneof remaining, ordering by cadence', () => {
  const grouped = parseAntigravityQuota({ quotaGroups: [{ displayName: 'Gemini', buckets: [{ name: 'daily', displayName: 'Daily', used: 250, limit: 1000, resetTime: '2026-09-01T00:00:00Z' }] }] }, NOW);
  assert.deepEqual(grouped.map((x) => [x.name, x.used_percent]), [['daily', 25]]);
  const env = parseAntigravityQuota({ groups: [
    { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', displayName: 'Weekly Limit', remainingFraction: 1 }, { bucketId: '3p-5h', displayName: '5-hour Limit', remainingFraction: 1 }] },
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: 0.55 } }, { bucketId: 'gemini-5h', displayName: '5-hour Limit', remaining: { case: 'remainingFraction', value: 0.86 } }] }] }, NOW);
  assert.deepEqual(env.map((x) => x.name), ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly']);
  assert.deepEqual(env.map((x) => x.used_percent), [14, 45, 0, 0]);
});

test('antigravity: direct Cloud Code per-model buckets fold into 4 windows; invalid fractions, zero limits and junk are dropped', () => {
  const now = new Date(1788900000 * 1000);
  const w = parseAntigravityQuota({ buckets: [
    { modelId: 'claude-sonnet-4-6', remainingFraction: 0.75, resetTime: '2026-09-09T10:39:57Z' }, { modelId: 'claude-opus-4-6-thinking', remainingFraction: 0.85, resetTime: '2026-09-16T18:00:12Z' },
    { modelId: 'gemini-3.7-flash-tiered', remainingFraction: 0.90, resetTime: '2026-09-09T10:39:57Z' }, { modelId: 'gemini-2.5-pro', remainingFraction: 0.80, resetTime: '2026-09-16T10:39:57Z' }] }, now);
  assert.deepEqual(w.map((x) => [x.name, Math.round(x.used_percent)]), [['gemini-hourly', 10], ['gemini-weekly', 20], ['3p-hourly', 25], ['3p-weekly', 15]]);
  const bad = parseAntigravityQuota({ buckets: [{ modelId: 'gemini-bad-over', remainingFraction: 1.5 }, { modelId: 'gemini-bad-under', remainingFraction: -0.1 }, { modelId: 'gemini-3.7-flash', remainingFraction: 0.4 }] }, now);
  assert.deepEqual(bad.map((x) => [x.name, x.used_percent]), [['gemini-hourly', 60]]);
  assert.deepEqual(parseAntigravityQuota({ buckets: [{ name: 'x', used: 0, limit: 0 }] }), []);
  assert.deepEqual(parseAntigravityQuota({ buckets: [{ name: 'x', used: 9999, limit: 10 }] }), []);
  assert.deepEqual(parseAntigravityQuota({ buckets: [{ name: 'x', used: -5, limit: 10 }] }), []);
  assert.equal(parseAntigravityQuota({ buckets: [{ name: 'd', used: 1, limit: 4 }] }).length, 1);
  assert.deepEqual(parseAntigravityQuota({ somethingElse: [1, 2] }), []);
  assert.deepEqual(parseAntigravityQuota('nonsense'), []);
});

test('antigravity: discovery reads the CSRF token from the process table, prefers the IDE, finds the agy CLI, ignores lookalikes', async () => {
  const ports = async () => [63881, 63882];
  const ide = await discoverEndpoint('29283 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --csrf_token d4bd9204 --app_data_dir antigravity', async (pid) => (assert.equal(pid, 29283), [63881, 63882]));
  assert.deepEqual(ide, { ports: [63881, 63882], csrf: 'd4bd9204', pid: 29283 });
  assert.equal(await discoverEndpoint('1 /sbin/launchd', ports), null);
  assert.equal(await discoverEndpoint('1 language_server --csrf_token abc', async () => []), null);
  assert.deepEqual(await discoverEndpoint('34221 agy', ports), { ports: [63881, 63882], csrf: undefined, pid: 34221 });
  assert.deepEqual(await discoverEndpoint('700 /Users/someone/.local/bin/agy', ports), { ports: [63881, 63882], csrf: undefined, pid: 700 });
  assert.equal((await discoverEndpoint('29283 /x/language_server --csrf_token abc\n34221 agy', ports))?.csrf, 'abc');
  for (const c of ['/opt/legacy/bin/server', '/usr/bin/agyllomerate', 'imagy-daemon']) assert.equal(await discoverEndpoint(`500 ${c}`, ports), null, c);
  assert.deepEqual(parsePorts('language_server 29283 vinz 12u IPv4 0x1 0t0 TCP 127.0.0.1:63881 (LISTEN)\nlanguage_server 29283 vinz 13u IPv4 0x2 0t0 TCP 127.0.0.1:63882 (LISTEN)'), [63881, 63882]);
});

class FakeAntigravity extends EventEmitter implements AntigravityProcess {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: NodeJS.Signals[] = [];
  constructor(readonly pid?: number) { super(); }
  kill(signal: NodeJS.Signals) { this.signals.push(signal); this.signalCode = signal; this.emit('exit'); return true; }
}

function antigravityIO(overrides: Partial<AntigravityIO> = {}) {
  const children: FakeAntigravity[] = [];
  let psCalls = 0, portCalls = 0, elapsed = 0;
  const io: AntigravityIO = {
    ps: async () => { psCalls++; return ''; },
    ports: async () => { portCalls++; return [1, 2]; },
    binary: async () => '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    spawn: () => {
      assert.ok(children.every((c) => c.exitCode !== null || c.signalCode !== null), 'only one owned server may be alive');
      const child = new FakeAntigravity(100 + children.length);
      children.push(child);
      return child;
    },
    sleep: async (ms) => { elapsed += ms; },
    now: () => elapsed,
    post: async () => AGY_REAL,
    ...overrides,
  };
  return { io, children, calls: () => ({ ps: psCalls, ports: portCalls, elapsed }) };
}

test('antigravity: starts an owned server with the Swift flags and a fresh token; ports and authentication are retried', async (t) => {
  let portCalls = 0, postCalls = 0, token = '';
  const fake = antigravityIO({
    ports: async () => ++portCalls < 3 ? [] : [1],
    post: async (_port, csrf) => { assert.ok(csrf === token, 'RPC must use the generated token'); return ++postCalls < 3 ? {} : AGY_REAL; },
  });
  const spawn = fake.io.spawn;
  fake.io.spawn = (binary, args, options) => {
    assert.equal(binary, '/Applications/Antigravity.app/Contents/Resources/bin/language_server');
    const tokenIndex = args.indexOf('--csrf_token') + 1;
    token = args[tokenIndex]!;
    assert.ok(/^[a-f0-9]{64}$/.test(token), 'token must be random hex');
    assert.deepEqual(args.map((v, i) => i === tokenIndex ? '<redacted>' : v), [
      '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
      '--override_user_agent_name', 'antigravity', '--https_server_port', '0', '--csrf_token', '<redacted>',
      '--app_data_dir', 'swarmaa-bridge', '--api_server_url', 'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
    ]);
    assert.deepEqual(options, { detached: false, stdio: 'ignore' });
    return spawn(binary, args, options);
  };
  t.after(() => fake.children.forEach((child) => child.kill('SIGTERM')));
  assert.equal((await fetchAntigravity(ctxWith(fetch), fake.io)).windows.length, 2);
  assert.equal(fake.children.length, 1);
  assert.equal(portCalls, 5);
  assert.equal(fake.calls().elapsed, 1_000);
  await fetchAntigravity(ctxWith(fetch), fake.io);
  assert.equal(fake.calls().ps, 1);
  assert.equal(portCalls, 5, 'cached owned ports need no lsof');
  assert.equal(fake.children.length, 1);
});

test('antigravity: IDE and CLI servers are preferred and cached without ps or lsof; the second port can answer', async () => {
  for (const table of ['20 language_server --csrf_token test-token\n30 agy', '30 /usr/local/bin/agy']) {
    const fake = antigravityIO();
    let psCalls = 0;
    fake.io.ps = async () => { psCalls++; return table; };
    const tried: number[] = [];
    fake.io.post = async (port, csrf) => {
      assert.ok(csrf === (table.startsWith('20') ? 'test-token' : undefined));
      tried.push(port);
      if (port === 1) throw new Error('refused');
      return AGY_REAL;
    };
    for (let i = 0; i < 2; i++) assert.equal((await fetchAntigravity(ctxWith(fetch), fake.io)).windows.length, 2);
    assert.deepEqual(tried, [1, 2, 1, 2]);
    assert.equal(psCalls, 1);
    assert.equal(fake.calls().ports, 1);
    assert.equal(fake.children.length, 0);
  }
});

test('antigravity: failed cached external endpoint triggers rediscovery', async () => {
  let pid = 20, psCalls = 0;
  const fake = antigravityIO({ ps: async () => { psCalls++; return `${pid} agy`; }, ports: async (pid) => [pid] });
  await fetchAntigravity(ctxWith(fetch), fake.io);
  pid = 30;
  const tried: number[] = [];
  fake.io.post = async (port) => { tried.push(port); return port === 30 ? AGY_REAL : {}; };
  assert.equal((await fetchAntigravity(ctxWith(fetch), fake.io)).windows.length, 2);
  assert.deepEqual(tried, [20, 30]);
  assert.equal(psCalls, 2);
  assert.equal(fake.children.length, 0);
});

test('antigravity: a dead owned server is replaced on the next probe, with one server for overlapping probes', async (t) => {
  const fake = antigravityIO();
  const tokens = new Set<string>();
  fake.io.post = async (_port, csrf) => { tokens.add(csrf!); return AGY_REAL; };
  t.after(() => fake.children.forEach((child) => child.kill('SIGTERM')));
  await Promise.all([fetchAntigravity(ctxWith(fetch), fake.io), fetchAntigravity(ctxWith(fetch), fake.io)]);
  assert.equal(fake.children.length, 1);
  fake.children[0]!.exitCode = 1;
  fake.children[0]!.emit('exit');
  await Promise.all([fetchAntigravity(ctxWith(fetch), fake.io), fetchAntigravity(ctxWith(fetch), fake.io)]);
  assert.equal(fake.children.length, 2);
  assert.equal(tokens.size, 2, 'replacement must use a fresh token');
  assert.equal(fake.calls().ps, 2);
});

test('antigravity: an unresponsive owned server is stopped and replaced only on the next probe', async (t) => {
  const fake = antigravityIO();
  t.after(() => fake.children.forEach((child) => child.kill('SIGTERM')));
  await fetchAntigravity(ctxWith(fetch), fake.io);
  fake.io.post = async () => { throw new Error('unsafe server details'); };
  await assert.rejects(fetchAntigravity(ctxWith(fetch), fake.io), (e: Error) => e instanceof UsageError && e.message === 'Antigravity quota unavailable');
  assert.deepEqual(fake.children[0]!.signals, ['SIGTERM']);
  assert.equal(fake.children.length, 1);
  fake.io.post = async () => AGY_REAL;
  await fetchAntigravity(ctxWith(fetch), fake.io);
  assert.equal(fake.children.length, 2);
});

test('antigravity: replacement waits for termination, escalating when SIGTERM is ignored', async (t) => {
  const fake = antigravityIO();
  t.after(() => fake.children.forEach((child) => child.kill('SIGKILL')));
  await fetchAntigravity(ctxWith(fetch), fake.io);
  const first = fake.children[0]!;
  first.kill = (signal) => {
    first.signals.push(signal);
    if (signal === 'SIGKILL') { first.signalCode = signal; first.emit('exit'); }
    return true;
  };
  fake.io.post = async () => ({});
  await assert.rejects(fetchAntigravity(ctxWith(fetch), fake.io), /Antigravity quota unavailable/);
  assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.calls().elapsed, 1_000);
  fake.io.post = async () => AGY_REAL;
  await fetchAntigravity(ctxWith(fetch), fake.io);
  assert.equal(fake.children.length, 2);
});

test('antigravity: no executable is not installed; spawn errors and unusable quota stay safe', async () => {
  const missing = antigravityIO({ binary: async () => null });
  await assert.rejects(fetchAntigravity(ctxWith(fetch), missing.io), (e: Error) => e instanceof UsageError && e.message === 'Antigravity is not installed');
  assert.equal(missing.children.length, 0);
  const failed = antigravityIO({ spawn: () => { throw new Error('unsafe command line'); } });
  await assert.rejects(fetchAntigravity(ctxWith(fetch), failed.io), (e: Error) => e instanceof UsageError && e.message === 'Antigravity quota unavailable');
  const empty = antigravityIO({ post: async () => ({}) });
  await assert.rejects(fetchAntigravity(ctxWith(fetch), empty.io), /Antigravity quota unavailable/);
  assert.equal(empty.calls().elapsed, 10_000);
  assert.deepEqual(empty.children[0]!.signals, ['SIGTERM']);
  const unbound = antigravityIO({ ports: async () => [] });
  await assert.rejects(fetchAntigravity(ctxWith(fetch), unbound.io), /Antigravity quota unavailable/);
  assert.equal(unbound.calls().elapsed, 10_000);
  assert.deepEqual(unbound.children[0]!.signals, ['SIGTERM']);
});

test('antigravity: async spawn failure is handled without leaking its error', async () => {
  const child = new FakeAntigravity();
  const fake = antigravityIO({ spawn: () => { queueMicrotask(() => child.emit('error', new Error('unsafe spawn details'))); return child; } });
  await assert.rejects(fetchAntigravity(ctxWith(fetch), fake.io), (e: Error) => e instanceof UsageError && e.message === 'Antigravity quota unavailable');
  assert.equal(fake.calls().ports, 0);
});

test('antigravity: exit and signals stop owned children without interrupting existing shutdown handlers', () => {
  const script = `
    import { EventEmitter } from 'node:events';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { fetchAntigravity } from './src/usage/antigravity.ts';
    const signal = process.argv[2];
    if (signal !== 'exit') process.once(signal, () => setTimeout(() => console.log('shutdown'), 10));
    const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null,
      kill(signal) { this.signalCode = signal; this.emit('exit'); console.log('stopped'); return true; } });
    await fetchAntigravity({ fetcher: fetch, now: () => new Date() }, {
      ps: async () => '', ports: async () => [1], binary: async () => 'fake', spawn: () => child,
      now: Date.now, sleep, post: async () => ({ buckets: [{ name: 'session', used: 1, limit: 2 }] }),
    });
    if (signal !== 'exit') { process.kill(process.pid, signal); await sleep(30); }
  `;
  for (const signal of ['exit', 'SIGTERM', 'SIGINT']) {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-', signal], { input: script, encoding: 'utf8', timeout: 20_000 });
    assert.equal(output, signal === 'exit' ? 'stopped\n' : 'stopped\nshutdown\n');
  }
});

// ---- collectUsage: never throws, safe errors, 429 backoff ----
test('collectUsage: a failing provider yields ok:false with a short safe error; others still succeed; nothing throws', async () => {
  _resetBackoff();
  const saved = { ..._providers };
  try {
    _providers.claude = async () => { throw new TypeError('fetch failed: https://api.anthropic.com/?token=SECRET'); };
    _providers.codex = async () => ({ windows: [{ name: '5h', used_percent: 40, resets_at: null }], plan: 'plus' });
    _providers.grok = async () => { throw new Error('body: {"access_token":"SECRET"}'); };
    _providers.antigravity = async () => { throw new UsageError('Antigravity not running'); };
    const out = await collectUsage(['claude', 'codex', 'grok', 'antigravity'], { now: () => NOW });
    assert.deepEqual(out.map((s) => [s.provider, s.ok]), [['claude', false], ['codex', true], ['grok', false], ['antigravity', false]]);
    assert.equal(out[0]!.error, 'network error');
    assert.equal(out[2]!.error, 'unexpected error');
    assert.equal(out[3]!.error, 'Antigravity not running');
    assert.equal(out[1]!.plan, 'plus');
    assert.equal(out[1]!.fetched_at, NOW.toISOString());
    assert.ok(!JSON.stringify(out).includes('SECRET'));
  } finally { Object.assign(_providers, saved); }
});

test('collectUsage: a 429 backs off 60s then doubles, capped at 30 min, without touching the network inside the window', async () => {
  _resetBackoff();
  const saved = { ..._providers };
  let calls = 0, t = NOW.getTime();
  const fetcher = (async () => { calls++; return new Response('{"leak":"SECRET"}', { status: 429, headers: { 'retry-after': '0' } }); }) as typeof fetch;
  try {
    // exercise the real getJson path via a provider that just does a fetch through the shared helper
    const { getJson } = await import('../src/usage/types.js');
    _providers.claude = async (ctx) => { await getJson(ctx, 'https://example.test/usage', {}, 'auth'); return { windows: [] }; };
    const run = () => collectUsage(['claude'], { fetcher, now: () => new Date(t) }).then((r) => r[0]!);
    let s = await run();
    assert.equal(calls, 1);
    assert.equal(s.ok, false);
    assert.equal(s.error, 'rate limited');
    t += 30_000;
    s = await run();
    assert.equal(calls, 1, 'second call inside the 60s window must not fetch');
    assert.match(s.error!, /^rate limited; retry in 30s$/);
    t += 31_000;                      // 61s after the first 429 -> window over -> fetches (and 429s again: strike 2 => 120s)
    s = await run();
    assert.equal(calls, 2);
    t += 100_000;
    s = await run();
    assert.equal(calls, 2, '100s < 120s doubled window');
    t += 21_000;
    await run();
    assert.equal(calls, 3);
    for (let i = 0; i < 10; i++) { t += 31 * 60_000; await run(); }   // always past the cap, so every call fetches and the window saturates
    s = await run();
    assert.match(s.error!, /^rate limited; retry in 1800s$/);
  } finally { Object.assign(_providers, saved); _resetBackoff(); }
});

test('collectUsage: a success clears the backoff', async () => {
  _resetBackoff();
  const saved = { ..._providers };
  let mode: 'limit' | 'ok' = 'limit', t = NOW.getTime();
  try {
    _providers.codex = async () => { if (mode === 'limit') throw new UsageError('rate limited', undefined, true); return { windows: [{ name: 'x', used_percent: 1, resets_at: null }] }; };
    assert.equal((await collectUsage(['codex'], { now: () => new Date(t) }))[0]!.ok, false);
    mode = 'ok'; t += 61_000;
    assert.equal((await collectUsage(['codex'], { now: () => new Date(t) }))[0]!.ok, true);
    mode = 'limit';
    await collectUsage(['codex'], { now: () => new Date(t) });          // strike count restarted at 1 => 60s again
    t += 61_000;
    mode = 'ok';
    assert.equal((await collectUsage(['codex'], { now: () => new Date(t) }))[0]!.ok, true);
  } finally { Object.assign(_providers, saved); _resetBackoff(); }
});
