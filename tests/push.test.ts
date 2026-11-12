import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import {
  createAPNsSender,
  deliverPush,
  deliverLiveActivity,
  eventPayload,
  buildLiveActivityPayload,
  liveActivityHeaders,
  extractActivityStep,
  ActivityUpdateThrottle,
  shouldThrottleActivityUpdate,
  PushWorker,
  type Device,
  type PushEvent,
  type PushSender,
  type LiveActivityPayload,
} from '../src/push.js';
import type { Principal } from '../src/types.js';

const principal:Principal = {id:'11111111-1111-4111-8111-111111111111',tenantId:'tenant-a',name:'phone',role:'frontend',scopes:['project:test'],permissions:['agent:read']};
const token = 'ab'.repeat(32);
const device:Device = {token,tenant_id:principal.tenantId,principal_id:principal.id,environment:'sandbox',updated_at:'2026-10-28 15:20:00.123456+00'};
const bot = {id:'22222222-2222-4222-8222-222222222222',name:'Helper',avatar:'runner',color:'sky'};
const base:PushEvent = {name:'question.created',subject_id:'subject',tenant_id:principal.tenantId,scope:'project:test',payload:{thread_id:'thread',prompt:'SECRET message content'}};
function fakeDb(rows:unknown[] = []) {
  const calls:{sql:string;args:unknown[]}[] = [];
  return {calls,pool:{async query(sql:string,args:unknown[]=[]) { calls.push({sql,args}); return {rows}; }} as unknown as Pool};
}

test('push tools are permission filtered and enforce permission before SQL',async () => {
  const {pool,calls} = fakeDb();
  const core = new CoreService(pool);
  assert.deepEqual(core.listTools(principal).filter(t => t.name.startsWith('push_')).map(t => t.name),['push_register','push_unregister']);
  const denied = {...principal,permissions:[]};
  assert.equal(core.listTools(denied).some(t => t.name.startsWith('push_')),false);
  await assert.rejects(core.call(denied,'push_register',{token,environment:'sandbox'}));
  assert.equal(calls.length,0);
});

test('register normalizes/upserts ownership and unregister is tenant/principal fenced',async () => {
  const {pool,calls} = fakeDb();
  const core = new CoreService(pool);
  assert.deepEqual(await core.call(principal,'push_register',{token:token.toUpperCase(),environment:'production'}),{ok:true});
  assert.match(calls[0]!.sql,/ON CONFLICT \(token\) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,principal_id=EXCLUDED.principal_id/);
  assert.deepEqual(calls[0]!.args,[token,principal.tenantId,principal.id,'production']);
  const other = {...principal,id:'33333333-3333-4333-8333-333333333333',tenantId:'tenant-b'};
  await core.call(other,'push_register',{token,environment:'sandbox'});
  assert.deepEqual(calls[1]!.args,[token,other.tenantId,other.id,'sandbox']);
  assert.deepEqual(await core.call(principal,'push_unregister',{token}),{ok:true});
  assert.match(calls[2]!.sql,/WHERE token=\$1 AND tenant_id=\$2 AND principal_id=\$3/);
  assert.deepEqual(calls[2]!.args,[token,principal.tenantId,principal.id]);
});

test('push tools reject invalid tokens, environment and extra arguments without SQL',async () => {
  const {pool,calls} = fakeDb();
  const core = new CoreService(pool);
  for (const value of ['', 'a'.repeat(63),'g'.repeat(64),'a'.repeat(201)]) {
    await assert.rejects(core.call(principal,'push_register',{token:value,environment:'sandbox'}));
    await assert.rejects(core.call(principal,'push_unregister',{token:value}));
  }
  await assert.rejects(core.call(principal,'push_register',{token,environment:'other'}));
  await assert.rejects(core.call(principal,'push_unregister',{token,tenant_id:'other'}));
  assert.equal(calls.length,0);
});

