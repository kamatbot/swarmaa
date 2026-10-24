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
    assert.equal((await call(f.a,'inbox_get',{session:'claude:a1'})).items.length,1);
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
