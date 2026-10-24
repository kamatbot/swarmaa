import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeWorker } from '../src/bridge/worker.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { RemoteError } from '../src/bridge/client.js';
import { SANDBOX_EXEC } from '../src/bridge/sandbox.js';
import type { ProcessRequest, ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const config = () => parseBridgeConfig({ service_url:'http://localhost:8080', agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:true}], projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude']}] });
const task: Task = { id:'11111111-1111-4111-8111-111111111111',scope:'project:demo',kind:'review',objective:'Review source',constraints:[],acceptance_criteria:[],resource_key:null,required_capability:'claude.read',checkpoint:null,context_refs:[],version:1 };
const result: ProcessResult = {exit_code:0,signal:null,stdout:'{"type":"result","subtype":"success","is_error":false}',stderr:'',duration_ms:10,stop_reason:null,input_delivered:true};

// Every test has an isolated provider profile. Mocked Codex runs must never copy
// the developer's real login or write native history into the developer's HOME.
let savedHome: string | undefined;
let testHome: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  testHome = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-worker-test-')));
  process.env.HOME = testHome;
  mkdirSync(join(testHome, '.codex'));
  writeFileSync(join(testHome, '.codex/auth.json'), '{"tokens":{"access_token":"test-only","account_id":"fixture"}}', { mode: 0o600 });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(testHome, { recursive: true, force: true });
});

const BATCH = '33333333-3333-4333-8333-333333333333';
function protocolReply(name: string): unknown {
  if (name === 'task_handoff') return { handoff: { schema_version: 1, scope: task.scope, task, context_is_untrusted: true } };
  if (name === 'task_message_pull') return { batch_id: BATCH, messages: [], has_more: false, guidance: 'Quoted task context; delivery is for this invocation only.' };
  if (name === 'task_message_ack') return { acknowledged: true };
  return undefined;
}
function wrappedBinary(request: ProcessRequest): string {
  assert.equal(request.command, SANDBOX_EXEC);
  assert.equal(request.args[0], '-p');
  assert.match(request.args[1]!, /\(deny default\)/u);
  assert.equal(request.env.HOME, testHome);
  return request.args[2]!;
}

test('successful worker stores provenance, transcript and explicit unverified acceptance', async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task} as T;
  } };
  const cfg = config();
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {assert.ok(!request.input.includes('lease-secret'));return result;});
  assert.equal(await worker.claimAndRun(cfg.projects,new AbortController().signal),true);
  const finish = calls.find(call=>call.name==='task_finish')!;
  assert.equal(finish.args.outcome,'completed');
  assert.equal((finish.args.result as Record<string,unknown>).acceptance_criteria_verified,false);
  assert.equal(calls.filter(call=>call.name==='artifact_put').length,1);
  assert.deepEqual((calls[0]!.args.projects as {kinds:string[]}[])[0]!.kinds,['research','review']);
});

test('message delivery records the observed process boundary independently of provider success', async () => {
  for (const inputDelivered of [true, false, undefined]) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let scratch: string | undefined;
    const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'task_claim') return { task, lease_token: 'lease-secret', lease_generation: 1 } as T;
      if (name === 'context_get') return { scope: task.scope, task, memories: [], conflicts: [] } as T;
      if (name === 'task_handoff') return { handoff: { prior_attempt: 'handoff-evidence', untrusted: true } } as T;
      if (name === 'task_message_pull') return { batch_id: BATCH, messages: [{ id: 'message-id', body: 'queued-guidance', untrusted: true }], has_more: false, guidance: 'Quoted task context.' } as T;
      if (name === 'artifact_put') return { artifact: { id: 'artifact-id' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      return { acknowledged: true } as T;
    } };
    const cfg = config();
    await new BridgeWorker(cfg, client, () => {}, async request => {
      wrappedBinary(request);
      scratch = request.env.TMPDIR;
      assert.ok(existsSync(scratch!));
      assert.match(request.input, /handoff-evidence/u);
      assert.match(request.input, /queued-guidance/u);
      assert.match(request.input, /next_invocation_only/u);
      assert.equal(calls.some(c => c.name === 'task_message_ack'), false, 'a batch was acknowledged before the invocation returned');
      return { ...result, input_delivered: inputDelivered, exit_code: 1, stdout: '{"type":"result","subtype":"error","is_error":true}' };
    }).claimAndRun(cfg.projects, new AbortController().signal);
    assert.equal(existsSync(scratch!), false, 'private invocation scratch was retained');
    const receipt = calls.find(c => c.name === 'task_message_ack')!.args;
    assert.equal(receipt.batch_id, BATCH);
    assert.equal(receipt.status, inputDelivered === true ? 'delivered' : 'deferred');
    assert.equal(receipt.lease_token, 'lease-secret');
    const finish = calls.find(c => c.name === 'task_finish')!.args;
    assert.equal(finish.outcome, 'failed');
    assert.equal((finish.result as Record<string, any>).message_delivery.input_delivery_observed, inputDelivered === true);
    assert.equal((finish.result as Record<string, any>).message_delivery.acknowledgement_is_not_task_success, true);
  }
});

