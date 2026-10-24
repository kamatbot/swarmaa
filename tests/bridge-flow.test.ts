import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { runFlowCheck } from '../src/bridge/checks.js';
import { runBoundedProcess } from '../src/bridge/process.js';
import { createWorktree, removeSnapshot } from '../src/bridge/worktree.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import type { ProcessRunner, Task, ToolClient } from '../src/bridge/types.js';
import type { FlowCheck } from '../src/core/flow-definition.js';

async function fixture(fn:(s:{root:string;dir:string;base:string;head:string;task:Task;config:ReturnType<typeof parseBridgeConfig>})=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'flow-bridge-')), oldHome=process.env.HOME, root=join(dir,'repo');
  const git=(...args:string[]) => execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  try {
    process.env.HOME=join(dir,'home'); await mkdir(root); await mkdir(process.env.HOME);
    git('init','-q','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    await mkdir(join(root,'src')); await writeFile(join(root,'outside.txt'),'initial'); await writeFile(join(root,'src/a.ts'),'initial'); git('add','-A'); git('commit','-qm','fixture base');
    const base=git('rev-parse','HEAD');
    // Include an out-of-scope deletion disguised as a rename; files_within must catch both sides.
    git('mv','outside.txt','src/inside.txt'); await writeFile(join(root,'src/a.ts'),'patched'); git('add','-A'); git('commit','-qm','fixture patch');
    const head=git('rev-parse','HEAD');
    const config=parseBridgeConfig({service_url:'http://localhost:8080',agents:[{id:'codex',provider:'codex',binary:'/bin/model-fixture',enable_patch:true,sandbox:false}],
      projects:[{scope:'project:a',root,agents:['codex'],allow_patch:true,checks:{tests_pass:{command:process.execPath,args:['-e',"console.log('pass');"],timeout_seconds:10},build_passes:{command:process.execPath,args:['-e',"console.log('build');"],timeout_seconds:10}}}]});
    const task:Task={id:'99112233-1111-4111-8111-111111111111',scope:'project:a',kind:'check',objective:'Check fixture',constraints:[],acceptance_criteria:[],resource_key:null,
      required_capability:'bridge.check',base_ref:head,checkpoint:null,context_refs:[],version:1,flow_id:'flow-fixture',
      flow:{step_id:'check',needs:['patch'],ready:true,commit:head,diff_base:base,provider:null,check:{type:'tests_pass'}}};
    await fn({root,dir,base,head,task,config});
  } finally { if(oldHome===undefined) delete process.env.HOME; else process.env.HOME=oldHome; await rm(dir,{recursive:true,force:true}); }
}

test('all deterministic checks inspect exact committed source, including rename deletions',async () => fixture(async s => {
  const wt=await createWorktree(s.root,'check',s.task);
  try {
    for (const [spec,passed] of [[{type:'tests_pass'},true],[{type:'build_passes'},true],[{type:'diff_nonempty'},true],[{type:'files_within',globs:['src/**']},false],[{type:'files_within',globs:['**']},true]] as [FlowCheck,boolean][]) {
      s.task.flow!.check=spec;
      const fact=await runFlowCheck(s.task,s.config.projects[0]!,s.config.agents[0]!,s.config,wt,runBoundedProcess,new AbortController().signal);
      assert.equal(fact.passed,passed); assert.equal(fact.commit,s.head); assert.equal(fact.base_commit,s.base);
      if (!passed) assert.match(fact.output_tail,/outside.txt/);
    }
    s.task.flow!.check={type:'diff_nonempty'}; s.task.flow!.diff_base=s.head;
    assert.equal((await runFlowCheck(s.task,s.config.projects[0]!,s.config.agents[0]!,s.config,wt,runBoundedProcess,new AbortController().signal)).passed,false);
  } finally {await removeSnapshot(s.root,wt);}
}));