test('event mapping emits only content-free fixed labels and bot identifiers',async () => {
  const {pool,calls} = fakeDb([bot]);
  const cases:[PushEvent,string][] = [
    [base,'Needs you'],
    [{...base,name:'message.created',payload:{...base.payload,kind:'text',author:{kind:'agent'},body:'SECRET'}},'Replied'],
    [{...base,name:'message.created',payload:{...base.payload,kind:'notice',author:{kind:'agent'}}},'Replied'],
    [{...base,name:'task.updated',payload:{action:'finished',status:'failed',result:{message:'SECRET'}}},'Task failed'],
    [{...base,name:'task.updated',payload:{action:'finished',status:'completed',result:{answer:'SECRET'}}},'Ready for review'],
  ];
  for (const [e,body] of cases) {
    const payload = await eventPayload(pool,e);
    assert.deepEqual(payload,{
      aps:{alert:{title:bot.name,body},sound:'default','thread-id':bot.id,'mutable-content':1},
      bot_id:bot.id,
      bot_name:bot.name,
      bot_avatar:bot.avatar,
      bot_color:bot.color,
    });
    assert.equal(JSON.stringify(payload).includes('SECRET'),false);
    assert.deepEqual(calls.at(-1)!.args.slice(1,3),[principal.tenantId,'project:test']);
  }
  assert.match(calls.at(-1)!.sql,/t.result->>'head_commit' IS NOT NULL/);
});

test('event mapping preserves null avatar and color when unset',async () => {
  const plainBot = {id:'44444444-4444-4444-8444-444444444444',name:'Plain',avatar:null,color:null};
  const {pool} = fakeDb([plainBot]);
  const payload = await eventPayload(pool,base);
  assert.deepEqual(payload,{
    aps:{alert:{title:'Plain',body:'Needs you'},sound:'default','thread-id':plainBot.id,'mutable-content':1},
    bot_id:plainBot.id,
    bot_name:'Plain',
    bot_avatar:null,
    bot_color:null,
  });
});

test('ignores humans, system notices, question cards, nonterminal and unrelated events',async () => {
  const {pool,calls} = fakeDb([bot]);
  for (const e of [
    {...base,name:'message.created',payload:{kind:'text',author:{kind:'human'}}},
    {...base,name:'message.created',payload:{kind:'notice',author:{kind:'system'}}},
    {...base,name:'message.created',payload:{kind:'question',author:{kind:'agent'}}},
    {...base,name:'task.updated',payload:{action:'checkpoint',status:'completed'}},
    {...base,name:'task.updated',payload:{action:'finished',status:'cancelled'}},
    {...base,name:'memory.changed'},
  ]) assert.equal(await eventPayload(pool,e),null);
  assert.equal(calls.length,0);
  assert.equal(await eventPayload(fakeDb().pool,base),null);
});

for (const result of [{status:400,reason:'BadDeviceToken'},{status:400,reason:'Unregistered'},{status:410}]) {
  test(`fake APNs ${result.status}/${result.reason ?? ''} deletes only the rejected device registration`,async () => {
    const {pool,calls} = fakeDb([bot]);
    const payload = (await eventPayload(pool,base))!;
    calls.length = 0;
    const sender:PushSender = {async send(d,p) { assert.equal(d,device); assert.equal(p,payload); return result; },close() {}};
    await deliverPush(pool,sender,device,payload);
    assert.equal(calls.length,1);
    assert.match(calls[0]!.sql,/DELETE FROM push_devices/);
    assert.deepEqual(calls[0]!.args,[token,principal.tenantId,principal.id,'sandbox',device.updated_at]);
  });
}

test('successful/transient APNs responses never prune devices',async () => {
  const {pool,calls} = fakeDb([bot]);
  const payload = (await eventPayload(pool,base))!;
  calls.length = 0;
  for (const status of [200,0,429,500,403]) {
    await deliverPush(pool,{async send() { return {status}; },close() {}},device,payload);
  }
  assert.equal(calls.length,0);
});

test('missing any APNs variable logs once, with no key reads, connections or sender calls',async () => {
  const keys = ['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_BUNDLE_ID'];
  for (const missing of keys) {
    const logs:string[] = [];
    const env = Object.fromEntries(keys.filter(k => k !== missing).map(k => [k,'placeholder']));
    const worker = new PushWorker({connect() { throw new Error('must stay off'); }} as unknown as Pool,{env,log:line => logs.push(line)});
    worker.start(); worker.start(); await worker.stop();
    assert.equal(logs.length,1);
    assert.match(logs[0]!,/disabled/);
    assert.equal(logs[0]!.includes('placeholder'),false);
  }
});

