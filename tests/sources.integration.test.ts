/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { tickSourceDeliveries } from '../src/core/sources.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

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
});
