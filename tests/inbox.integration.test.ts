import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const connectionString=process.env.TEST_DATABASE_URL;
describe('durable inbox', {skip:!connectionString,concurrency:false},() => {
  const schema=`inbox_test_${randomUUID().replaceAll('-','')}`;
  let control:Pool,pool:Pool,core:CoreService,server:Server,origin:string;
  before(async () => {
    control=new pg.Pool({connectionString,max:1});
    await control.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    core=new CoreService(pool);
    const config:ServerConfig={host:'127.0.0.1',port:0,publicUrl:'http://127.0.0.1',allowedOrigins:[],allowInsecureLocalhost:true,
      maxBodyBytes:131072,oauthEnabled:false,oauthRedirectHosts:[],eventCallbackHosts:[],eventEncryptionKey:'0'.repeat(64)};
    server=createServer(createHttpHandler({pool,core,auth:new AuthService(pool),config}));
    await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
    config.port=(server.address() as {port:number}).port;
    origin=`http://127.0.0.1:${config.port}`;
  });
  after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(r => server.close(() => r()));
    await pool?.end();
    if (control) { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.end(); }
  });
  const call=async(p:Principal,name:string,args:Record<string,unknown>={}) => await core.call(p,name,args) as Record<string,any>;
  async function fixture() {
    const tenantId=randomUUID();
    const add=async(name:string,role:Principal['role']='frontend',tenant=tenantId,scopes=['project:a']) => {
      const p:Principal={id:randomUUID(),tenantId:tenant,name,role,scopes,permissions:[...ROLE_PERMISSIONS[role]]};
      const token=newToken();
      await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,p.tenantId,name,role,scopes,p.permissions,hashToken(token)]);
      return {...p,token};
    };
    return {a:await add('a'),b:await add('b'),worker:await add('worker','worker'),other:await add('a','frontend',randomUUID()),scope:await add('scope','frontend',tenantId,['project:b'])};
  }
  const submit=async(p:Principal) => (await call(p,'task_submit',{scope:'project:a',kind:'research',objective:'Inbox fixture',required_capability:'claude.read',idempotency_key:randomUUID()})).task;
  const claim=async(p:Principal) => call(p,'task_claim',{scope:'project:a',capabilities:['claude.read']});
  const finish=(p:Principal,c:any,outcome='completed',result:Record<string,unknown>={answer:'Verified fixture answer',provider:'claude'}) => call(p,'task_finish',{
    task_id:c.task.id,lease_token:c.lease_token,lease_generation:c.lease_generation,outcome,result,
  });
  const send=(p:Principal,to:string,body='fixture message',extra={}) => call(p,'message_send',{to,scope:'project:a',body,...extra});
  const reject=(fn:()=>Promise<unknown>,code:string) => assert.rejects(fn,(e:unknown) => e instanceof AppError && e.code===code);

  it('migration 020 assigns stable IDs and backfills legacy delivery as unconfirmed rather than accepted',async () => {
    const db=await pool.connect(),legacy=`inbox_legacy_${randomUUID().replaceAll('-','')}`;
    try {
      await db.query('BEGIN');
      await db.query(`CREATE SCHEMA ${legacy}`);
      await db.query(`SET LOCAL search_path=${legacy},public`);
      for (const file of ['001_identity.sql','002_core.sql','019_inbox.sql'])
        await db.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
      const principal=randomUUID();
      await db.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash)
        VALUES($1,'legacy','legacy','frontend','{project:a}','{}','fixture')`,[principal]);
      await db.query(`INSERT INTO inbox(id,tenant_id,recipient_principal,kind,scope,from_principal,body,delivered_at,read_at)
        SELECT gen_random_uuid(),'legacy',$1,'message','project:a',$1,'legacy',
          CASE WHEN n>0 THEN clock_timestamp() END,CASE WHEN n=2 THEN clock_timestamp() END FROM generate_series(0,2) n`,[principal]);
      await db.query(await readFile(new URL('../db/migrations/020_inbox_receipts.sql',import.meta.url),'utf8'));
      const ids=(await db.query('SELECT delivery_id FROM inbox')).rows.map(r => r.delivery_id);
      assert.equal(new Set(ids).size,3); assert.ok(ids.every(Boolean));
      const receipts=(await db.query('SELECT state,offers,session FROM inbox_receipt_status ORDER BY state')).rows;
      assert.deepEqual(receipts,[{state:'read',offers:1,session:''},{state:'unconfirmed',offers:1,session:''}]);
    } finally { await db.query('ROLLBACK'); db.release(); }
  });

  it('completion is atomic and replay-safe, with exactly one row per principal/session watcher',async () => {
    const f=await fixture(), task=await submit(f.a);
    for (let i=0;i<2;i++) await call(f.a,'task_watch',{task_id:task.id,session:'claude:a1'});
    await call(f.b,'task_watch',{task_id:task.id,session:'codex:b1'});
    const c=await claim(f.worker);
    const secret='cn_'+'x'.repeat(43), result={answer:`All done; token=${secret}`,provider:'claude'};
    await finish(f.worker,c,'completed',result); await finish(f.worker,c,'completed',result);
    const rows=(await pool.query('SELECT * FROM inbox WHERE task_id=$1',[task.id])).rows;
    assert.equal(rows.length,3);
    for (const row of rows) { assert.equal(row.kind,'task_finished'); assert.ok(!row.body.includes(secret)); assert.match(row.body,/task_get/); }
    const a=await call(f.a,'inbox_get'); assert.equal(a.items.length,1); assert.ok(a.items[0].delivered_at);
    assert.equal((await call(f.a,'inbox_get')).items.length,0);
    assert.equal((await call(f.a,'inbox_get',{session:'claude:a1'})).items.length,2,'principal-wide items are tracked separately in each session');
    assert.equal((await call(f.b,'inbox_get',{session:'codex:b1'})).items.length,1);
  });

  it('late and racing watches catch the terminal version, continuation creates a new update',async () => {
    const f=await fixture(),task=await submit(f.a),c=await claim(f.worker);
    await Promise.all([finish(f.worker,c),call(f.b,'task_watch',{task_id:task.id,session:'codex:race'})]);
    await call(f.b,'task_watch',{task_id:task.id,session:'codex:late'});
    assert.equal((await pool.query('SELECT * FROM inbox WHERE task_id=$1',[task.id])).rowCount,3);
    const ended=(await call(f.a,'task_get',{task_id:task.id})).task;
    await call(f.a,'task_continue',{task_id:task.id,expected_version:ended.version,instruction:'Try the next fixture',idempotency_key:randomUUID()});
    await finish(f.worker,await claim(f.worker),'blocked',{reason:'Need input'});
    assert.equal((await pool.query('SELECT * FROM inbox WHERE task_id=$1',[task.id])).rowCount,6);
  });

  it('failure, cancellation and exhausted leases notify, but queued/running tasks do not',async () => {
    const f=await fixture(),task=await submit(f.a);
    assert.equal((await call(f.a,'inbox_get')).items.length,0);
    await finish(f.worker,await claim(f.worker),'failed',{error:'fixture failure'});
    assert.match((await call(f.a,'inbox_get')).items[0].body,/failed on claude: fixture failure/);
    const cancel=await submit(f.a);
    await call(f.a,'task_cancel',{task_id:cancel.id,expected_version:cancel.version});
    assert.match((await call(f.a,'inbox_get')).items[0].body,/cancelled/);
    await submit(f.a); const c=await claim(f.worker);
    await pool.query("UPDATE tasks SET max_attempts=1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[c.task.id]);
    await claim(f.worker);
    assert.match((await call(f.a,'inbox_get')).items[0].body,/Worker lease expired/);
    assert.ok(task.id);
  });

  it('routes messages to a principal, a registered session and the current worker or submitter of a task',async () => {
    const f=await fixture(),task=await submit(f.a);
    await send(f.a,'b'); assert.equal((await call(f.b,'inbox_get')).items.length,1);
    await call(f.b,'inbox_get',{session:'agy:b1'});
    await call(f.b,'inbox_get',{session:'agy:other'});
    await send(f.a,'session:agy:b1');
    assert.equal((await call(f.b,'inbox_get')).items.length,0);
    assert.equal((await call(f.b,'inbox_get',{session:'agy:other'})).items.length,0);
    assert.equal((await call(f.b,'inbox_get',{session:'agy:b1'})).items.length,1);
    await send(f.b,`task:${task.id}`); assert.equal((await call(f.a,'inbox_get')).items.length,1);
    await claim(f.worker);
    await send(f.b,`task:${task.id}`); assert.equal((await call(f.worker,'inbox_get')).items.length,1);
  });

  it('enforces tenant, exact scope, permissions and session ownership in core',async () => {
    const f=await fixture(),task=await submit(f.a);
    await send(f.a,'b');
    assert.equal((await call(f.other,'inbox_get')).items.length,0);
    assert.equal((await call({...f.b,scopes:['project:b']},'inbox_get')).items.length,0);
    await reject(() => send(f.scope,'b'),'scope_forbidden');
    await reject(() => send(f.a,'scope'),'not_found');
    await reject(() => send(f.other,`task:${task.id}`),'not_found');
    await reject(() => call(f.other,'task_watch',{task_id:task.id,session:'claude:x'}),'not_found');
    await call(f.a,'inbox_get',{session:'claude:owned'});
    await reject(() => call(f.b,'inbox_get',{session:'claude:owned'}),'forbidden');
    await reject(() => call(f.b,'task_watch',{task_id:task.id,session:'claude:owned'}),'forbidden');
    for (const tool of ['inbox_get','message_send','task_watch']) await reject(() => call({...f.a,permissions:[]},tool,{}),'forbidden');
    const limited={...f.b,permissions:['events:read'] as Principal['permissions']};
    await send(f.a,'b','related',{task_id:task.id});
    assert.ok((await call(limited,'inbox_get')).items.every((i:any) => !i.task_id));
  });

  it('redacts before storage, rejects oversized bodies and applies a persistent per-sender rate limit',async () => {
    const f=await fixture();
    await send(f.a,'b','password="example-secret-123"');
    const stored=(await call(f.b,'inbox_get')).items[0];
    assert.ok(!stored.body.includes('example-secret-123'));
    await reject(() => send(f.a,'b','x'.repeat(2001)),'invalid_arguments');
    for (let i=1;i<30;i++) await send(f.a,'b');
    await reject(() => send(f.a,'b'),'message_limit');
    await send(f.b,'a');
  });

  it('concurrent delivery claims never return the same item and cursors cannot cross recipients',async () => {
    const f=await fixture();
    for (let i=0;i<5;i++) await send(f.a,'b');
    const pages=await Promise.all([call(f.b,'inbox_get',{limit:3}),call(f.b,'inbox_get',{limit:3})]);
    const ids=pages.flatMap(x => x.items.map((i:any) => i.id));
    assert.equal(ids.length,5); assert.equal(new Set(ids).size,5);
    await reject(() => call(f.other,'inbox_get',{after:ids[0]}),'not_found');
    assert.equal((await call(f.b,'inbox_get',{after:ids.at(-1)})).items.length,0);
  });

  it('delivery-id retries and duplicate acknowledgments work in a read-only database transaction',async () => {
    const f=await fixture(); await send(f.a,'b');
    const item=(await call(f.b,'inbox_poll',{session:'codex:exact'})).items[0];
    const snapshot=async () => (await pool.query(`SELECT row_to_json(r) AS receipt,r.xmin::text AS version FROM inbox_receipts r WHERE delivery_id=$1`,[item.delivery_id])).rows;
    const initial=await snapshot();
    const readonly=new pg.Pool({connectionString,max:1,options:`-c search_path=${schema},public -c default_transaction_read_only=on`});
    try {
      const reader=new CoreService(readonly);
      for (const name of ['inbox_get','inbox_poll']) {
        const result=await reader.call(f.b,name,{session:'codex:exact',delivery_id:item.delivery_id}) as any;
        assert.equal(result.items[0].state,'offered'); assert.equal(result.items[0].body,undefined);
      }
      assert.deepEqual(await snapshot(),initial);
      const accepted=await call(f.b,'inbox_ack',{session:'codex:exact',delivery_id:item.delivery_id});
      assert.equal(accepted.receipt.state,'accepted');
      const before=await snapshot();
      assert.equal((await reader.call(f.b,'inbox_ack',{session:'codex:exact',delivery_id:item.delivery_id}) as any).replayed,true);
      assert.deepEqual(await snapshot(),before);
    } finally { await readonly.end(); }
  });

  it('a dropped response becomes unconfirmed, reoffers twice with the same ID, then shows stuck without bodies',async () => {
    const f=await fixture(); await send(f.a,'b','private lost-response fixture');
    const session='claude:lost';
    const lost=createServer(async(_req,res) => {
      await call(f.b,'inbox_poll',{session});
      res.destroy(); // The reservation committed, but the hook never receives its body or delivery ID.
    });
    await new Promise<void>(r => lost.listen(0,'127.0.0.1',r));
    try { await assert.rejects(fetch(`http://127.0.0.1:${(lost.address() as {port:number}).port}`)); }
    finally { await new Promise<void>(r => lost.close(() => r())); }
    const original=(await pool.query(`SELECT r.* FROM inbox_receipts r JOIN inbox i USING(delivery_id) WHERE i.recipient_principal=$1`,[f.b.id])).rows[0];
    assert.equal(original.state,'offered'); assert.equal(original.offers,1);
    const expire=() => pool.query("UPDATE inbox_receipts SET confirm_by=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",[original.delivery_id]);
    for (let offers=2;offers<=3;offers++) {
      assert.equal((await call(f.b,'inbox_poll',{session})).items.length,0,'in-flight offers are not repeated');
      await expire();
      const before=(await call(f.b,'inbox_get',{session,delivery_id:original.delivery_id})).items[0];
      assert.equal(before.state,'unconfirmed'); assert.equal(before.body,undefined);
      const item=(await call(f.b,'inbox_poll',{session})).items[0];
      assert.equal(item.delivery_id,original.delivery_id); assert.equal(item.offers,offers); assert.equal(item.state,'offered');
    }
    await expire();
    for (let i=0;i<3;i++) assert.equal((await call(f.b,'inbox_poll',{session})).items.length,0);
    const status=await call(f.b,'swarm_status');
    assert.deepEqual(status.inbox.counts,{offered:0,accepted:0,unconfirmed:1,read:0,stuck:1});
    assert.equal(status.inbox.items[0].delivery_id,original.delivery_id); assert.equal(status.inbox.items[0].stuck,true);
    assert.ok(!JSON.stringify(status).includes('private lost-response fixture'));
    assert.equal((await pool.query('SELECT state FROM inbox_receipts WHERE delivery_id=$1',[original.delivery_id])).rows[0].state,'unconfirmed');
  });

  it('accepted bodies never return to that session, including racing polls, but another session has its own receipt',async () => {
    const f=await fixture(); await send(f.a,'b');
    const session='codex:accepted', item=(await call(f.b,'inbox_poll',{session})).items[0];
    await call(f.b,'inbox_ack',{session,delivery_id:item.delivery_id});
    const polls=await Promise.all(Array.from({length:4},() => call(f.b,'inbox_poll',{session})));
    assert.ok(polls.every(p => !p.items.length));
    const other=(await call(f.b,'inbox_poll',{session:'codex:independent'})).items[0];
    assert.equal(other.delivery_id,item.delivery_id); assert.equal(other.offers,1); assert.ok(other.body);
    const read=(await call(f.b,'inbox_get',{session})).items[0];
    assert.equal(read.state,'read'); assert.equal(read.body,undefined);
    assert.equal((await call(f.b,'inbox_poll',{session})).items.length,0);
    const status=await call(f.b,'inbox_get',{session,delivery_id:item.delivery_id});
    assert.equal(status.items[0].state,'read');
  });

  it('receipt lookup, acknowledgment and status isolate tenants, principals, scopes and task permissions',async () => {
    const f=await fixture(),task=await submit(f.a); await send(f.a,'b','private',{task_id:task.id});
    const session='agy:private', item=(await call(f.b,'inbox_poll',{session})).items[0];
    for (const principal of [f.other,f.a,{...f.b,scopes:['project:b']},{...f.b,permissions:['events:read'] as Principal['permissions']}]) {
      for (const name of ['inbox_get','inbox_poll','inbox_ack']) await reject(() => call(principal,name,{session,delivery_id:item.delivery_id}),'not_found');
    }
    await reject(() => call(f.b,'inbox_ack',{session:'agy:missing',delivery_id:item.delivery_id}),'not_found');
    for (const name of ['inbox_poll','inbox_ack']) await reject(() => call({...f.b,permissions:[]},name,{}),'forbidden');
    assert.deepEqual((await call(f.other,'swarm_status')).inbox,{counts:{offered:0,accepted:0,unconfirmed:0,read:0,stuck:0},items:[]});
    assert.equal((await call({...f.b,scopes:['project:b']},'swarm_status')).inbox.items.length,0);
    await reject(() => call(f.a,'inbox_poll',{session}),'forbidden');
  });

  it('task_get marks related items read only for the caller and chosen session, including unoffered items',async () => {
    const f=await fixture(),task=await submit(f.a); await send(f.a,'b','task notification',{task_id:task.id});
    const item=(await call(f.b,'inbox_poll',{session:'claude:reader'})).items[0];
    await call(f.a,'task_get',{task_id:task.id});
    assert.equal((await call(f.b,'inbox_get',{session:'claude:reader',delivery_id:item.delivery_id})).items[0].state,'offered');
    await call(f.b,'task_get',{task_id:task.id,session:'claude:reader'});
    assert.equal((await call(f.b,'inbox_get',{session:'claude:reader',delivery_id:item.delivery_id})).items[0].state,'read');
    assert.equal((await call(f.b,'inbox_poll',{session:'claude:reader'})).items.length,0);
    await call(f.b,'task_get',{task_id:task.id});
    assert.equal((await call(f.b,'inbox_poll')).items.length,0);
    assert.equal((await call(f.b,'inbox_poll',{session:'claude:unread'})).items.length,1);
  });

  it('long-poll receives a committed item in under 1 second, authenticates and times out cleanly',async () => {
    const f=await fixture();
    const waiting=fetch(`${origin}/api/inbox/wait?session=claude:wait&timeout=3`,{headers:{Authorization:`Bearer ${f.b.token}`}});
    // Session registration proves the initial read has reached the server; no production state is touched.
    const deadline=Date.now()+2000;
    while (!(await pool.query('SELECT 1 FROM inbox_sessions WHERE tenant_id=$1 AND session=$2',[f.b.tenantId,'claude:wait'])).rowCount) {
      assert.ok(Date.now()<deadline); await new Promise(r => setTimeout(r,10));
    }
    const started=Date.now();
    await send(f.a,'session:claude:wait','long-poll fixture');
    const response=await waiting;
    assert.equal(response.status,200);
    assert.equal(((await response.json()) as any).result.items[0].body,'long-poll fixture');
    assert.ok(Date.now()-started<1000);
    const start=Date.now();
    const empty=await fetch(`${origin}/api/inbox/wait?session=claude:wait&timeout=1`,{headers:{Authorization:`Bearer ${f.b.token}`}});
    assert.deepEqual(((await empty.json()) as any).result.items,[]);
    assert.ok(Date.now()-start>=900 && Date.now()-start<2000);
    assert.equal((await fetch(`${origin}/api/inbox/wait?session=claude:wait`)).status,401);
    assert.equal((await fetch(`${origin}/api/inbox/wait?session=claude:wait&timeout=26`,{headers:{Authorization:`Bearer ${f.b.token}`}})).status,400);
  });

  it('long-poll rechecks revocation before delivering and releases aborted listeners',async () => {
    const f=await fixture();
    const waiting=fetch(`${origin}/api/inbox/wait?session=codex:revoke&timeout=3`,{headers:{Authorization:`Bearer ${f.b.token}`}});
    const deadline=Date.now()+2000;
    while (!(await pool.query('SELECT 1 FROM inbox_sessions WHERE tenant_id=$1 AND session=$2',[f.b.tenantId,'codex:revoke'])).rowCount) {
      assert.ok(Date.now()<deadline); await new Promise(r => setTimeout(r,10));
    }
    await pool.query('UPDATE principals SET permissions=$2 WHERE id=$1',[f.b.id,[]]);
    // Metadata-only wake simulates a notification queued before the revoke committed.
    await pool.query("SELECT pg_notify('swarmaa_inbox',$1)",[f.b.id]);
    assert.equal((await waiting).status,403);
    const abort=new AbortController();
    const request=fetch(`${origin}/api/inbox/wait?session=claude:abort&timeout=25`,{headers:{Authorization:`Bearer ${f.a.token}`},signal:abort.signal});
    abort.abort(); await assert.rejects(request);
  });
});