test('worker listens, catches up with fenced cursor, skips stale events and coalesces per bot',async () => {
  const calls:string[] = [];
  const sent:unknown[] = [];
  const events = [
    {...base,xid:'1',seq:'1',fresh:false},
    {...base,xid:'2',seq:'2',fresh:true},
    {...base,xid:'3',seq:'3',fresh:true},
  ];
  let cooldown = false;
  let finish!:()=>void;
  const committed = new Promise<void>(resolve => {finish = resolve;});
  const client = {
    on() {}, release() {},
    async query(sql:string,args:unknown[]=[]) {
      calls.push(sql);
      if (sql.startsWith('SELECT last_xid')) return {rows:[{last_xid:'0',last_seq:'0'}]};
      if (sql.includes('FROM events')) {
        assert.match(sql,/xid<pg_snapshot_xmin/);
        assert.match(sql,/ORDER BY xid,seq LIMIT 100/);
        return {rows:events};
      }
      if (sql.includes('FROM bots')) return {rows:[bot]};
      if (sql.includes('INSERT INTO push_cooldowns')) {
        assert.match(sql,/interval '20 seconds'/);
        const rows = cooldown ? [] : [{bot_id:bot.id}]; cooldown = true; return {rows};
      }
      if (sql.includes('FROM push_devices')) {assert.deepEqual(args,[principal.tenantId]); return {rows:[device,{...device,token:'cd'.repeat(32)}]};}
      if (sql === 'COMMIT') finish();
      return {rows:[]};
    },
  };
  const worker = new PushWorker({async connect() { return client; }} as unknown as Pool,{
    env:{APNS_KEY_PATH:'unused',APNS_KEY_ID:'unused',APNS_TEAM_ID:'unused',APNS_BUNDLE_ID:'unused'},
    sender:{async send(d,p) {sent.push({d,p}); return {status:200};},close() {}},
    log(message) {assert.fail(message);},
  });
  worker.start();
  await committed;
  await worker.stop();
  assert.equal(calls.filter(sql => sql === 'LISTEN swarmaa_events').length,1);
  assert.equal(calls.filter(sql => sql.includes('UPDATE push_cursor')).length,3);
  assert.equal(sent.length,2); // every device, once per bot; no stale notification
  assert.equal(JSON.stringify(sent).includes('SECRET'),false);
});