test('checks fail closed on missing config, source mutation, timeouts and cancellation; output is bounded/redacted',async () => fixture(async s => {
  const wt=await createWorktree(s.root,'check',s.task), project=s.config.projects[0]!, agent=s.config.agents[0]!;
  const run=(runner=runBoundedProcess,signal=new AbortController().signal) => runFlowCheck(s.task,project,agent,s.config,wt,runner,signal);
  try {
    const command=project.checks!.tests_pass!; delete project.checks!.tests_pass;
    await assert.rejects(() => run(),/No owner-configured/); project.checks!.tests_pass=command;
    command.args=['-e',"console.log('x'.repeat(20000));console.log('password=fixture-private-value');"];
    const fact=await run(); assert.ok(Buffer.byteLength(fact.output_tail)<=12003); assert.ok(!fact.output_tail.includes('fixture-private-value'));
    command.args=['-e','setInterval(()=>{},100)']; command.timeout_seconds=0.02;
    assert.equal((await run()).stop_reason,'timeout');
    command.timeout_seconds=10;
    const stop=new AbortController(); stop.abort(); assert.equal((await run(runBoundedProcess,stop.signal)).passed,false);
    command.args=['-e',"require('fs').writeFileSync('src/a.ts','mutated');"];
    const mutated=await run(); assert.equal(mutated.passed,false); assert.match(mutated.output_tail,/changed tracked source/);
  } finally {await removeSnapshot(s.root,wt);}
}));

test('flow review runs on a clean pinned snapshot even when the main checkout has moved',async () => fixture(async s => {
  const task:Task={...s.task,kind:'review',required_capability:'auto.read',base_ref:s.base,flow:{...s.task.flow!,commit:s.base,provider:'codex',check:undefined}};
  const calls:{name:string;args:Record<string,any>}[]=[];
  const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'l',lease_generation:1,route:{provider:'codex',allowed:['codex']}} as T;
    if(name==='artifact_put') return {artifact:{id:'artifact'}} as T;
    if(name==='session_list') return {sessions:[]} as T;
    return {task,memories:[],conflicts:[]} as T;
  }};
  let runs=0;
  await new BridgeWorker(s.config,client,()=>{},async req => {
    runs++; assert.notEqual(req.cwd,s.root); assert.equal(await readFile(join(req.cwd,'src/a.ts'),'utf8'),'initial');
    return {exit_code:0,signal:null,stdout:'{"type":"turn.completed"}',stderr:'',duration_ms:1,stop_reason:null};
  }).claimAndRun(s.config.projects,new AbortController().signal);
  const result=calls.find(c=>c.name==='task_finish')!.args;
  assert.equal(runs,1); assert.equal(result.outcome,'completed'); assert.equal(result.result.observed_commit,s.base);
  assert.equal(await readFile(join(s.root,'src/a.ts'),'utf8'),'patched');
}));

test('lease loss aborts a deterministic check and cannot record successful completion',async () => fixture(async s => {
  const calls:{name:string;args:Record<string,any>}[]=[];
  const client:ToolClient={async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task:s.task,lease_token:'l',lease_generation:1} as T;
    if(name==='task_heartbeat') throw Object.assign(new Error('cancelled'),{status:409,code:'lease_lost'});
    if(name==='artifact_put') return {artifact:{id:'artifact'}} as T;
    return {task:s.task} as T;
  }};
  s.config.heartbeat_seconds=0.15;
  let aborted=false;
  const runner:ProcessRunner=async req => {
    if(!req.signal!.aborted) await new Promise<void>(resolve => req.signal!.addEventListener('abort',()=>resolve(),{once:true}));
    aborted=true; return {exit_code:null,signal:'SIGTERM',stdout:'',stderr:'',duration_ms:1,stop_reason:'aborted'};
  };
  await new BridgeWorker(s.config,client,()=>{},runner).claimAndRun(s.config.projects,new AbortController().signal);
  // Lease can be lost during snapshot preparation, in which case no subprocess starts at all.
  assert.ok(aborted || calls.some(c=>c.name==='task_heartbeat'));
  assert.ok(!calls.some(c=>c.name==='task_finish'));
}));