test('a frozen message batch is deferred when invocation construction or execution throws', async () => {
  const receipts: Record<string, unknown>[] = [];
  const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (name === 'task_claim') return { task, lease_token: 'lease-secret', lease_generation: 1 } as T;
    if (name === 'context_get') return { task, memories: [], conflicts: [] } as T;
    if (name === 'task_message_ack') { receipts.push(args); return { acknowledged: true } as T; }
    const reply = protocolReply(name); if (reply !== undefined) return reply as T;
    return { task } as T;
  } };
  const cfg = config();
  await new BridgeWorker(cfg, client, () => {}, async () => { throw new Error('runner could not start'); })
    .claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, 'deferred');
  assert.equal(receipts[0]!.reason, 'invocation_not_completed');
});

test('an ambiguous message acknowledgement is retried with the identical receipt', async () => {
  const receipts: Record<string, unknown>[] = [];
  const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (name === 'task_claim') return { task, lease_token: 'lease-secret', lease_generation: 1 } as T;
    if (name === 'context_get') return { task, memories: [], conflicts: [] } as T;
    if (name === 'task_message_ack') {
      receipts.push(args);
      if (receipts.length === 1) throw new Error('response lost after receipt commit');
      return { acknowledged: true } as T;
    }
    if (name === 'artifact_put') return { artifact: { id: 'artifact-id' } } as T;
    if (name === 'session_list') return { sessions: [] } as T;
    const reply = protocolReply(name); if (reply !== undefined) return reply as T;
    return { task } as T;
  } };
  const cfg = config();
  await new BridgeWorker(cfg, client, () => {}, async () => result).claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[1]!.status, 'delivered');
});

test('heartbeat rejection aborts provider and prevents stale completion/artifact writes', async () => {
  const calls: string[] = [];
  let sawAbort = false;
  const client: ToolClient = { async call<T>(name:string):Promise<T> {
    calls.push(name);
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='task_heartbeat') throw new RemoteError(409,'lease_lost');
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,memories:[],conflicts:[]} as T;
    return {task} as T;
  } };
  const cfg = config(); cfg.heartbeat_seconds = 0.01;
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {
    await new Promise<void>(resolve=>{
      if(request.signal?.aborted) resolve();
      else request.signal?.addEventListener('abort',()=>resolve(),{once:true});
    });
    sawAbort=true;return {...result,stop_reason:'aborted'};
  });
  await worker.claimAndRun(cfg.projects,new AbortController().signal);
  assert.equal(sawAbort,true);
  assert.ok(calls.includes('task_heartbeat'));
  assert.ok(!calls.includes('task_finish'));
  assert.ok(!calls.includes('artifact_put'));
});

test('transient heartbeat failures are retried and the task still completes', { timeout: 3000 }, async () => {
  const calls: string[] = []; let beats = 0;
  const renewed = deferred();
  const client: ToolClient = { async call<T>(name:string):Promise<T> {
    calls.push(name);
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='task_heartbeat') {
      if (++beats<=2) throw beats===1 ? new Error('fetch failed') : new RemoteError(503,'internal_error');
      renewed.resolve();
    }
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task} as T;
  } };
  const cfg = config(); cfg.heartbeat_seconds = 0.01;
  const worker = new BridgeWorker(cfg,client,()=>{},async () => { await renewed.promise; return result; });
  await worker.claimAndRun(cfg.projects,new AbortController().signal);
  assert.ok(beats>=3);
  assert.ok(calls.includes('task_finish'));
});

