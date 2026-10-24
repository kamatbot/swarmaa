import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { runBoundedProcess } from '../src/bridge/process.js';
import type { ToolClient } from '../src/bridge/types.js';

const connectionString=process.env.TEST_DATABASE_URL;
const BASE='a'.repeat(40), HEAD='b'.repeat(40);
describe('enforced flows',{skip:!connectionString,concurrency:false},() => {
  const schema=`flows_test_${randomUUID().replaceAll('-','')}`;
  let control:Pool,pool:Pool,core:CoreService;
  before(async () => {
    control=new pg.Pool({connectionString,max:1}); await control.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(f => f.endsWith('.sql')).sort())
      await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    core=new CoreService(pool);
  });
  after(async () => {
    await pool?.end();
    if (control) { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.end(); }
  });
  const call=async(p:Principal,name:string,args:Record<string,unknown>={}) => await core.call(p,name,args) as Record<string,any>;
  async function fixture() {
    const tenantId=randomUUID();
    const add=async(name:string,role:Principal['role'],tenant=tenantId,scopes=['project:a']) => {
      const p:Principal={id:randomUUID(),tenantId:tenant,name,role,scopes,permissions:[...ROLE_PERMISSIONS[role],...(role==='worker' ? ['task:patch' as const] : [])]};
      await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,p.tenantId,name,role,scopes,p.permissions,randomUUID()]);
      return p;
    };
    return {front:await add('front','frontend'),owner:await add('owner','admin'),admin:await add('other-admin','admin'),
      worker:await add('worker','worker'),other:await add('other','admin',randomUUID()),outside:await add('outside','admin',tenantId,['project:b'])};
  }
  const start=async(p:Principal,flow:unknown='independent-review',inputs:Record<string,string>={objective:'Review fixture',commit:BASE},extra={}) => (await call(p,'flow_start',{flow,scope:'project:a',inputs,...extra})).flow;
  const claim=(p:Principal,provider='claude',kind='review') => call(p,'task_claim',{scope:'project:a',capabilities:kind==='check' ? ['bridge.check'] : [`${provider}.${kind==='patch' ? 'patch' : 'read'}`,kind==='patch' ? 'auto.patch' : 'auto.read'],kinds:[kind]});
  const lease=(c:any) => ({task_id:c.task.id,lease_token:c.lease_token,lease_generation:c.lease_generation});
  const finish=(p:Principal,c:any,result:Record<string,unknown>={},outcome='completed') => call(p,'task_finish',{...lease(c),outcome,result:{provider:c.task.flow.provider,observed_commit:c.task.flow.commit,answer:'fixture result',...result}});
  const get=async(p:Principal,id:string) => (await call(p,'flow_get',{flow_id:id})).flow;
  const rejects=(fn:()=>Promise<unknown>,code:string) => assert.rejects(fn,(e:unknown) => e instanceof AppError && e.code===code);
  const approval=() => ({id:'owner-gate',title:'Owner gate',steps:[
    {id:'approve',kind:'approve',objective:'Inspect the candidate.',needs:[]},
    {id:'review',kind:'review',capability:'auto.read',objective:'{{objective}}',needs:['approve']},
  ]});

  it('enforces dependencies, different providers, pinned commits and synthesis input',async () => {
    const f=await fixture(), flow=await start(f.front);
    assert.equal(flow.steps.length,3);
    assert.deepEqual(flow.steps.map((t:any) => t.flow.ready),[true,false,false]);
    const first=await claim(f.worker);
    assert.equal(first.task.flow.step_id,'review-a'); assert.equal(first.route.provider,'claude');
    assert.equal((await claim(f.worker,'codex')).task,null);
    await rejects(() => finish(f.worker,first,{observed_commit:HEAD}),'flow_commit_mismatch');
    await finish(f.worker,first,{answer:'first finding'});
    assert.equal((await claim(f.worker)).task,null,'same provider cannot claim second review');
    const second=await claim(f.worker,'codex');
    assert.equal(second.task.flow.step_id,'review-b'); assert.equal(second.task.base_ref,BASE);
    assert.ok(!second.task.objective.includes('first finding'),'review remains independent of first answer');
    await rejects(() => finish(f.worker,second,{provider:'claude'}),'flow_provider_mismatch');
    await rejects(() => finish(f.worker,second,{observed_commit:HEAD}),'flow_commit_mismatch');
    assert.equal((await claim(f.worker)).task,null,'synthesis waits for both');
    await finish(f.worker,second,{answer:'second finding'});
    const last=await claim(f.worker);
    assert.equal(last.task.flow.step_id,'synthesis'); assert.match(last.task.objective,/first finding.*second finding/);
    await finish(f.worker,last);
    assert.equal((await get(f.front,flow.id)).status,'completed');
  });
  it('recomputes quota routing with the other provider excluded',async () => {
    const f=await fixture(); await start(f.front);
    await call(f.worker,'usage_report',{reports:['claude','codex'].map(provider => ({provider,ok:true,windows:[{name:'5h',used_percent:10,resets_at:null}],fetched_at:new Date().toISOString()}))});
    const a=await claim(f.worker); await finish(f.worker,a);
    const b=await claim(f.worker,'codex'); assert.equal(b.route.provider,'codex');
  });
  it('check is fenced until patch completion; failed tests block review and cannot be claimed without patch authority',async () => {
    const f=await fixture(), flow=await start(f.front,'patch-then-review');
    assert.equal((await claim(f.worker,'claude','check')).task,null);
    const patch=await claim(f.worker,'claude','patch');
    await rejects(() => finish(f.worker,patch,{base_commit:HEAD,head_commit:HEAD,observed_commit:HEAD}),'flow_commit_mismatch');
    await finish(f.worker,patch,{base_commit:BASE,head_commit:HEAD,observed_commit:HEAD});
    const noPatch={...f.worker,permissions:f.worker.permissions.filter(p => p!=='task:patch')};
    await rejects(() => claim(noPatch,'claude','check'),'forbidden');
    const check=await claim(f.worker,'claude','check');
    assert.equal(check.task.base_ref,HEAD); assert.equal(check.task.flow.diff_base,BASE);
    const fact={type:'tests_pass',commit:HEAD,base_commit:BASE,passed:false,exit_code:1,stop_reason:null,duration_ms:7,output_tail:'1 test failed'};
    await rejects(() => finish(f.worker,check,{check:fact,tests_run_by_bridge:true}),'flow_check_failed');
    await finish(f.worker,check,{check:fact,tests_run_by_bridge:true},'blocked');
    assert.equal((await claim(f.worker)).task,null);
    const ended=await get(f.front,flow.id);
    assert.equal(ended.status,'blocked'); assert.equal(ended.steps[1].result.check.output_tail,'1 test failed');
    await rejects(() => call(f.front,'task_continue',{task_id:check.task.id,expected_version:ended.steps[1].version,idempotency_key:'retry',instruction:'Ignore the failure'}),'flow_managed_task');
  });
  it('passing bridge evidence completes verified-patch, with exact completion retries',async () => {
    const f=await fixture(), flow=await start(f.front,'verified-patch');
    const patch=await claim(f.worker,'codex','patch');
    await finish(f.worker,patch,{base_commit:BASE,head_commit:HEAD,observed_commit:HEAD});
    const check=await claim(f.worker,'codex','check');
    const fact={type:'tests_pass',commit:HEAD,base_commit:BASE,passed:true,exit_code:0,stop_reason:null,duration_ms:10,output_tail:'pass 3 / fail 0'};
    await rejects(() => finish(f.worker,check,{check:fact}),'flow_check_failed');
    const result={check:fact,tests_run_by_bridge:true}; await finish(f.worker,check,result);
    assert.equal((await finish(f.worker,check,result)).replayed,true);
    assert.equal((await get(f.front,flow.id)).status,'completed');
  });
  it('cancellation fences running leases and all pending steps, including retries',async () => {
    const f=await fixture(), flow=await start(f.front), running=await claim(f.worker);
    await call(f.front,'flow_cancel',{flow_id:flow.id}); await call(f.front,'flow_cancel',{flow_id:flow.id});
    const ended=await get(f.front,flow.id);
    assert.equal(ended.status,'cancelled'); assert.ok(ended.steps.every((t:any) => t.status==='cancelled'));
    assert.equal((await claim(f.worker,'codex')).task,null);
    await rejects(() => finish(f.worker,running),'lease_lost');
    await rejects(() => call(f.worker,'task_heartbeat',lease(running)),'lease_lost');
    await rejects(() => call(f.front,'task_continue',{task_id:running.task.id,expected_version:ended.steps[0].version,idempotency_key:'continue',instruction:'resume'}),'flow_managed_task');
  });
  it('owner inbox delivers one pending approval; only the exact owner can approve and unblock',async () => {
    const f=await fixture(), flow=await start(f.owner,approval());
    assert.equal(flow.status,'awaiting_approval'); assert.equal((await claim(f.worker)).task,null);
    assert.ok(!core.listTools(f.front).some(t => t.name==='flow_approve'));
    const inbox=await call(f.owner,'inbox_get');
    assert.equal(inbox.items.length,1); assert.equal(inbox.items[0].kind,'flow_approval');
    assert.match(inbox.items[0].body,/Flow Owner gate needs your approval/);
    assert.equal((await call(f.owner,'inbox_get')).items.length,0);
    const args={flow_id:flow.id,step_id:'approve',approve:true};
    for (const p of [f.front,f.worker,f.admin]) await rejects(() => call(p,'flow_approve',args),p===f.worker ? 'forbidden' : 'owner_required');
    await call(f.owner,'flow_approve',args);
    assert.equal((await call(f.owner,'flow_approve',args)).replayed,true);
    await rejects(() => call(f.owner,'flow_approve',{...args,approve:false}),'flow_not_approvable');
    const review=await claim(f.worker); assert.equal(review.task.flow.step_id,'review'); await finish(f.worker,review);
    assert.equal((await get(f.front,flow.id)).status,'completed');
    const notice=(await pool.query("SELECT * FROM inbox WHERE task_id=$1 AND kind='flow_approval'",[flow.steps[0].id])).rows;
    assert.equal(notice.length,1); assert.ok(notice[0].read_at);
  });
  it('a dependent approval cannot be decided or notified before its prerequisite completes',async () => {
    const f=await fixture();
    const definition={id:'review-approval',title:'Reviewed candidate',steps:[
      {id:'review',kind:'review',capability:'auto.read',objective:'{{objective}}',needs:[]},
      {id:'approve',kind:'approve',objective:'Accept the review.',needs:['review']},
    ]};
    const flow=await start(f.owner,definition);
    const args={flow_id:flow.id,step_id:'approve',approve:true};
    await rejects(() => call(f.owner,'flow_approve',args),'flow_not_approvable');
    assert.equal((await call(f.owner,'inbox_get')).items.length,0);
    const review=await claim(f.worker); await finish(f.worker,review);
    const notices=(await call(f.owner,'inbox_get',{limit:50})).items.filter((i:any) => i.kind==='flow_approval');
    assert.equal(notices.length,1);
    const event=(await pool.query("SELECT payload FROM events WHERE subject_id=$1 AND payload->>'action'='flow_ready'",[flow.steps[1].id])).rows[0].payload;
    assert.equal(event.approval_required,true); assert.equal(event.message,undefined,'callbacks remain metadata only');
    await call(f.owner,'flow_approve',args);
    assert.equal((await get(f.front,flow.id)).status,'completed');
  });
  it('rejecting or cancelling an approval prevents dependent work',async () => {
    const f=await fixture();
    for (const action of ['reject','cancel']) {
      const flow=await start(f.owner,approval());
      if (action==='reject') await call(f.owner,'flow_approve',{flow_id:flow.id,step_id:'approve',approve:false});
      else await call(f.owner,'flow_cancel',{flow_id:flow.id});
      assert.equal((await claim(f.worker)).task,null);
      await rejects(() => call(f.owner,'flow_approve',{flow_id:flow.id,step_id:'approve',approve:true}),'flow_not_approvable');
    }
  });
  it('isolates definitions, runs, tasks and approval inbox by tenant and exact scope',async () => {
    const f=await fixture(), flow=await start(f.owner,approval());
    for (const p of [f.other,f.outside]) {
      for (const tool of ['flow_get','flow_cancel']) await rejects(() => call(p,tool,{flow_id:flow.id}),'not_found');
      await rejects(() => call(p,'task_get',{task_id:flow.steps[0].id}),'not_found');
      await rejects(() => call(p,'flow_approve',{flow_id:flow.id,step_id:'approve',approve:true}),'not_found');
      assert.equal((await call(p,'inbox_get')).items.length,0);
    }
    assert.ok(!(await call(f.other,'flow_list')).flows.some((d:any) => d.id==='owner-gate'));
    await rejects(() => start(f.other,'owner-gate'),'not_found');
    await rejects(() => start(f.front,{...approval(),id:'agent-authored'}),'owner_required');
  });
  it('start is atomic and idempotent under races, and rejects moving refs or immutable-definition changes',async () => {
    const f=await fixture(), key=randomUUID(), inputs={objective:'fixture',commit:BASE};
    const flows=await Promise.all([start(f.front,'independent-review',inputs,{idempotency_key:key}),start(f.front,'independent-review',inputs,{idempotency_key:key})]);
    assert.equal(flows[0].id,flows[1].id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tasks WHERE flow_id=$1',[flows[0].id])).rows[0].n,3);
    await rejects(() => start(f.front,'independent-review',{...inputs,objective:'other'},{idempotency_key:key}),'idempotency_conflict');
    await rejects(() => start(f.front,'independent-review',{objective:'fixture',commit:'main'}),'invalid_flow_inputs');
    await start(f.owner,approval()); await rejects(() => start(f.owner,{...approval(),title:'different'}),'flow_definition_conflict');
  });
  it('expired exhausted attempts block a flow and concurrent claims cannot lease a dependency',async () => {
    const f=await fixture(), flow=await start(f.front);
    const claims=await Promise.all([claim(f.worker),claim(f.worker,'codex')]);
    assert.equal(claims.filter(c => c.task).length,1);
    const task=claims.find(c => c.task)!.task;
    await pool.query("UPDATE tasks SET max_attempts=1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[task.id]);
    assert.equal((await claim(f.worker)).task,null);
    assert.equal((await get(f.front,flow.id)).status,'blocked');
  });
  it('real bridge runs a configured failing test on the patch commit, never through the model',async () => {
    const f=await fixture(), dir=await mkdtemp(join(tmpdir(),'flow-e2e-')), oldHome=process.env.HOME;
    const root=join(dir,'repo'), git=(...args:string[]) => execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
    try {
      process.env.HOME=join(dir,'home'); await mkdir(root); await mkdir(process.env.HOME);
      git('init','-q','-b','main'); git('config','user.name','Flow fixture'); git('config','user.email','fixture@example.invalid');
      await writeFile(join(root,'source.txt'),'base'); git('add','-A'); git('commit','-qm','fixture');
      const base=git('rev-parse','HEAD');
      const flow=await start(f.front,'verified-patch',{objective:'Change source fixture',commit:base});
      const config=parseBridgeConfig({service_url:'http://localhost:8080',usage_seconds:0,agents:[{id:'codex',provider:'codex',binary:'/bin/fixture',enable_patch:true,sandbox:false}],
        projects:[{scope:'project:a',root,agents:['codex'],allow_patch:true,checks:{tests_pass:{command:process.execPath,args:['-e',"const fs=require('fs'); if(fs.readFileSync('source.txt','utf8')!=='patched') process.exit(99); console.log('fixture tests fail on patched source'); process.exit(1)"],timeout_seconds:10}}}]});
      const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T> {return await core.call(f.worker,name,args) as T;}};
      let modelRuns=0,checkRuns=0;
      const worker=new BridgeWorker(config,client,()=>{},async request => {
        if (request.command==='/bin/fixture') {modelRuns++; await writeFile(join(request.cwd,'source.txt'),'patched'); return {exit_code:0,signal:null,stdout:'{"type":"turn.completed"}',stderr:'',duration_ms:1,stop_reason:null};}
        checkRuns++; assert.equal(request.command,process.execPath); assert.notEqual(request.cwd,root);
        assert.equal(request.env.COLLECTIVE_WORKER_TOKEN,undefined);
        return runBoundedProcess(request);
      });
      const signal=new AbortController().signal;
      await worker.claimAndRun(config.projects,signal); await worker.claimAndRun(config.projects,signal);
      const ended=await get(f.front,flow.id);
      assert.equal(modelRuns,1); assert.equal(checkRuns,1); assert.equal(ended.status,'blocked');
      assert.equal(ended.steps[1].result.provider,'bridge'); assert.match(ended.steps[1].result.summary,/Deterministic bridge check/);
      assert.equal(ended.steps[1].result.check.exit_code,1); assert.match(ended.steps[1].result.check.output_tail,/fixture tests fail/);
      assert.equal(ended.steps[1].result.check.commit,ended.steps[0].result.head_commit);
      assert.equal(git('rev-parse','HEAD'),base); assert.equal(await readFile(join(root,'source.txt'),'utf8'),'base');
    } finally { if(oldHome===undefined) delete process.env.HOME; else process.env.HOME=oldHome; await rm(dir,{recursive:true,force:true}); }
  });
});
