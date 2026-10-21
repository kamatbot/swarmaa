import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeWorker } from '../src/bridge/worker.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

const config = () => parseBridgeConfig({ service_url:'http://localhost:8080', agents:[{id:'claude',provider:'claude',binary:'/bin/claude'}], projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude']}] });
const task: Task = { id:'11111111-1111-4111-8111-111111111111',scope:'project:demo',kind:'review',objective:'Review source',constraints:[],acceptance_criteria:[],resource_key:null,required_capability:'claude.read',checkpoint:null,context_refs:[],version:1 };
const result: ProcessResult = {exit_code:0,signal:null,stdout:'{"type":"result","subtype":"success","is_error":false}',stderr:'',duration_ms:10,stop_reason:null};

test('successful worker stores provenance, transcript and explicit unverified acceptance', async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='context_get') return {scope:task.scope,task,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task} as T;
  } };
  const cfg = config();
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {assert.ok(!request.input.includes('lease-secret'));return result;});
  assert.equal(await worker.claimAndRun(cfg.projects[0]!,new AbortController().signal),true);
  const finish = calls.find(call=>call.name==='task_finish')!;
  assert.equal(finish.args.outcome,'completed');
  assert.equal((finish.args.result as Record<string,unknown>).acceptance_criteria_verified,false);
  assert.equal(calls.filter(call=>call.name==='artifact_put').length,1);
  assert.deepEqual(calls[0]!.args.kinds,['research','review']);
});

test('heartbeat rejection aborts provider and prevents stale completion/artifact writes', async () => {
  const calls: string[] = [];
  let sawAbort = false;
  const client: ToolClient = { async call<T>(name:string):Promise<T> {
    calls.push(name);
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='task_heartbeat') throw new Error('lease expired');
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
  await worker.claimAndRun(cfg.projects[0]!,new AbortController().signal);
  assert.equal(sawAbort,true);
  assert.ok(calls.includes('task_heartbeat'));
  assert.ok(!calls.includes('task_finish'));
  assert.ok(!calls.includes('artifact_put'));
});

test('wrong-scope claims never invoke a provider', async () => {
  const client: ToolClient = {async call<T>():Promise<T>{return {task:{...task,scope:'project:other'},lease_token:'lease-secret',lease_generation:1} as T;}};
  const cfg=config(); let invoked=false;
  const worker=new BridgeWorker(cfg,client,()=>{},async()=>{invoked=true;return result;});
  await assert.rejects(worker.claimAndRun(cfg.projects[0]!,new AbortController().signal));
  assert.equal(invoked,false);
});

test('lost completion response retries the identical result, never an alternate blocked outcome', async () => {
  const completions:Record<string,unknown>[]=[];
  const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T>{
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='context_get') return {scope:task.scope,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    if(name==='task_finish') {
      completions.push(args);
      if(completions.length===1) throw new Error('response lost after commit');
    }
    return {task} as T;
  }};
  const cfg=config();
  await new BridgeWorker(cfg,client,()=>{},async()=>result).claimAndRun(cfg.projects[0]!,new AbortController().signal);
  assert.equal(completions.length,2);
  assert.deepEqual(completions[0],completions[1]);
  assert.equal(completions[1]!.outcome,'completed');
});

test('an already consumed conservative lease window prevents provider start', async () => {
  const client:ToolClient={async call<T>():Promise<T>{return {task,lease_token:'lease-secret',lease_generation:1} as T;}};
  const cfg=config();cfg.lease_seconds=0.001;
  let invoked=false;
  await new BridgeWorker(cfg,client,()=>{},async()=>{invoked=true;return result;}).claimAndRun(cfg.projects[0]!,new AbortController().signal);
  assert.equal(invoked,false);
});

test('usage readings are reported and steer auto.read to the agent with most headroom', async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const autoTask = {...task,required_capability:'auto.read'};
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task:autoTask,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='context_get') return {scope:task.scope,task:autoTask,memories:[],conflicts:[]} as T;
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task:autoTask,accepted:2} as T;
  } };
  const cfg = parseBridgeConfig({ service_url:'http://localhost:8080',
    agents:[{id:'claude',provider:'claude',binary:'/bin/claude'},{id:'codex',provider:'codex',binary:'/bin/codex'}],
    projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude','codex']}] });
  const at = new Date().toISOString();
  const usage = async () => [
    {provider:'claude' as const,ok:true,windows:[{name:'5h',used_percent:90,resets_at:null}],fetched_at:at},
    {provider:'codex' as const,ok:true,windows:[{name:'weekly',used_percent:10,resets_at:null}],fetched_at:at}];
  let command = '';
  const worker = new BridgeWorker(cfg,client,()=>{},async request => {command = request.command;return result;},usage);
  const signal = new AbortController().signal;
  await worker.reportUsage(signal);
  await worker.reportUsage(signal);
  const reports = calls.filter(c => c.name==='usage_report');
  assert.equal(reports.length,1);
  assert.deepEqual((reports[0]!.args.reports as {provider:string}[]).map(r => r.provider),['claude','codex']);
  await worker.claimAndRun(cfg.projects[0]!,signal);
  assert.equal(command,'/bin/codex');
  assert.ok((calls.find(c => c.name==='task_claim')!.args.capabilities as string[]).includes('auto.read'));
});