test('heartbeats failing until the local lease deadline stop the provider', async () => {
  const calls: string[] = []; let sawAbort = false;
  const client: ToolClient = { async call<T>(name:string):Promise<T> {
    calls.push(name);
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='task_heartbeat') throw new Error('fetch failed');
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,memories:[],conflicts:[]} as T;
    return {task} as T;
  } };
  const cfg = config(); cfg.heartbeat_seconds = 0.01; cfg.lease_seconds = 4.2; // deadline = lease - 4 s grace = 200 ms
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {
    await new Promise<void>(resolve=>{ if(request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort',()=>resolve(),{once:true}); });
    sawAbort=true; return {...result,stop_reason:'aborted'};
  });
  await worker.claimAndRun(cfg.projects,new AbortController().signal);
  assert.equal(sawAbort,true);
  assert.ok(!calls.includes('task_finish'));
});

test('wrong-scope claims never invoke a provider', async () => {
  const client: ToolClient = {async call<T>():Promise<T>{return {task:{...task,scope:'project:other'},lease_token:'lease-secret',lease_generation:1} as T;}};
  const cfg=config(); let invoked=false;
  const worker=new BridgeWorker(cfg,client,()=>{},async()=>{invoked=true;return result;});
  await assert.rejects(worker.claimAndRun(cfg.projects,new AbortController().signal));
  assert.equal(invoked,false);
});

test('lost completion response retries the identical result, never an alternate blocked outcome', async () => {
  const completions:Record<string,unknown>[]=[];
  const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T>{
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    if(name==='task_finish') {
      completions.push(args);
      if(completions.length===1) throw new Error('response lost after commit');
    }
    return {task} as T;
  }};
  const cfg=config();
  await new BridgeWorker(cfg,client,()=>{},async()=>result).claimAndRun(cfg.projects,new AbortController().signal);
  assert.equal(completions.length,2);
  assert.deepEqual(completions[0],completions[1]);
  assert.equal(completions[1]!.outcome,'completed');
});

test('an already consumed conservative lease window prevents provider start', async () => {
  const client:ToolClient={async call<T>():Promise<T>{return {task,lease_token:'lease-secret',lease_generation:1} as T;}};
  const cfg=config();cfg.lease_seconds=0.001;
  let invoked=false;
  await new BridgeWorker(cfg,client,()=>{},async()=>{invoked=true;return result;}).claimAndRun(cfg.projects,new AbortController().signal);
  assert.equal(invoked,false);
});

test('a server-bounded lease window is honored before provider start', async () => {
  const client: ToolClient = { async call<T>(): Promise<T> {
    return { task, lease_token: 'lease-secret', lease_generation: 1, lease_remaining_ms: 3000 } as T;
  } };
  const cfg = config();
  let invoked = false;
  await new BridgeWorker(cfg, client, () => {}, async () => { invoked = true; return result; })
    .claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(invoked, false, 'the configured lease duration overrode the shorter server grant');
});

test('a workflow claim without its remaining server lease window fails closed', async () => {
  const client: ToolClient = { async call<T>(): Promise<T> {
    return { task: { ...task, workflow_id: 'workflow-id', base_ref: 'a'.repeat(40) }, lease_token: 'lease-secret', lease_generation: 1 } as T;
  } };
  const cfg = config();
  let invoked = false;
  await new BridgeWorker(cfg, client, () => {}, async () => { invoked = true; return result; })
    .claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(invoked, false);
});

