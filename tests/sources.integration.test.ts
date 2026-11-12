/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { createWorktree, finishWorktree } from '../src/bridge/worktree.js';
import { CoreService } from '../src/core/index.js';
import { tickSourceDeliveries } from '../src/core/sources.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const runExec = promisify(execFile);

const connectionString = process.env.TEST_DATABASE_URL;

describe('sources and github intake integration tests (§8.2)', { skip: !connectionString, concurrency: false }, () => {
  const schema = `sources_test_${randomUUID().replaceAll('-', '')}`;
  const encKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  let control: Pool;
  let pool: Pool;
  let core: CoreService;
  let server: Server;
  let origin: string;
  let disabledServer: Server;
  let disabledOrigin: string;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });

    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }

    core = new CoreService(pool);
    const config: ServerConfig = {
      host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', allowedOrigins: [], allowInsecureLocalhost: true,
      maxBodyBytes: 131072, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [],
      eventEncryptionKey: encKey,
      sourcesEnabled: true,
    };
    server = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config, streamHeartbeatMs: 50 }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    config.port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${config.port}`;

    const disabledConfig: ServerConfig = {
      ...config,
      port: 0,
      sourcesEnabled: false,
    };
    disabledServer = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config: disabledConfig, streamHeartbeatMs: 50 }));
    await new Promise<void>(r => disabledServer.listen(0, '127.0.0.1', r));
    const disabledPort = (disabledServer.address() as { port: number }).port;
    disabledConfig.port = disabledPort;
    disabledOrigin = `http://127.0.0.1:${disabledPort}`;
  });

  after(async () => {
    server?.closeAllConnections();
    disabledServer?.closeAllConnections();
    if (server) await new Promise<void>(r => server.close(() => r()));
    if (disabledServer) await new Promise<void>(r => disabledServer.close(() => r()));
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.end();
    }
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown> = {}) =>
    await core.call(p, name, args) as Record<string, any>;

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'] = 'frontend', scopes = ['project:demo']) {
    const p: Principal = {
      id: randomUUID(),
      tenantId,
      name,
      role,
      scopes,
      permissions: role === 'worker' ? [...ROLE_PERMISSIONS[role], 'task:patch'] : [...ROLE_PERMISSIONS[role]]
    };
    const token = newToken();
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(token)]
    );
    return { ...p, token };
  }

  function sign(secret: string, body: Buffer | string): string {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    return 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
  }

  it('source setup: owner creates source (secret returned once, ciphertext in DB, observe mode), raise/lower mode rules', async () => {
    const owner = await createPrincipal('t1', 'owner1', 'admin');

    const created = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/swarmaa',
      name: 'swarmaa-repo',
    }, encKey);
    assert.ok(created.id);
    assert.ok(created.secret);
    assert.equal(created.accept_mode, 'observe');

    const inDb = (await pool.query('SELECT * FROM sources WHERE id = $1', [created.id])).rows[0];
    assert.ok(inDb.secret_ciphertext);
    assert.ok(!JSON.stringify(inDb).includes(created.secret));
    assert.equal(inDb.accept_mode, 'observe');

    // List tool never returns secrets
    const listRes = await call(owner, 'source_list', { scope: 'project:demo' });
    const found = listRes.sources.find((s: any) => s.id === created.id);
    assert.ok(found);
    assert.equal(found.secret, undefined);

    // Raising to auto over source_update tool -> 403 owner_cli_required
    await assert.rejects(
      async () => await call(owner, 'source_update', {
        source_id: created.id,
        expected_version: 1,
        accept_mode: 'auto',
      }),
      { code: 'owner_cli_required' }
    );

    // Lowering mode over tool (auto -> observe or observe -> off) works
    await core.sources.setMode(owner, created.id, 'auto');
    const updated = await call(owner, 'source_update', {
      source_id: created.id,
      expected_version: 2,
      accept_mode: 'observe',
    });
    assert.equal(updated.source.accept_mode, 'observe');
    assert.equal(updated.source.version, 3);

    // Stale expected_version -> 409 conflict
    await assert.rejects(
      async () => await call(owner, 'source_update', {
        source_id: created.id,
        expected_version: 1,
        name: 'stale',
      }),
      { code: 'conflict' }
    );
  });

  it('webhook route: route disabled, signature verification, deduping, errors, and ping', async () => {
    const owner = await createPrincipal('t2', 'owner2', 'admin');
    const created = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/test-webhook',
    }, encKey);

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/test-webhook' },
      comment: { body: 'hello world', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 1 },
    });
    const validSignature = sign(created.secret, payload);

    // 1. With SOURCES_ENABLED=false the route returns 404
    const resDisabled = await fetch(`${disabledOrigin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': validSignature,
      },
      body: payload,
    });
    assert.equal(resDisabled.status, 404);

    // 2. Valid signed issue_comment returns 202 and inserts one row
    const delivery1 = randomUUID();
    const resValid = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': delivery1,
        'x-hub-signature-256': validSignature,
      },
      body: payload,
    });
    assert.equal(resValid.status, 202);
    const count1 = (await pool.query('SELECT count(*)::int FROM source_deliveries WHERE source_id=$1', [created.id])).rows[0].count;
    assert.equal(count1, 1);

    // 3. Same delivery id again -> 200 duplicate, still one row
    const resDup = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': delivery1,
        'x-hub-signature-256': validSignature,
      },
      body: payload,
    });
    assert.equal(resDup.status, 200);
    const dupJson = await resDup.json() as any;
    assert.equal(dupJson.duplicate, true);
    const count2 = (await pool.query('SELECT count(*)::int FROM source_deliveries WHERE source_id=$1', [created.id])).rows[0].count;
    assert.equal(count2, 1);

    // 4. Bad signature, unknown source id, or archived source -> 401 with identical body
    const resBadSig = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: payload,
    });
    assert.equal(resBadSig.status, 401);
    const bodyBadSig = await resBadSig.text();

    const resUnknownSource = await fetch(`${origin}/hooks/github/${randomUUID()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': validSignature,
      },
      body: payload,
    });
    assert.equal(resUnknownSource.status, 401);
    const bodyUnknownSource = await resUnknownSource.text();
    assert.equal(bodyBadSig, bodyUnknownSource);

    // 5. Oversized body -> 413, wrong content type -> 400, repo mismatch -> 202 ignored
    const bigBody = 'x'.repeat(200_000);
    const resBig = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(created.secret, bigBody),
      },
      body: bigBody,
    });
    assert.equal(resBig.status, 413);

    const resWrongType = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': validSignature,
      },
      body: payload,
    });
    assert.equal(resWrongType.status, 400);

    const mismatchPayload = JSON.stringify({
      repository: { full_name: 'other/repo' },
      comment: { body: 'hi' },
    });
    const resMismatch = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(created.secret, mismatchPayload),
      },
      body: mismatchPayload,
    });
    assert.equal(resMismatch.status, 202);

    // 6. Ping -> 202 ignored
    const pingPayload = JSON.stringify({ zen: 'Keep it logically awesome.', repository: { full_name: 'kamatbot/test-webhook' } });
    const resPing = await fetch(`${origin}/hooks/github/${created.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(created.secret, pingPayload),
      },
      body: pingPayload,
    });
    assert.equal(resPing.status, 202);
  });

  it('observe mode: explicit mention on PR records status=observed and would_do; sweep creates no turns or messages', async () => {
    const owner = await createPrincipal('t3', 'owner3', 'admin');

    // Create lead agent and bot
    const agent = (await call(owner, 'agent_create', {
      name: 'Atlas', role: 'Lead', instructions: 'Help', scope: 'project:demo',
      runner: { provider: 'claude' }, edits: true,
    })).agent;
    const bot = (await call(owner, 'bot_create', {
      name: 'TestBot', job: 'Triage', scope: 'project:demo',
      lead_agent_id: agent.id, member_agent_ids: [agent.id],
    })).bot;

    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/observe-test',
      bot_id: bot.id,
      rules: { allow_authors: ['mayurkamat'], mention: '@swarmaa' },
    }, encKey);

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/observe-test' },
      comment: { body: 'Please look @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 42, pull_request: {} },
    });
    const deliveryId = randomUUID();

    const res = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });
    assert.equal(res.status, 202);

    const dRow = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(dRow.status, 'observed');
    assert.deepEqual(dRow.would_do, { post_bot: bot.id });

    // Run sweep
    await tickSourceDeliveries(pool);

    // No messages posted and no tasks queued
    const msgs = (await pool.query('SELECT count(*)::int FROM messages WHERE thread_id=$1 AND kind=$2', [bot.thread_id, 'source_event'])).rows[0].count;
    assert.equal(msgs, 0);
    const tasks = (await pool.query('SELECT count(*)::int FROM tasks WHERE bot_id=$1 AND initiator_kind=$2', [bot.id, 'source'])).rows[0].count;
    assert.equal(tasks, 0);
  });

  it('off mode: deliveries stored as ignored/source_off', async () => {
    const owner = await createPrincipal('t4', 'owner4', 'admin');
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/off-test',
    }, encKey);
    await core.sources.setMode(owner, source.id, 'off');

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/off-test' },
      comment: { body: 'test off' },
      action: 'created',
      issue: { number: 1 },
    });
    const deliveryId = randomUUID();

    const res = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });
    assert.equal(res.status, 202);

    const dRow = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(dRow.status, 'ignored');
    assert.equal(dRow.reason, 'source_off');
  });

  it('auto mode without subscription: explicit mention posts source_event message and queues lead turn; candidate posts with no turn', async () => {
    const owner = await createPrincipal('t5', 'owner5', 'admin');

    const agent = (await call(owner, 'agent_create', {
      name: 'LeadBot', role: 'Lead', instructions: 'Help', scope: 'project:demo',
      runner: { provider: 'claude' }, edits: true,
    })).agent;
    const bot = (await call(owner, 'bot_create', {
      name: 'AutoBot', job: 'Auto job', scope: 'project:demo',
      lead_agent_id: agent.id, member_agent_ids: [agent.id],
    })).bot;

    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/auto-test',
      bot_id: bot.id,
      rules: {
        allow_authors: ['mayurkamat'],
        mention: '@swarmaa',
        candidate_events: ['issues.opened'],
      },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    // 1. Explicit mention
    const payloadExplicit = JSON.stringify({
      repository: { full_name: 'kamatbot/auto-test' },
      comment: { body: 'Hey @swarmaa please check this out', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 10, pull_request: {} },
    });
    const delivExplicit = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': delivExplicit,
        'x-hub-signature-256': sign(source.secret, payloadExplicit),
      },
      body: payloadExplicit,
    });

    // Sweep executes the auto action
    await tickSourceDeliveries(pool);

    const explicitMsg = (await pool.query<any>(
      'SELECT * FROM messages WHERE thread_id=$1 AND kind=$2',
      [bot.thread_id, 'source_event']
    )).rows[0];
    assert.ok(explicitMsg);
    assert.ok(explicitMsg.body.includes('GitHub issue_comment.created'));
    assert.ok(explicitMsg.body.includes('classified explicit (mention)'));

    const explicitTurn = (await pool.query<any>(
      'SELECT * FROM tasks WHERE bot_id=$1 AND initiator_kind=$2',
      [bot.id, 'source']
    )).rows[0];
    assert.ok(explicitTurn);
    assert.equal(explicitTurn.status, 'queued');
    assert.equal(explicitTurn.permission_envelope.deploy, false);
    assert.equal(explicitTurn.permission_envelope.publish, false);
    assert.equal(explicitTurn.permission_envelope.external_side_effects, false);

    // 2. Candidate event: issues.opened posts without queuing a turn
    const payloadCandidate = JSON.stringify({
      repository: { full_name: 'kamatbot/auto-test' },
      issue: { title: 'Bug report', body: 'Broken stuff', number: 11, user: { login: 'mayurkamat', type: 'User' } },
      action: 'opened',
    });
    const delivCandidate = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': delivCandidate,
        'x-hub-signature-256': sign(source.secret, payloadCandidate),
      },
      body: payloadCandidate,
    });

    await tickSourceDeliveries(pool);

    const allMsgs = (await pool.query<any>(
      'SELECT * FROM messages WHERE thread_id=$1 AND kind=$2 ORDER BY seq ASC',
      [bot.thread_id, 'source_event']
    )).rows;
    assert.equal(allMsgs.length, 2);
    assert.ok(allMsgs[1].body.includes('classified candidate (new_issue)'));

    // Still only 1 turn created total!
    const turnsCount = (await pool.query<any>(
      'SELECT count(*)::int FROM tasks WHERE bot_id=$1 AND initiator_kind=$2',
      [bot.id, 'source']
    )).rows[0].count;
    assert.equal(turnsCount, 1);

    // 3. Two quick explicit events while a turn is queued fold into one turn (advancing message_seq)
    const payloadFold1 = JSON.stringify({
      repository: { full_name: 'kamatbot/auto-test' },
      comment: { body: 'Quick comment 1 @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 12, pull_request: {} },
    });
    const payloadFold2 = JSON.stringify({
      repository: { full_name: 'kamatbot/auto-test' },
      comment: { body: 'Quick comment 2 @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 13, pull_request: {} },
    });

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(source.secret, payloadFold1),
      },
      body: payloadFold1,
    });
    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(source.secret, payloadFold2),
      },
      body: payloadFold2,
    });

    await tickSourceDeliveries(pool);

    const finalTurns = (await pool.query<any>(
      'SELECT * FROM tasks WHERE bot_id=$1 AND initiator_kind=$2',
      [bot.id, 'source']
    )).rows;
    assert.equal(finalTurns.length, 1); // Still 1 turn!
    assert.ok(finalTurns[0].context_versions.message_seq > explicitTurn.context_versions.message_seq);
  });

  it('mode lowered mid-flight: delivery received in auto, mode lowered to observe before sweep -> observed', async () => {
    const owner = await createPrincipal('t6', 'owner6', 'admin');
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/midflight-test',
      rules: { allow_authors: ['mayurkamat'], mention: '@swarmaa' },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/midflight-test' },
      comment: { body: 'midflight @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 1 },
    });
    const deliveryId = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });

    // Received in auto
    const beforeSweep = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(beforeSweep.status, 'received');

    // Lower mode to observe before sweep
    await core.sources.setMode(owner, source.id, 'observe');

    // Run sweep
    await tickSourceDeliveries(pool);

    const afterSweep = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(afterSweep.status, 'observed');
  });

  it('never push scan: no code path calls git push, api.github.com, or fetch in source files', async () => {
    const filesToScan = [
      new URL('../src/core/sources.ts', import.meta.url),
      new URL('../src/core/source-filter.ts', import.meta.url),
      new URL('../src/http.ts', import.meta.url),
    ];

    for (const fileUrl of filesToScan) {
      const content = await readFile(fileUrl, 'utf8');
      assert.ok(!content.includes('git push'), `Forbidden 'git push' found in ${fileUrl}`);
      assert.ok(!content.includes('api.github.com'), `Forbidden 'api.github.com' found in ${fileUrl}`);
      assert.ok(!content.includes('fetch('), `Forbidden 'fetch(' found in ${fileUrl}`);
    }
  });

  it('events: source.delivery event emitted with id-only payload and accepted by check constraint', async () => {
    const owner = await createPrincipal('t7', 'owner7', 'admin');
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/events-test',
    }, encKey);

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/events-test' },
      comment: { body: 'event test', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 1 },
    });
    const deliveryId = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });

    const deliveryRow = (await pool.query<any>(
      'SELECT id FROM source_deliveries WHERE source_id = $1 AND delivery_id = $2',
      [source.id, deliveryId]
    )).rows[0];
    assert.ok(deliveryRow);

    const eventRow = (await pool.query<any>(
      "SELECT * FROM events WHERE name = 'source.delivery' AND subject_id = $1",
      [deliveryRow.id]
    )).rows[0];

    assert.ok(eventRow);
    assert.equal(eventRow.name, 'source.delivery');
    assert.equal(eventRow.payload.source_id, source.id);
    assert.ok(eventRow.payload.classification);
    assert.ok(eventRow.payload.status);
    assert.equal(eventRow.payload.body, undefined);
    assert.equal(eventRow.payload.comment, undefined);
  });

  it('tool subscribe: task_subscribe, task_unsubscribe, task_subscriptions', async () => {
    const owner = await createPrincipal('t_sub1', 'owner_sub1', 'admin', ['project:demo']);
    const otherScopeOwner = await createPrincipal('t_sub1', 'owner_sub_other', 'admin', ['project:other']);

    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/swarmaa',
    }, encKey);

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Subscribe tool test',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    await assert.rejects(
      async () => await call(owner, 'task_subscribe', {
        task_id: taskId,
        thread_ref: 'invalid-ref',
        idempotency_key: randomUUID(),
      }),
      { code: 'invalid_thread_ref' }
    );

    const taskOther = await call(otherScopeOwner, 'task_submit', {
      scope: 'project:other',
      kind: 'patch',
      objective: 'No source task',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    await assert.rejects(
      async () => await call(otherScopeOwner, 'task_subscribe', {
        task_id: taskOther.task.id,
        thread_ref: 'github:kamatbot/swarmaa#pr/10',
        idempotency_key: randomUUID(),
      }),
      { code: 'source_not_found' }
    );

    await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [taskOther.task.id]);
    await assert.rejects(
      async () => await call(otherScopeOwner, 'task_subscribe', {
        task_id: taskOther.task.id,
        thread_ref: 'github:kamatbot/swarmaa#pr/10',
        idempotency_key: randomUUID(),
      }),
      { code: 'task_cancelled' }
    );

    const idemKey = randomUUID();
    const subRes = await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/swarmaa#pr/10',
      idempotency_key: idemKey,
    });
    assert.ok(subRes.subscription.id);
    assert.equal(subRes.subscription.task_id, taskId);
    assert.equal(subRes.subscription.source_id, source.id);
    assert.equal(subRes.subscription.external_thread_ref, 'github:kamatbot/swarmaa#pr/10');
    assert.equal(subRes.subscription.budget_remaining, 5);
    assert.equal(subRes.subscription.active, true);
    assert.equal(subRes.subscription.created_via, 'tool');
    assert.equal(subRes.replayed, false);

    const replayRes = await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/swarmaa#pr/10',
      idempotency_key: idemKey,
    });
    assert.equal(replayRes.replayed, true);
    assert.equal(replayRes.subscription.id, subRes.subscription.id);

    const listRes = await call(owner, 'task_subscriptions', { task_id: taskId });
    assert.equal(listRes.subscriptions.length, 1);
    assert.equal(listRes.subscriptions[0].id, subRes.subscription.id);
    assert.equal(listRes.subscriptions[0].active, true);

    const unsubRes = await call(owner, 'task_unsubscribe', { subscription_id: subRes.subscription.id });
    assert.equal(unsubRes.unsubscribed, true);
    assert.equal(unsubRes.subscription.active, false);

    const unsubReplay = await call(owner, 'task_unsubscribe', { subscription_id: subRes.subscription.id });
    assert.equal(unsubReplay.unsubscribed, true);

    const listAfterUnsub = await call(owner, 'task_subscriptions', { task_id: taskId });
    assert.equal(listAfterUnsub.subscriptions[0].active, false);
  });

  it('branch match: auto mode creates branch_match subscription, ambiguous records reason, observe records would_do only', async () => {
    const owner = await createPrincipal('t_sub2', 'owner_sub2', 'admin', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/branch-test',
      rules: { allow_authors: ['mayurkamat'], auto_subscribe_branches: true },
    }, encKey);

    const task1 = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Branch match task 1',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const prefix1 = task1.task.id.slice(0, 8);

    await core.sources.setMode(owner, source.id, 'auto');

    const prPayload = JSON.stringify({
      repository: { full_name: 'kamatbot/branch-test' },
      action: 'opened',
      pull_request: {
        number: 101,
        title: 'Fix issue',
        user: { login: 'mayurkamat', type: 'User' },
        head: { ref: `swarmaa/claude/${prefix1}`, repo: { full_name: 'kamatbot/branch-test' } },
        base: { ref: 'main' },
      },
    });

    const res = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': sign(source.secret, prPayload),
      },
      body: prPayload,
    });
    assert.equal(res.status, 202);

    const subs = (await pool.query<any>(
      'SELECT * FROM task_subscriptions WHERE task_id = $1',
      [task1.task.id]
    )).rows;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].created_via, 'branch_match');
    assert.equal(subs[0].external_thread_ref, 'github:kamatbot/branch-test#pr/101');
    assert.equal(subs[0].active, true);

    // A fork (or an author not on allow_authors) naming its branch like ours never claims the task.
    const forkTask = await call(owner, 'task_submit', {
      scope: 'project:demo', kind: 'patch', objective: 'Fork target', idempotency_key: randomUUID(), required_capability: 'claude.patch',
    });
    for (const [num, repo, login] of [[110, 'attacker/branch-test', 'mayurkamat'], [111, 'kamatbot/branch-test', 'stranger']] as const) {
      const forkPayload = JSON.stringify({
        repository: { full_name: 'kamatbot/branch-test' },
        action: 'opened',
        pull_request: {
          number: num, title: 'Fork PR', user: { login, type: 'User' },
          head: { ref: `swarmaa/claude/${forkTask.task.id.slice(0, 8)}`, repo: { full_name: repo } },
          base: { ref: 'main' },
        },
      });
      const forkRes = await fetch(`${origin}/hooks/github/${source.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': sign(source.secret, forkPayload),
        },
        body: forkPayload,
      });
      assert.equal(forkRes.status, 202);
    }
    const forkSubs = (await pool.query('SELECT 1 FROM task_subscriptions WHERE task_id = $1', [forkTask.task.id])).rowCount;
    assert.equal(forkSubs, 0);

    const fixedPrefix = 'abcdef01';
    const uuidAmbiguous1 = `${fixedPrefix}-0000-0000-0000-000000000001`;
    const uuidAmbiguous2 = `${fixedPrefix}-0000-0000-0000-000000000002`;

    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, required_capability, permission_envelope, constraints, acceptance_criteria, context_refs, context_versions, status, version, created_by, idempotency_key, request_hash)
       VALUES ($1, 't_sub2', 'project:demo', 'patch', 'Obj1', 'claude.patch', '{}'::jsonb, '{}', '{}', '{}', '{}'::jsonb, 'queued', 1, $3, $4, 'h1'),
              ($2, 't_sub2', 'project:demo', 'patch', 'Obj2', 'claude.patch', '{}'::jsonb, '{}', '{}', '{}', '{}'::jsonb, 'queued', 1, $3, $5, 'h2')`,
      [uuidAmbiguous1, uuidAmbiguous2, owner.id, randomUUID(), randomUUID()]
    );

    const ambiguousPayload = JSON.stringify({
      repository: { full_name: 'kamatbot/branch-test' },
      action: 'opened',
      pull_request: {
        number: 102,
        title: 'Ambiguous PR',
        user: { login: 'mayurkamat', type: 'User' },
        head: { ref: `swarmaa/claude/${fixedPrefix}`, repo: { full_name: 'kamatbot/branch-test' } },
        base: { ref: 'main' },
      },
    });

    const deliveryIdAmbiguous = randomUUID();
    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryIdAmbiguous,
        'x-hub-signature-256': sign(source.secret, ambiguousPayload),
      },
      body: ambiguousPayload,
    });

    const deliveryAmbiguous = (await pool.query<any>(
      'SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2',
      [source.id, deliveryIdAmbiguous]
    )).rows[0];
    assert.equal(deliveryAmbiguous.reason, 'branch_ambiguous');
    assert.equal(deliveryAmbiguous.status, 'ignored');

    const subsAmbiguous = (await pool.query<any>(
      'SELECT * FROM task_subscriptions WHERE external_thread_ref = $1',
      ['github:kamatbot/branch-test#pr/102']
    )).rows;
    assert.equal(subsAmbiguous.length, 0);

    await core.sources.setMode(owner, source.id, 'observe');
    const task3 = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Observe branch match task',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const prefix3 = task3.task.id.slice(0, 8);

    const observePayload = JSON.stringify({
      repository: { full_name: 'kamatbot/branch-test' },
      action: 'opened',
      pull_request: {
        number: 103,
        title: 'Observe PR',
        user: { login: 'mayurkamat', type: 'User' },
        head: { ref: `swarmaa/claude/${prefix3}`, repo: { full_name: 'kamatbot/branch-test' } },
        base: { ref: 'main' },
      },
    });
    const deliveryIdObserve = randomUUID();
    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryIdObserve,
        'x-hub-signature-256': sign(source.secret, observePayload),
      },
      body: observePayload,
    });

    const deliveryObserve = (await pool.query<any>(
      'SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2',
      [source.id, deliveryIdObserve]
    )).rows[0];
    assert.equal(deliveryObserve.status, 'observed');
    assert.deepEqual(deliveryObserve.would_do, { subscribe_task: task3.task.id });

    const subsObserve = (await pool.query<any>(
      'SELECT * FROM task_subscriptions WHERE task_id = $1',
      [task3.task.id]
    )).rows;
    assert.equal(subsObserve.length, 0);
  });

  it('continuation of completed task: pull_request_review changes_requested continues task idempotently', async () => {
    const owner = await createPrincipal('t_sub3', 'owner_sub3', 'admin', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/continue-test',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Patch continuation test',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    await pool.query("UPDATE tasks SET status='completed', completed_at=clock_timestamp() WHERE id=$1", [taskId]);

    await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/continue-test#pr/42',
      idempotency_key: randomUUID(),
    });

    const reviewPayload = JSON.stringify({
      repository: { full_name: 'kamatbot/continue-test' },
      action: 'submitted',
      pull_request: { number: 42, title: 'Fix bug', head: { ref: 'patch' }, base: { ref: 'main' } },
      review: { state: 'changes_requested', user: { login: 'mayurkamat', type: 'User' }, body: 'Please fix typo' },
    });
    const deliveryId = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request_review',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, reviewPayload),
      },
      body: reviewPayload,
    });

    await tickSourceDeliveries(pool);

    const taskAfter = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskAfter.status, 'queued');
    assert.equal(taskAfter.continuation_count, 1);

    const instructions = (await pool.query<any>(
      'SELECT * FROM task_instructions WHERE task_id=$1 ORDER BY created_at ASC',
      [taskId]
    )).rows;
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].idempotency_key, `source:${source.id}:${deliveryId}`);
    assert.ok(instructions[0].instruction.includes('<<<UNTRUSTED_CONTENT_'));
    assert.ok(instructions[0].instruction.includes('Address the review/CI feedback above on the same branch if this is a patch task.'));

    const deliveryRow = (await pool.query<any>(
      'SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2',
      [source.id, deliveryId]
    )).rows[0];
    assert.equal(deliveryRow.status, 'continued');
    assert.equal(deliveryRow.task_id, taskId);

    await tickSourceDeliveries(pool);
    const taskAfterReplay = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskAfterReplay.continuation_count, 1);
  });

  it('running task deferral and batching into one continuation when task leaves running', async () => {
    const owner = await createPrincipal('t_sub4', 'owner_sub4', 'admin', ['project:demo']);
    const worker = await createPrincipal('t_sub4', 'worker_sub4', 'worker', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/batch-test',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Batching test',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/batch-test#pr/50',
      idempotency_key: randomUUID(),
    });

    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:demo',
      capabilities: ['claude.patch'],
      kinds: ['patch'],
    });
    assert.equal(claimRes.task.id, taskId);

    const delivIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const payload = JSON.stringify({
        repository: { full_name: 'kamatbot/batch-test' },
        action: 'created',
        issue: { number: 50, pull_request: {} },
        comment: { body: `Feedback ${i}`, user: { login: 'mayurkamat', type: 'User' } },
      });
      const dId = randomUUID();
      delivIds.push(dId);
      await fetch(`${origin}/hooks/github/${source.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': dId,
          'x-hub-signature-256': sign(source.secret, payload),
        },
        body: payload,
      });
    }

    await tickSourceDeliveries(pool);

    const deferredRows = (await pool.query<any>(
      'SELECT status FROM source_deliveries WHERE source_id=$1 AND delivery_id=ANY($2::text[])',
      [source.id, delivIds]
    )).rows;
    assert.equal(deferredRows.length, 3);
    for (const row of deferredRows) {
      assert.equal(row.status, 'deferred');
    }

    const taskStillRunning = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskStillRunning.continuation_count, 0);
    assert.equal(taskStillRunning.status, 'running');

    await call(worker, 'task_finish', {
      task_id: taskId,
      lease_token: claimRes.lease_token,
      lease_generation: claimRes.lease_generation,
      outcome: 'completed',
      result: { branch: 'swarmaa/claude/test' },
    });

    await pool.query('UPDATE source_deliveries SET next_attempt_at = clock_timestamp() WHERE source_id=$1 AND delivery_id=ANY($2::text[])', [source.id, delivIds]);
    await tickSourceDeliveries(pool);

    const taskAfterBatch = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskAfterBatch.status, 'queued');
    assert.equal(taskAfterBatch.continuation_count, 1);

    const instructions = (await pool.query<any>(
      'SELECT * FROM task_instructions WHERE task_id=$1 ORDER BY created_at ASC',
      [taskId]
    )).rows;
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].idempotency_key, `source:${source.id}:${delivIds[0]}:3`);
    assert.ok(instructions[0].instruction.includes('Feedback 1'));
    assert.ok(instructions[0].instruction.includes('Feedback 2'));
    assert.ok(instructions[0].instruction.includes('Feedback 3'));

    const continuedRows = (await pool.query<any>(
      'SELECT status, task_id FROM source_deliveries WHERE source_id=$1 AND delivery_id=ANY($2::text[])',
      [source.id, delivIds]
    )).rows;
    assert.equal(continuedRows.length, 3);
    for (const row of continuedRows) {
      assert.equal(row.status, 'continued');
      assert.equal(row.task_id, taskId);
    }
  });

  it('budget exhaustion: stops auto-continuing after 5 events, deactivates subscription and posts notice', async () => {
    const owner = await createPrincipal('t_sub5', 'owner_sub5', 'admin', ['project:demo']);
    const leadAgent = await call(owner, 'agent_create', {
      name: 'lead5',
      role: 'Lead',
      instructions: 'Lead instructions',
      scope: 'project:demo',
      runner: { mode: 'auto' },
    });
    const bot = await call(owner, 'bot_create', {
      name: 'bot5',
      job: 'Bot job',
      scope: 'project:demo',
      lead_agent_id: leadAgent.agent.id,
      member_agent_ids: [leadAgent.agent.id],
    });

    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/budget-test',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Budget task',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;
    await pool.query('UPDATE tasks SET bot_id=$1, thread_id=$2 WHERE id=$3', [bot.bot.id, bot.bot.thread_id, taskId]);

    const subRes = await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/budget-test#pr/99',
      idempotency_key: randomUUID(),
    });
    assert.equal(subRes.subscription.budget_remaining, 5);

    for (let i = 1; i <= 5; i++) {
      await pool.query("UPDATE tasks SET status='completed', completed_at=clock_timestamp() WHERE id=$1", [taskId]);
      const payload = JSON.stringify({
        repository: { full_name: 'kamatbot/budget-test' },
        action: 'created',
        issue: { number: 99, pull_request: {} },
        comment: { body: `Event ${i}`, user: { login: 'mayurkamat', type: 'User' } },
      });
      await fetch(`${origin}/hooks/github/${source.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': sign(source.secret, payload),
        },
        body: payload,
      });
      await tickSourceDeliveries(pool);
    }

    const subAfter5 = (await pool.query<any>('SELECT * FROM task_subscriptions WHERE id=$1', [subRes.subscription.id])).rows[0];
    assert.equal(subAfter5.budget_remaining, 0);
    assert.equal(subAfter5.active, false);

    const noticeMsg = (await pool.query<any>(
      "SELECT * FROM messages WHERE thread_id=$1 AND kind='notice' ORDER BY created_at DESC LIMIT 1",
      [bot.bot.thread_id]
    )).rows[0];
    assert.ok(noticeMsg);
    assert.equal(noticeMsg.body, `Stopped auto-continuing ${taskId} after 5 GitHub events; resubscribe to continue.`);

    await pool.query("UPDATE tasks SET status='completed', completed_at=clock_timestamp() WHERE id=$1", [taskId]);
    const payload6 = JSON.stringify({
      repository: { full_name: 'kamatbot/budget-test' },
      action: 'created',
      issue: { number: 99, pull_request: {} },
      comment: { body: 'Event 6', user: { login: 'mayurkamat', type: 'User' } },
    });
    const deliv6 = randomUUID();
    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliv6,
        'x-hub-signature-256': sign(source.secret, payload6),
      },
      body: payload6,
    });
    await tickSourceDeliveries(pool);

    const taskFinal = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskFinal.continuation_count, 5);
  });

  it('cancelled or flow task deactivates subscription and delivery reason is task_not_continuable', async () => {
    const owner = await createPrincipal('t_sub6', 'owner_sub6', 'admin', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/cancelled-test',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Cancelled task test',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    const subRes = await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/cancelled-test#pr/77',
      idempotency_key: randomUUID(),
    });

    await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [taskId]);

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/cancelled-test' },
      action: 'created',
      issue: { number: 77, pull_request: {} },
      comment: { body: 'Event on cancelled task', user: { login: 'mayurkamat', type: 'User' } },
    });
    const deliveryId = randomUUID();
    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });

    await tickSourceDeliveries(pool);

    const subAfter = (await pool.query<any>('SELECT * FROM task_subscriptions WHERE id=$1', [subRes.subscription.id])).rows[0];
    assert.equal(subAfter.active, false);

    const deliveryRow = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(deliveryRow.status, 'ignored');
    assert.equal(deliveryRow.reason, 'task_not_continuable');
  });

  it('PR closed deactivates subscription on subscribed thread', async () => {
    const owner = await createPrincipal('t_sub7', 'owner_sub7', 'admin', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/close-test',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'PR close task',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    const subRes = await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/close-test#pr/88',
      idempotency_key: randomUUID(),
    });
    assert.equal(subRes.subscription.active, true);

    const closePayload = JSON.stringify({
      repository: { full_name: 'kamatbot/close-test' },
      action: 'closed',
      pull_request: { number: 88, title: 'Closed PR', head: { ref: 'patch' }, base: { ref: 'main' } },
    });
    const deliveryId = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, closePayload),
      },
      body: closePayload,
    });

    await tickSourceDeliveries(pool);

    const subAfterClose = (await pool.query<any>('SELECT * FROM task_subscriptions WHERE id=$1', [subRes.subscription.id])).rows[0];
    assert.equal(subAfterClose.active, false);

    const deliveryRow = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliveryId])).rows[0];
    assert.equal(deliveryRow.status, 'ignored');
    assert.equal(deliveryRow.reason, 'closed');
  });

  it('observe mode: records would_do continue_task only and sweep leaves task unchanged', async () => {
    const owner = await createPrincipal('t_sub8', 'owner_sub8', 'admin', ['project:demo']);
    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/observe-continue',
      rules: { allow_authors: ['mayurkamat'] },
    }, encKey);

    const taskRes = await call(owner, 'task_submit', {
      scope: 'project:demo',
      kind: 'patch',
      objective: 'Observe continue task',
      idempotency_key: randomUUID(),
      required_capability: 'claude.patch',
    });
    const taskId = taskRes.task.id;

    await call(owner, 'task_subscribe', {
      task_id: taskId,
      thread_ref: 'github:kamatbot/observe-continue#pr/12',
      idempotency_key: randomUUID(),
    });

    const payload = JSON.stringify({
      repository: { full_name: 'kamatbot/observe-continue' },
      action: 'created',
      issue: { number: 12, pull_request: {} },
      comment: { body: 'Observe comment', user: { login: 'mayurkamat', type: 'User' } },
    });
    const deliveryId = randomUUID();

    await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(source.secret, payload),
      },
      body: payload,
    });

    const deliveryBeforeSweep = (await pool.query<any>(
      'SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2',
      [source.id, deliveryId]
    )).rows[0];
    assert.equal(deliveryBeforeSweep.status, 'observed');
    assert.deepEqual(deliveryBeforeSweep.would_do, { continue_task: taskId });

    await tickSourceDeliveries(pool);

    const taskAfterSweep = (await pool.query<any>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
    assert.equal(taskAfterSweep.version, 1);
    assert.equal(taskAfterSweep.continuation_count, 0);
  });

  it('patch continuation worktree: continuing a completed patch task reuses branch and sets continued=true', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarmaa-wt-pin-'));
    try {
      await runExec('git', ['init', '-b', 'main', tempDir]);
      await runExec('git', ['-C', tempDir, 'config', 'user.name', 'Test']);
      await runExec('git', ['-C', tempDir, 'config', 'user.email', 'test@test.com']);
      await runExec('git', ['-C', tempDir, 'commit', '--allow-empty', '-m', 'initial']);

      const fakeTask: any = {
        id: randomUUID(),
        scope: 'project:demo',
        kind: 'patch',
        objective: 'Worktree pin test',
        base_ref: 'main',
      };

      const wt1 = await createWorktree(tempDir, 'claude', fakeTask);
      assert.equal(wt1.branch, `swarmaa/claude/${fakeTask.id}`);
      assert.equal(wt1.continued, false);

      await finishWorktree(tempDir, 'claude', fakeTask, wt1, 262144);

      const wt2 = await createWorktree(tempDir, 'claude', fakeTask);
      assert.equal(wt2.branch, `swarmaa/claude/${fakeTask.id}`);
      assert.equal(wt2.continued, true);

      await finishWorktree(tempDir, 'claude', fakeTask, wt2, 262144);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('source cooldown: second delivery inside cooldown is ignored as cooldown; resolved delivery bypasses cooldown', async () => {
    const owner = await createPrincipal('t_cooldown', 'owner_cooldown', 'admin', ['project:demo']);

    const lead = (await call(owner, 'agent_create', {
      name: 'Cooler', role: 'Lead', instructions: 'Help', scope: 'project:demo',
      runner: { provider: 'claude' }, edits: true,
    })).agent;
    const botRes = await call(owner, 'bot_create', {
      scope: 'project:demo',
      name: 'CooldownBot',
      job: 'handle cooldown events',
      lead_agent_id: lead.id, member_agent_ids: [lead.id],
    });
    const bot = botRes.bot;

    const source = await core.sources.createSource(owner, {
      scope: 'project:demo',
      repo_full_name: 'kamatbot/cooldown-test',
      bot_id: bot.id,
      cooldown_seconds: 60,
      rules: { allow_authors: ['mayurkamat'], mention: '@swarmaa' },
    }, encKey);
    await core.sources.setMode(owner, source.id, 'auto');

    // 1. First explicit delivery -> starts a task
    const deliv1 = randomUUID();
    const payload1 = JSON.stringify({
      repository: { full_name: 'kamatbot/cooldown-test' },
      comment: { body: 'Disk full alert @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 100, pull_request: {} },
    });
    const res1 = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliv1,
        'x-hub-signature-256': sign(source.secret, payload1),
      },
      body: payload1,
    });
    assert.equal(res1.status, 202);

    await tickSourceDeliveries(pool);

    const d1 = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliv1])).rows[0];
    assert.equal(d1.status, 'dispatched');

    const tasksAfter1 = (await pool.query<any>('SELECT count(*)::int FROM tasks WHERE bot_id=$1 AND initiator_kind=$2', [bot.id, 'source'])).rows[0].count;
    assert.equal(tasksAfter1, 1);

    // 2. Second delivery within 60s -> recorded as cooldown and starts no task
    const deliv2 = randomUUID();
    const payload2 = JSON.stringify({
      repository: { full_name: 'kamatbot/cooldown-test' },
      comment: { body: 'Disk full alert retry @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 100, pull_request: {} },
    });
    const res2 = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliv2,
        'x-hub-signature-256': sign(source.secret, payload2),
      },
      body: payload2,
    });
    assert.equal(res2.status, 202);

    await tickSourceDeliveries(pool);

    const d2 = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliv2])).rows[0];
    assert.equal(d2.status, 'ignored');
    assert.equal(d2.reason, 'cooldown');

    const tasksAfter2 = (await pool.query<any>('SELECT count(*)::int FROM tasks WHERE bot_id=$1 AND initiator_kind=$2', [bot.id, 'source'])).rows[0].count;
    assert.equal(tasksAfter2, 1); // No new task started!

    // 3. Third delivery within cooldown containing 'resolved' -> starts a task (recovery bypass)
    const deliv3 = randomUUID();
    const payload3 = JSON.stringify({
      repository: { full_name: 'kamatbot/cooldown-test' },
      comment: { body: 'Disk alert resolved @swarmaa', user: { login: 'mayurkamat', type: 'User' } },
      action: 'created',
      issue: { number: 100, pull_request: {} },
    });
    const res3 = await fetch(`${origin}/hooks/github/${source.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliv3,
        'x-hub-signature-256': sign(source.secret, payload3),
      },
      body: payload3,
    });
    assert.equal(res3.status, 202);

    await tickSourceDeliveries(pool);

    const d3 = (await pool.query<any>('SELECT * FROM source_deliveries WHERE source_id=$1 AND delivery_id=$2', [source.id, deliv3])).rows[0];
    assert.equal(d3.status, 'dispatched');
  });
});