test('APNs sender signs ES256, reuses per-host sessions/JWT, refreshes at 50 minutes and retries once',async t => {
  const {generateKeyPairSync,verify} = await import('node:crypto');
  const {mkdtempSync,writeFileSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {EventEmitter} = await import('node:events');
  const {createAPNsSender} = await import('../src/push.js');
  const {privateKey,publicKey} = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const directory = mkdtempSync(join(tmpdir(),'swarmaa-push-test-'));
  const keyPath = join(directory,'test.p8');
  writeFileSync(keyPath,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  let now = 1_800_000_000_000;
  t.mock.method(Date,'now',() => now);
  const hosts:string[] = [];
  const requests:{headers:Record<string,string>;body:string}[] = [];
  const outcomes = [503,200,200,200,200,503,503];
  let closed = 0;
  const openSession = ((host:string) => {
    hosts.push(host);
    const session = new EventEmitter() as InstanceType<typeof EventEmitter> & {request:Function;destroy:Function;close:Function};
    session.destroy = () => {closed++;};
    session.close = () => {};
    session.request = (headers:Record<string,string>) => {
      const request = new EventEmitter() as InstanceType<typeof EventEmitter> & {setEncoding:Function;close:Function;end:Function};
      request.setEncoding = () => {};
      request.close = () => request.emit('close');
      request.end = (body:string) => {
        requests.push({headers,body});
        queueMicrotask(() => {
          request.emit('response',{':status':outcomes.shift() ?? 200});
          request.emit('data','{}');
          request.emit('end');
        });
      };
      return request;
    };
    return session;
  }) as unknown as typeof import('node:http2').connect;
  const sender = createAPNsSender({keyPath,keyId:'test-key',teamId:'test-team',bundleId:'test.bundle'},openSession);
  t.after(() => sender.close());
  const payload = (await eventPayload(fakeDb([bot]).pool,base))!;
  assert.equal((await sender.send(device,payload)).status,200);
  assert.equal(requests.length,2);
  await sender.send(device,payload);
  assert.equal(hosts.length,1);
  const first = requests[0]!.headers;
  assert.equal(first.authorization,requests[2]!.headers.authorization);
  assert.equal(first['apns-collapse-id'],bot.id);
  assert.equal(first['apns-push-type'],'alert');
  assert.equal(first['apns-priority'],'10');
  assert.equal(first['apns-topic'],'test.bundle');
  assert.equal(first[':path'],`/3/device/${token}`);
  assert.deepEqual(JSON.parse(requests[0]!.body),payload);
  const [header,claims,signature] = first.authorization!.slice(7).split('.') as [string,string,string];
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url').toString()),{alg:'ES256',kid:'test-key'});
  assert.deepEqual(JSON.parse(Buffer.from(claims,'base64url').toString()),{iss:'test-team',iat:Math.floor(now/1000)});
  assert.equal(verify('sha256',Buffer.from(`${header}.${claims}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
  now += 50*60_000;
  await sender.send(device,payload);
  assert.notEqual(requests[3]!.headers.authorization,first.authorization);
  await sender.send({...device,environment:'production'},payload);
  assert.deepEqual(hosts,['https://api.sandbox.push.apple.com','https://api.push.apple.com']);
  assert.equal((await sender.send(device,payload)).status,503);
  assert.equal(requests.length,7); // exactly one retry, even on repeated 503
  sender.close();
  assert.equal(closed,2);
});

test('a rejected old registration cannot delete a newly re-registered device',async () => {
  let row = {...device};
  const pool = {async query(_sql:string,args:unknown[]) {
    if (row.updated_at === args[4]) row = undefined as unknown as Device;
    return {rows:[]};
  }} as unknown as Pool;
  const payload = (await eventPayload(fakeDb([bot]).pool,base))!;
  const sender:PushSender = {
    async send() {
      row = {...device,updated_at:'2026-10-28 15:20:00.123457+00'};
      return {status:410};
    },close() {},
  };
  await deliverPush(pool,sender,device,payload);
  assert.equal(row.updated_at,'2026-10-28 15:20:00.123457+00');
});

test('pushDevice registers activity_start_token and per-bot activity_token', async () => {
  const { pool, calls } = fakeDb([{ scope: 'project:test' }]);
  const core = new CoreService(pool);
  const startToken = 'ee'.repeat(32);
  const actToken = 'ff'.repeat(32);
  const botId = '44444444-4444-4444-8444-444444444444';

  // 1. With activity_start_token
  await core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_start_token: startToken,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /activity_start_token/);
  assert.deepEqual(calls[0]!.args, [token, principal.tenantId, principal.id, 'production', startToken]);

  // 2. With activity_token and activity_bot_id
  calls.length = 0;
  await core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_token: actToken,
    activity_bot_id: botId,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /INSERT INTO push_devices/);
  assert.match(calls[1]!.sql, /SELECT scope FROM bots/);
  assert.match(calls[2]!.sql, /INSERT INTO bot_activity_tokens/);
  assert.match(calls[2]!.sql, /ON CONFLICT \(device_id,bot_id\) DO UPDATE SET token=EXCLUDED\.token/);
  assert.deepEqual(calls[2]!.args, [principal.tenantId, token, botId, actToken]);

  // 3. Rejects activity_token without activity_bot_id
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_token: actToken,
  }), /activity_token and activity_bot_id must be provided together/);

  // 4. Rejects activity_bot_id without activity_token
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_bot_id: botId,
  }), /activity_token and activity_bot_id must be provided together/);

  // 5. Rejects invalid hex/uuid
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_start_token: 'not-hex!',
  }));
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_start_token: 'a'.repeat(513),
  }));
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_token: 'not-hex',
    activity_bot_id: botId,
  }));
  await assert.rejects(core.call(principal, 'push_register', {
    token,
    environment: 'production',
    activity_token: actToken,
    activity_bot_id: 'not-a-uuid',
  }));
});

test('live activity payload builder generates exact start shape matching contract', () => {
  const botInfo = { id: bot.id, name: bot.name, avatar: '🤖', color: 'blue' };
  const payload = buildLiveActivityPayload({
    event: 'start',
    status: 'running',
    step: 'Scanning workspace',
    startedAt: 1700000000,
    bot: botInfo,
    now: 1700000010,
  });

  assert.equal(payload.bot_id, bot.id);
  assert.equal(payload.aps.event, 'start');
  assert.equal(payload.aps.timestamp, 1700000010);
  assert.equal(payload.aps['attributes-type'], 'BotTurnAttributes');
  assert.deepEqual(payload.aps.attributes, {
    botId: bot.id,
    botName: bot.name,
    avatar: '🤖',
    color: 'blue',
  });
  assert.deepEqual(payload.aps['content-state'], {
    status: 'running',
    step: 'Scanning workspace',
    startedAt: 1700000000,
  });
  assert.equal(payload.aps['dismissal-date'], undefined);
});

test('live activity payload builder generates exact update shape for running and needs_you', () => {
  const botInfo = { id: bot.id, name: bot.name };
  const updateRunning = buildLiveActivityPayload({
    event: 'update',
    status: 'running',
    step: 'Running tests',
    startedAt: 1700000000,
    bot: botInfo,
    now: 1700000020,
  });

  assert.equal(updateRunning.aps.event, 'update');
  assert.equal(updateRunning.aps.timestamp, 1700000020);
  assert.deepEqual(updateRunning.aps['content-state'], {
    status: 'running',
    step: 'Running tests',
    startedAt: 1700000000,
  });
  assert.equal(updateRunning.aps['attributes-type'], undefined);
  assert.equal(updateRunning.aps.attributes, undefined);
  assert.equal(updateRunning.aps['dismissal-date'], undefined);

  const updateNeedsYou = buildLiveActivityPayload({
    event: 'update',
    status: 'needs_you',
    step: 'Confirm migration deploy',
    startedAt: 1700000000,
    bot: botInfo,
    now: 1700000030,
  });

  assert.equal(updateNeedsYou.aps.event, 'update');
  assert.deepEqual(updateNeedsYou.aps['content-state'], {
    status: 'needs_you',
    step: 'Confirm migration deploy',
    startedAt: 1700000000,
  });
});

test('live activity payload builder generates exact end shape with now+15min dismissal', () => {
  const botInfo = { id: bot.id, name: bot.name };
  const now = 1700000000;
  const payloadDone = buildLiveActivityPayload({
    event: 'end',
    status: 'done',
    step: 'Finished task',
    startedAt: 1699999000,
    endedAt: now,
    bot: botInfo,
    now,
  });

  assert.equal(payloadDone.aps.event, 'end');
  assert.equal(payloadDone.aps.timestamp, now);
  assert.deepEqual(payloadDone.aps['content-state'], {
    status: 'done',
    step: 'Finished task',
    startedAt: 1699999000,
    endedAt: now,
  });
  assert.equal(payloadDone.aps['dismissal-date'], now + 15 * 60);

  const payloadFailed = buildLiveActivityPayload({
    event: 'end',
    status: 'failed',
    step: 'Tests failed',
    startedAt: 1699999000,
    endedAt: now,
    bot: botInfo,
    now,
  });

  assert.equal(payloadFailed.aps.event, 'end');
  assert.equal(payloadFailed.aps['content-state'].status, 'failed');
  assert.equal(payloadFailed.aps['dismissal-date'], now + 15 * 60);
});

test('extractActivityStep extracts latest activity label and enforces 80 char cap', () => {
  assert.equal(extractActivityStep(null), 'Working');
  assert.equal(extractActivityStep({}), 'Working');
  assert.equal(extractActivityStep({ activity: [] }), 'Working');
  assert.equal(extractActivityStep({ activity: [{ label: 'First', state: 'done' }, { label: 'Second step', state: 'running' }] }), 'Second step');
  const longLabel = 'A'.repeat(120);
  assert.equal(extractActivityStep({ activity: [{ label: longLabel, state: 'running' }] }), 'A'.repeat(80));
});

test('liveActivityHeaders sets correct liveactivity push-type, bundle topic and priorities', () => {
  const bundleId = 'com.swarmaa.ios';
  const targetToken = 'ff'.repeat(32);

  const startHeaders = liveActivityHeaders(bundleId, 'start', targetToken);
  assert.equal(startHeaders['apns-push-type'], 'liveactivity');
  assert.equal(startHeaders['apns-topic'], 'com.swarmaa.ios.push-type.liveactivity');
  assert.equal(startHeaders['apns-priority'], '10');
  assert.equal(startHeaders[':path'], `/3/device/${targetToken}`);

  const updateHeaders = liveActivityHeaders(bundleId, 'update', targetToken);
  assert.equal(updateHeaders['apns-push-type'], 'liveactivity');
  assert.equal(updateHeaders['apns-topic'], 'com.swarmaa.ios.push-type.liveactivity');
  assert.equal(updateHeaders['apns-priority'], '5');
  assert.equal(updateHeaders[':path'], `/3/device/${targetToken}`);

  const endHeaders = liveActivityHeaders(bundleId, 'end', targetToken);
  assert.equal(endHeaders['apns-push-type'], 'liveactivity');
  assert.equal(endHeaders['apns-topic'], 'com.swarmaa.ios.push-type.liveactivity');
  assert.equal(endHeaders['apns-priority'], '10');
  assert.equal(endHeaders[':path'], `/3/device/${targetToken}`);
});

test('ActivityUpdateThrottle throttles updates to at most once per 15s per bot', () => {
  const throttle = new ActivityUpdateThrottle(15_000);
  const botA = 'bot-a';
  const botB = 'bot-b';
  let t = 100_000;

  // First update allowed
  assert.equal(throttle.shouldUpdate(botA, t), true);
  // Immediate second update throttled
  assert.equal(throttle.shouldUpdate(botA, t + 1000), false);
  // Update at 14.9s still throttled
  assert.equal(throttle.shouldUpdate(botA, t + 14_999), false);
  // Different bot allowed immediately
  assert.equal(throttle.shouldUpdate(botB, t + 1000), true);
  // Update at 15.001s allowed
  assert.equal(throttle.shouldUpdate(botA, t + 15_001), true);

  // Helper function test
  assert.equal(shouldThrottleActivityUpdate(undefined), false);
  assert.equal(shouldThrottleActivityUpdate(t, t + 5_000, 15_000), true);
  assert.equal(shouldThrottleActivityUpdate(t, t + 16_000, 15_000), false);
});

for (const result of [{ status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'Unregistered' }, { status: 410 }]) {
  test(`deliverLiveActivity deletes rejected activity token on ${result.status}/${result.reason ?? ''}`, async () => {
    const { pool, calls } = fakeDb();
    const actToken = 'ff'.repeat(32);
    const payload = buildLiveActivityPayload({
      event: 'update',
      status: 'running',
      startedAt: 1700000000,
      bot,
    });
    const sender: PushSender = {
      async send(d, p, opt) {
        assert.equal(opt?.token, actToken);
        assert.equal(opt?.pushType, 'liveactivity');
        assert.equal(opt?.priority, '5');
        return result;
      },
      close() {},
    };

    await deliverLiveActivity(pool, sender, device, bot.id, payload, actToken, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /DELETE FROM bot_activity_tokens WHERE device_id=\$1 AND bot_id=\$2 AND token=\$3/);
    assert.deepEqual(calls[0]!.args, [device.token, bot.id, actToken]);
  });

  test(`deliverLiveActivity clears rejected activity_start_token on ${result.status}/${result.reason ?? ''}`, async () => {
    const { pool, calls } = fakeDb();
    const startToken = 'ee'.repeat(32);
    const payload = buildLiveActivityPayload({
      event: 'start',
      status: 'running',
      startedAt: 1700000000,
      bot,
    });
    const sender: PushSender = {
      async send(d, p, opt) {
        assert.equal(opt?.token, startToken);
        assert.equal(opt?.pushType, 'liveactivity');
        assert.equal(opt?.priority, '10');
        return result;
      },
      close() {},
    };

    await deliverLiveActivity(pool, sender, device, bot.id, payload, startToken, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /UPDATE push_devices SET activity_start_token=NULL/);
    assert.deepEqual(calls[0]!.args, [device.token, startToken]);
  });
}

test('createAPNsSender sends liveactivity pushes with correct headers, topic and priority', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { EventEmitter } = await import('node:events');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const directory = mkdtempSync(join(tmpdir(), 'swarmaa-push-live-test-'));
  const keyPath = join(directory, 'test.p8');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const requests: { headers: Record<string, string>; body: string }[] = [];
  const openSession = (() => {
    const session = new EventEmitter() as InstanceType<typeof EventEmitter> & { request: Function; destroy: Function; close: Function };
    session.destroy = () => {};
    session.close = () => {};
    session.request = (headers: Record<string, string>) => {
      const request = new EventEmitter() as InstanceType<typeof EventEmitter> & { setEncoding: Function; close: Function; end: Function };
      request.setEncoding = () => {};
      request.close = () => request.emit('close');
      request.end = (body: string) => {
        requests.push({ headers, body });
        queueMicrotask(() => {
          request.emit('response', { ':status': 200 });
          request.emit('data', '{}');
          request.emit('end');
        });
      };
      return request;
    };
    return session;
  }) as unknown as typeof import('node:http2').connect;

  const sender = createAPNsSender({ keyPath, keyId: 'test-key', teamId: 'test-team', bundleId: 'com.test.app' }, openSession);
  t.after(() => sender.close());

  const actToken = 'cc'.repeat(32);
  const livePayload = buildLiveActivityPayload({
    event: 'update',
    status: 'running',
    step: 'Compiling',
    startedAt: 1700000000,
    bot,
  });

  const res = await sender.send(device, livePayload, { token: actToken });
  assert.equal(res.status, 200);
  assert.equal(requests.length, 1);
  const h = requests[0]!.headers;
  assert.equal(h['apns-push-type'], 'liveactivity');
  assert.equal(h['apns-topic'], 'com.test.app.push-type.liveactivity');
  assert.equal(h['apns-priority'], '5');
  assert.equal(h[':path'], `/3/device/${actToken}`);
  assert.equal(h['apns-collapse-id'], undefined);
  assert.deepEqual(JSON.parse(requests[0]!.body), livePayload);
});

test('PushWorker sweep handles start, update, end and needs_you for live activities', async () => {
  const calls: string[] = [];
  const sentPushes: { device: Device; payload: any; options?: any }[] = [];
  const startToken = 'ee'.repeat(32);
  const actToken = 'ff'.repeat(32);
  const deviceWithTokens: Device = {
    ...device,
    activity_start_token: startToken,
  };

  const taskRow = {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'running',
    checkpoint: { activity: [{ label: 'Refactoring auth', state: 'running' }] },
    created_at: '2026-11-12 10:00:00+00',
    updated_at: '2026-11-12 10:05:00+00',
    completed_at: '2026-11-12 10:10:00+00',
    bot_id: bot.id,
    bot_name: bot.name,
    bot_avatar: '🤖',
    bot_color: 'orchid',
  };

  let eventToEmit: PushEvent & { xid: string; seq: string; fresh: boolean } = {
    name: 'task.updated',
    subject_id: taskRow.id,
    tenant_id: principal.tenantId,
    scope: 'project:test',
    payload: { action: 'claimed', status: 'running' },
    xid: '1',
    seq: '1',
    fresh: true,
  };

  let dbBotActivityTokens: { device_id: string; token: string }[] = [];
  const client = {
    on() {}, release() {},
    async query(sql: string, args: unknown[] = []) {
      calls.push(sql);
      if (sql.startsWith('SELECT last_xid')) return { rows: [{ last_xid: '0', last_seq: '0' }] };
      if (sql.includes('FROM events')) return { rows: [eventToEmit] };
      if (sql.includes('FROM tasks t JOIN bots b')) return { rows: [taskRow] };
      if (sql.includes('FROM bots') && sql.includes('thread_id')) return { rows: [{ id: bot.id, name: bot.name, avatar: '🤖', color: 'orchid' }] };
      if (sql.includes('FROM tasks') && sql.includes('bot_id')) return { rows: [{ checkpoint: taskRow.checkpoint, created_at: taskRow.created_at }] };
      if (sql.includes('INSERT INTO push_cooldowns')) return { rows: [{ bot_id: bot.id }] };
      if (sql.includes('FROM push_devices')) {
        assert.deepEqual(args, [principal.tenantId]);
        return { rows: [deviceWithTokens] };
      }
      if (sql.includes('FROM bot_activity_tokens')) return { rows: dbBotActivityTokens };
      if (sql.includes('UPDATE push_cursor')) return { rows: [] };
      if (sql === 'COMMIT') return { rows: [] };
      return { rows: [] };
    },
  };

  const senderMock: PushSender = {
    async send(d, p, opt) {
      sentPushes.push({ device: d, payload: p, options: opt });
      return { status: 200 };
    },
    close() {},
  };
  const worker = new PushWorker({ async connect() { return client; } } as unknown as Pool, {
    env: { APNS_KEY_PATH: 'unused', APNS_KEY_ID: 'unused', APNS_TEAM_ID: 'unused', APNS_BUNDLE_ID: 'unused' },
    sender: senderMock,
    log(m) { assert.fail(m); },
  });
  (worker as any).sender = senderMock;

  // 1. Task goes running, no activity_token -> sends start with push-to-start token
  await (worker as any).tick();
  assert.equal(sentPushes.length, 1);
  assert.equal(sentPushes[0]!.payload.aps.event, 'start');
  assert.equal(sentPushes[0]!.payload.aps['content-state'].status, 'running');
  assert.equal(sentPushes[0]!.payload.aps['content-state'].step, 'Refactoring auth');
  assert.equal(sentPushes[0]!.options.token, startToken);
  assert.equal(sentPushes[0]!.options.priority, '10');

  // 2. Task running with registered activity_token -> sends update with priority 5
  sentPushes.length = 0;
  dbBotActivityTokens = [{ device_id: device.token, token: actToken }];
  eventToEmit = { ...eventToEmit, xid: '2', seq: '2' };
  await (worker as any).tick();
  assert.equal(sentPushes.length, 1);
  assert.equal(sentPushes[0]!.payload.aps.event, 'update');
  assert.equal(sentPushes[0]!.payload.aps['content-state'].status, 'running');
  assert.equal(sentPushes[0]!.options.token, actToken);
  assert.equal(sentPushes[0]!.options.priority, '5');

  // 3. Immediate next tick is throttled (15s window)
  sentPushes.length = 0;
  eventToEmit = { ...eventToEmit, xid: '3', seq: '3' };
  await (worker as any).tick();
  assert.equal(sentPushes.length, 0); // Throttled

  // 4. Question asked -> updates status to needs_you
  sentPushes.length = 0;
  eventToEmit = {
    name: 'question.created',
    subject_id: 'q1',
    tenant_id: principal.tenantId,
    scope: 'project:test',
    payload: { thread_id: 'th-1', prompt: 'Choose branch' },
    xid: '4',
    seq: '4',
    fresh: true,
  };
  await (worker as any).tick();
  assert.equal(sentPushes.length, 2); // 1 alert push ('Needs you') + 1 live activity update ('needs_you')
  const liveUpdate = sentPushes.find(s => s.payload.aps.event === 'update')!;
  assert.ok(liveUpdate);
  assert.equal(liveUpdate.payload.aps['content-state'].status, 'needs_you');
  assert.equal(liveUpdate.options.token, actToken);

  // 5. Task completed -> sends end with dismissal-date now+15min
  sentPushes.length = 0;
  eventToEmit = {
    name: 'task.updated',
    subject_id: taskRow.id,
    tenant_id: principal.tenantId,
    scope: 'project:test',
    payload: { action: 'finished', status: 'completed', result: { head_commit: '123' } },
    xid: '5',
    seq: '5',
    fresh: true,
  };
  await (worker as any).tick();
  assert.equal(sentPushes.length, 2); // 1 alert push ('Ready for review') + 1 live activity end
  const liveEnd = sentPushes.find(s => s.payload.aps.event === 'end')!;
  assert.ok(liveEnd);
  assert.equal(liveEnd.payload.aps['content-state'].status, 'done');
  assert.equal(liveEnd.options.token, actToken);
  assert.equal(liveEnd.options.priority, '10');
  assert.ok(liveEnd.payload.aps['dismissal-date'] > liveEnd.payload.aps['content-state'].startedAt);

  await worker.stop();
});