test('a shortened renewal stops the provider instead of extending to configured lease seconds', { timeout: 1500 }, async () => {
  let sawAbort = false, finished = false;
  const client: ToolClient = { async call<T>(name: string): Promise<T> {
    if (name === 'task_claim') return { task, lease_token: 'lease-secret', lease_generation: 1, lease_remaining_ms: 60_000 } as T;
    if (name === 'task_heartbeat') return { task, lease_remaining_ms: 3000 } as T;
    if (name === 'task_finish') finished = true;
    if (name === 'context_get') return { scope: task.scope, task, memories: [], conflicts: [] } as T;
    const reply = protocolReply(name); if (reply !== undefined) return reply as T;
    return { task } as T;
  } };
  const cfg = config(); cfg.heartbeat_seconds = 0.01;
  await new BridgeWorker(cfg, client, () => {}, async request => {
    await new Promise<void>(resolve => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    sawAbort = true;
    return { ...result, stop_reason: 'aborted' };
  }).claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(sawAbort, true);
  assert.equal(finished, false);
});

test('usage readings are reported and steer auto.read to the agent with most headroom', async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const autoTask = {...task,required_capability:'auto.read'};
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task:autoTask,lease_token:'lease-secret',lease_generation:1,route:{provider:null,allowed:['claude','codex']}} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task:autoTask,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task:autoTask,accepted:2} as T;
  } };
  const cfg = parseBridgeConfig({ service_url:'http://localhost:8080',
    agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:true},{id:'codex',provider:'codex',binary:'/bin/codex',sandbox:true}],
    projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude','codex']}] });
  const at = new Date().toISOString();
  const usage = async () => [
    {provider:'claude' as const,ok:true,windows:[{name:'5h',used_percent:90,resets_at:null}],fetched_at:at},
    {provider:'codex' as const,ok:true,windows:[{name:'weekly',used_percent:10,resets_at:null}],fetched_at:at}];
  let command = '';
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {command = wrappedBinary(request);assert.ok(existsSync(request.env.CODEX_HOME!));assert.notEqual(request.env.CODEX_HOME,join(testHome,'.codex'));return {...result,stdout:'{"type":"turn.completed"}'};},usage);
  const signal = new AbortController().signal;
  await worker.reportUsage(signal);
  await worker.reportUsage(signal);
  const reports = calls.filter(c => c.name==='usage_report');
  assert.equal(reports.length,1);
  assert.deepEqual((reports[0]!.args.reports as {provider:string}[]).map(r => r.provider),['claude','codex']);
  await worker.claimAndRun(cfg.projects,signal);
  assert.equal(command,'/bin/codex');
  assert.ok(((calls.find(c => c.name==='task_claim')!.args.projects as {capabilities:string[]}[])[0]!.capabilities as string[]).includes('auto.read'));
});

function routed(route:unknown,cap='auto.read') {
  const calls:{name:string;args:Record<string,unknown>}[]=[];
  const t={...task,required_capability:cap};
  const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T>{
    calls.push({name,args});
    if(name==='task_claim') return {task:t,lease_token:'lease-secret',lease_generation:1,...(route===undefined?{}:{route})} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task:t,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task:t} as T;
  }};
  const cfg=parseBridgeConfig({service_url:'http://localhost:8080',
    agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:true},{id:'codex',provider:'codex',binary:'/bin/codex',sandbox:true}],
    projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude','codex']}]});
  const ran:string[]=[];
  const worker=new BridgeWorker(cfg,client,()=>{},async r=>{const binary=wrappedBinary(r);ran.push(binary);return binary.endsWith('codex')?{...result,stdout:'{"type":"turn.completed"}'}:result;},async()=>[
    {provider:'claude' as const,ok:true,windows:[{name:'5h',used_percent:1,resets_at:null}],fetched_at:new Date().toISOString()}]);
  return {cfg,worker,ran,calls};
}
const go=async(x:ReturnType<typeof routed>)=>{await x.worker.reportUsage(new AbortController().signal);return x.worker.claimAndRun(x.cfg.projects,new AbortController().signal);};
const finishOf=(x:ReturnType<typeof routed>)=>x.calls.find(c=>c.name==='task_finish')!.args;

test('route.provider pins the agent even when another has more headroom',async()=>{
  const x=routed({provider:'codex',allowed:['claude','codex']});
  await go(x);
  assert.deepEqual(x.ran,['/bin/codex']);
  assert.equal((finishOf(x).result as Record<string,unknown>).provider,'codex');
});

test('route.allowed excludes a disabled provider from the headroom pick',async()=>{
  const x=routed({provider:null,allowed:['codex']});
  await go(x);
  assert.deepEqual(x.ran,['/bin/codex']); // claude has far more headroom but is not allowed
  const y=routed({provider:null,allowed:['claude']});
  await go(y);
  assert.deepEqual(y.ran,['/bin/claude']);
});

test('auto task without a route, or with a provider this bridge lacks, is finished blocked and never runs a provider',async()=>{
  for(const route of [undefined,{provider:'antigravity',allowed:['antigravity']}]) {
    const x=routed(route);
    await go(x);
    assert.deepEqual(x.ran,[]);
    assert.equal(finishOf(x).outcome,'blocked');
  }
});

