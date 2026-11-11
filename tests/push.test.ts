import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { deliverPush, eventPayload, PushWorker, type Device, type PushEvent, type PushSender } from '../src/push.js';
import type { Principal } from '../src/types.js';

const principal:Principal = {id:'11111111-1111-4111-8111-111111111111',tenantId:'tenant-a',name:'phone',role:'frontend',scopes:['project:test'],permissions:['agent:read']};
const token = 'ab'.repeat(32);
const device:Device = {token,tenant_id:principal.tenantId,principal_id:principal.id,environment:'sandbox',updated_at:'2026-10-28 15:20:00.123456+00'};
const bot = {id:'22222222-2222-4222-8222-222222222222',name:'Helper'};
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
    assert.deepEqual(payload,{aps:{alert:{title:bot.name,body},sound:'default','thread-id':bot.id},bot_id:bot.id});
    assert.equal(JSON.stringify(payload).includes('SECRET'),false);
    assert.deepEqual(calls.at(-1)!.args.slice(1,3),[principal.tenantId,'project:test']);
  }
  assert.match(calls.at(-1)!.sql,/t.result->>'head_commit' IS NOT NULL/);
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