function sessionHarness(instructions: unknown[] = [], stored?: unknown[], fail = false) {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task:{...task,instructions},memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    if(name==='session_list') return {sessions:stored?[{id:'s-id',session_id:`swarm:${task.id}`}]:[]} as T;
    if(name==='session_get') return {session:{turns:stored}} as T;
    if(name==='session_record' && fail) throw new Error('boom');
    return {task} as T;
  } };
  return {calls,client};
}
const answered: ProcessResult = {...result,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'All good'})};

test('a run is recorded as a swarm chat; a continuation appends; failure is harmless', async () => {
  const cfg = config();
  const run = async (h: ReturnType<typeof sessionHarness>) => { await new BridgeWorker(cfg,h.client,()=>{},async()=>answered).claimAndRun(cfg.projects,new AbortController().signal); };
  const first = sessionHarness(); await run(first);
  const rec = first.calls.find(c=>c.name==='session_record')!.args as any;
  assert.deepEqual([rec.harness,rec.session_id,rec.task_id,rec.scope,rec.cwd,rec.title,rec.ended],['claude-code',`swarm:${task.id}`,task.id,'project:demo','/projects/demo','[swarm] Review source',true]);
  assert.deepEqual(rec.turns.map((t:any)=>[t.role,t.text]),[['user','Review source'],['assistant','All good']]);
  const again = sessionHarness([{instruction:'Now check tests'}], rec.turns); await run(again);
  const rec2 = again.calls.find(c=>c.name==='session_record')!.args as any;
  assert.deepEqual(rec2.turns.map((t:any)=>[t.role,t.text]),[['user','Review source'],['assistant','All good'],['user','Now check tests'],['assistant','All good']]);
  const bad = sessionHarness([],undefined,true); await run(bad);
  assert.equal((bad.calls.find(c=>c.name==='task_finish')!.args as any).outcome,'completed');
});

test('one idle pass claims all projects in one call with per-project capabilities', async () => {
  const cfg = parseBridgeConfig({ service_url:'http://localhost:8080', usage_seconds:0,
    agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:true,enable_patch:true},
      {id:'codex',provider:'codex',binary:'/bin/codex',sandbox:true}],
    projects:[{scope:'project:a',root:'/projects/a',agents:['claude'],allow_patch:true},
      {scope:'project:b',root:'/projects/b',agents:['codex']}] });
  const calls:Record<string,unknown>[] = [];
  const client:ToolClient = {async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    assert.equal(name,'task_claim'); calls.push(args); return {task:null} as T;
  }};
  await new BridgeWorker(cfg,client,()=>{}).run(new AbortController().signal,true);
  assert.deepEqual(calls,[{projects:[
    {scope:'project:a',capabilities:['claude.read','claude.patch','auto.read','auto.patch'],kinds:['research','review','patch']},
    {scope:'project:b',capabilities:['codex.read','auto.read'],kinds:['research','review']}
  ],lease_seconds:cfg.lease_seconds}]);
});

test('a 100-project pass chunks at 64 and maps the claimed scope to its own root', async () => {
  const cfg = config(); cfg.usage_seconds = 0;
  cfg.projects = Array.from({length:100},(_,i) => ({...cfg.projects[0]!,scope:`project:p${i}`,root:`/projects/p${i}`}));
  const calls:Record<string,unknown>[] = [];
  const claimed = {...task,scope:'project:p99'};
  const client:ToolClient = {async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    if(name==='task_claim') {
      calls.push(args);
      return (calls.length === 1 ? {task:null} : {task:claimed,lease_token:'l',lease_generation:1}) as T;
    }
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:claimed.scope,task:claimed,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    if(name==='session_list') return {sessions:[]} as T;
    return {task:claimed} as T;
  }};
  let cwd = '';
  await new BridgeWorker(cfg,client,()=>{},async request => {cwd = request.cwd;return result;}).run(new AbortController().signal,true);
  assert.deepEqual(calls.map(c => (c.projects as {scope:string}[]).map(p => p.scope)),
    [cfg.projects.slice(0,64),cfg.projects.slice(64)].map(ps => ps.map(p => p.scope)));
  assert.equal(cwd,'/projects/p99');
});

test('one worker runs up to max_concurrent tasks at the same time', async () => {
  const cfg = parseBridgeConfig({ service_url:'http://localhost:8080', max_concurrent:3, agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:true}], projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude']}] });
  let handed = 0, active = 0, peak = 0, finished = 0;
  const ids = ['11111111-1111-4111-8111-11111111111a','11111111-1111-4111-8111-11111111111b','11111111-1111-4111-8111-11111111111c'];
  const client: ToolClient = { async call<T>(name:string):Promise<T> {
    if(name==='task_claim') return (handed < ids.length ? {task:{...task,id:ids[handed++]},lease_token:'l',lease_generation:1} : {task:null}) as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    if(name==='session_list') return {sessions:[]} as T;
    return {task} as T;
  } };
  let release!: () => void; const all3 = { promise: new Promise<void>(r => { release = r; }), resolve: () => release() };
  const stop = new AbortController();
  const worker = new BridgeWorker(cfg,client,()=>{},async () => {
    active++; peak = Math.max(peak,active); if(active === 3) all3.resolve();
    await Promise.race([all3.promise,new Promise(r => setTimeout(r,2000))]);
    active--; if(++finished === 3) stop.abort();
    return result;
  });
  await worker.run(stop.signal);
  assert.equal(peak,3,'all three tasks ran at once');
  assert.equal(handed,3);
});

test('drain stops claims, keeps heartbeats and zero-slot reports, and waits for the last finish', { timeout: 3000 }, async () => {
  const cfg = config(); cfg.max_concurrent = 2; cfg.poll_seconds = 0.01; cfg.usage_seconds = 0.02; cfg.heartbeat_seconds = 0.01;
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const logs: {event:string;metadata:Record<string,unknown>}[] = [];
  const releases = [deferred(), deferred()];
  const bothStarted = deferred(), heartbeat = deferred(), reportedTwice = deferred(), firstFinished = deferred();
  let claims = 0, started = 0, zeroReports = 0, draining = false, resolved = false;
  const signals: AbortSignal[] = [];
  const client: ToolClient = { async call<T>(name: string, args: Record<string,unknown>): Promise<T> {
    calls.push({name,args});
    if (name === 'task_claim') return {task:{...task,id:`task-${++claims}`},lease_token:'l',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if (name === 'context_get') return {task,memories:[],conflicts:[]} as T;
    if (name === 'artifact_put') return {artifact:{id:'artifact'}} as T;
    if (name === 'session_list') return {sessions:[]} as T;
    if (name === 'usage_report' && args.slots === 0 && ++zeroReports === 2) reportedTwice.resolve();
    if (name === 'task_heartbeat' && draining) heartbeat.resolve();
    if (name === 'task_finish') firstFinished.resolve();
    return {} as T;
  } };
  const worker = new BridgeWorker(cfg,client,(event,metadata) => logs.push({event,metadata:metadata ?? {}}),async request => {
    signals.push(request.signal!);
    const release = releases[started++]!;
    if (started === 2) bothStarted.resolve();
    await release.promise;
    return result;
  },async () => []);
  const stop = new AbortController();
  const run = worker.run(stop.signal).then(() => { resolved = true; });
  try {
    await bothStarted.promise;
    const atDrain = calls.length;
    worker.drain(); worker.drain(0); draining = true;
    assert.deepEqual(logs.filter(l => l.event === 'bridge_draining'),[{event:'bridge_draining',metadata:{running:2}}]);
    await Promise.all([heartbeat.promise,reportedTwice.promise]);
    assert.equal(claims,2);
    assert.equal(resolved,false);
    assert.ok(signals.every(s => !s.aborted));
    assert.equal(await worker.claimAndRun(cfg.projects,stop.signal),false);
    releases[0]!.resolve(); await firstFinished.promise;
    assert.equal(resolved,false);
    releases[1]!.resolve(); await run;
    assert.equal(claims,2);
    assert.deepEqual(calls.filter(c => c.name === 'task_finish').map(c => c.args.outcome),['completed','completed']);
    assert.ok(calls.slice(atDrain).filter(c => c.name === 'usage_report').every(c => c.args.slots === 0));
    assert.ok(!logs.some(l => l.event === 'bridge_drain_deadline'));
  } finally { stop.abort(); releases.forEach(r => r.resolve()); await run; }
});

test('drain with no running work resolves immediately, including during the polling sleep', { timeout: 1000 }, async () => {
  const cfg = config(); cfg.usage_seconds = 0; cfg.poll_seconds = 300;
  const polled = deferred(); let claims = 0;
  const client: ToolClient = { async call<T>(name: string): Promise<T> { if (name === 'task_claim') { claims++; polled.resolve(); } return {task:null} as T; } };
  const before = new BridgeWorker(cfg,client,()=>{});
  before.drain(); await before.run(new AbortController().signal);
  assert.equal(claims,0);
  const worker = new BridgeWorker(cfg,client,()=>{});
  const stop = new AbortController(); const run = worker.run(stop.signal);
  try {
    await polled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    worker.drain(); await run;
    assert.equal(claims,1);
  } finally { stop.abort(); await run; }
});

test('drain preserves a once-mode claim already in flight and reports zero slots with usage disabled', { timeout: 1000 }, async () => {
  const cfg = config(); cfg.usage_seconds = 0; cfg.poll_seconds = 0.01;
  const claimed = deferred(), claimResponse = deferred(), reported = deferred();
  let claims = 0, finished = false;
  const client: ToolClient = { async call<T>(name: string, args: Record<string,unknown>): Promise<T> {
    if (name === 'task_claim') { claims++; claimed.resolve(); await claimResponse.promise; return {task,lease_token:'l',lease_generation:1} as T; }
    if (name === 'usage_report') { assert.equal(args.slots,0); reported.resolve(); }
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if (name === 'context_get') return {task,memories:[],conflicts:[]} as T;
    if (name === 'artifact_put') return {artifact:{id:'artifact'}} as T;
    if (name === 'session_list') return {sessions:[]} as T;
    if (name === 'task_finish') { assert.equal(args.outcome,'completed'); finished = true; }
    return {} as T;
  } };
  const worker = new BridgeWorker(cfg,client,()=>{},async request => { await reported.promise; assert.equal(request.signal!.aborted,false); return result; });
  const run = worker.run(new AbortController().signal,true);
  await claimed.promise; worker.drain(); claimResponse.resolve(); await run;
  assert.equal(claims,1); assert.equal(finished,true);
});

test('drain deadline uses the shutdown abort path for running providers', { timeout: 1000 }, async () => {
  const cfg = config(); cfg.usage_seconds = 0; cfg.poll_seconds = 300;
  const started = deferred(); const events: string[] = [];
  let aborted = false, outcome: unknown;
  const client: ToolClient = { async call<T>(name: string, args: Record<string,unknown>): Promise<T> {
    if (name === 'task_claim') return {task,lease_token:'l',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if (name === 'context_get') return {task,memories:[],conflicts:[]} as T;
    if (name === 'artifact_put') return {artifact:{id:'artifact'}} as T;
    if (name === 'session_list') return {sessions:[]} as T;
    if (name === 'task_finish') outcome = args.outcome;
    return {} as T;
  } };
  const worker = new BridgeWorker(cfg,client,event => events.push(event),async request => {
    started.resolve();
    await new Promise<void>(resolve => request.signal!.addEventListener('abort',() => resolve(),{once:true}));
    aborted = true; return {...result,stop_reason:'aborted'};
  });
  const stop = new AbortController(); const run = worker.run(stop.signal);
  try {
    await started.promise; worker.drain(0.02); await run;
    assert.equal(aborted,true); assert.equal(outcome,'blocked');
    assert.equal(events.filter(e => e === 'bridge_drain_deadline').length,1);
  } finally { stop.abort(); await run; }
});

test('credential-shaped provider output is redacted before it is stored as answer, transcript or checkpoint', async () => {
  const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    const protocol = protocolReply(name); if (protocol !== undefined) return protocol as T;
    if(name==='context_get') return {scope:task.scope,task,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task} as T;
  } };
  const leaked = `Found ghp_${secret} in .env and password=${secret}`;
  const cfg = config(); cfg.heartbeat_seconds = 0.01;
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {
    request.on_progress?.({output_bytes:leaked.length,stdout_tail:leaked});
    await new Promise(r=>setTimeout(r,60));
    return {...result,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:leaked}),stderr:`warning: ${leaked}`};
  });
  await worker.claimAndRun(cfg.projects,new AbortController().signal);
  const stored = JSON.stringify(calls.filter(c => ['task_finish','artifact_put','task_checkpoint','session_record'].includes(c.name)).map(c => c.args));
  assert.ok(calls.some(c => c.name==='task_finish'));
  assert.ok(!stored.includes(secret), 'secret reached the service');
  assert.match(String((calls.find(c=>c.name==='task_finish')!.args.result as Record<string,unknown>).answer), /Found ghp_/u);
});
