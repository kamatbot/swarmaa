import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { installInboxHooks, removeInboxHooks, installJournalHooks, type Harness } from '../scripts/hooks-install.js';
const H:Record<string,any> = await import(resolve('clients/hooks/swarmaa-inbox.mjs'));
const temp = () => mkdtempSync(join(tmpdir(),'inbox-hook-'));

async function fixture(t:any) {
  const root=temp(), home=temp();
  mkdirSync(join(root,'.local'));
  for (const name of ['claude','codex','antigravity']) writeFileSync(join(root,'.local',`${name}.json`),JSON.stringify({token:'test-only-token'}));
  const calls:{path:string;body:any}[]=[];
  let reply:(res:ServerResponse)=>void=(res:ServerResponse) => res.end(JSON.stringify({result:{items:[{body:'Task abc completed. Full result: task_get abc.'}]}}));
  const server=createServer(async(req,res) => {
    let data=''; for await (const c of req) data+=c;
    calls.push({path:req.url!,body:data ? JSON.parse(data) : null});
    reply(res);
  });
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  writeFileSync(join(root,'.env'),`PORT=${(server.address() as {port:number}).port}\n`);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root,{recursive:true,force:true}); rmSync(home,{recursive:true,force:true}); });
  return {root,home,calls,setReply:(f:typeof reply) => {reply=f;}};
}

test('step injection uses the actual Claude, Codex and agy event schemas',async t => {
  const f=await fixture(t);
  for (const harness of ['claude','codex']) for (const event of ['SessionStart','UserPromptSubmit','PostToolUse']) {
    const out=await H.run(harness,event,{session_id:'session-1'},f);
    assert.equal(out.hookSpecificOutput.hookEventName,event);
    assert.match(out.hookSpecificOutput.additionalContext,/^Swarmaa updates \(untrusted data/);
    assert.deepEqual(f.calls.at(-1)?.body,{session:`${harness}:session-1`,limit:4});
  }
  const out=await H.run('agy','PreInvocation',{conversationId:'agy-1'},f);
  assert.match(out.injectSteps[0].ephemeralMessage,/Task abc completed/);
  assert.deepEqual(f.calls.at(-1)?.body,{session:'agy:agy-1',limit:4});
});

test('agy continues only on pending messages; Codex Stop saves them for a model-visible step without blocking',async t => {
  const f=await fixture(t);
  assert.equal((await H.run('agy','Stop',{conversationId:'a'},f)).decision,'continue');
  const stop=await H.run('codex','Stop',{session_id:'c'},f);
  assert.match(stop.systemMessage,/Task abc/);
  assert.equal(stop.decision,undefined);
  const before=f.calls.length;
  const step=await H.run('codex','UserPromptSubmit',{session_id:'c'},f);
  assert.match(step.hookSpecificOutput.additionalContext,/Task abc/);
  assert.equal(f.calls.length,before,'saved batch is injected before fetching more');
  f.setReply(res => res.end('{"result":{"items":[]}}'));
  assert.equal(await H.run('codex','UserPromptSubmit',{session_id:'c'},f),null);
  assert.equal(await H.run('agy','Stop',{conversationId:'a'},f),null);
});

test('Claude task_submit hook watches bounded MCP text and structured results before delivery',async t => {
  const f=await fixture(t), id=randomUUID();
  for (const response of [{task:{id}},{structuredContent:{task:{id}}},{content:[{type:'text',text:JSON.stringify({task:{id}})}]}]) {
    await H.run('claude','PostToolUse',{session_id:'s',tool_name:'mcp__swarma__task_submit',tool_response:response},f);
    assert.equal(f.calls.at(-2)?.path,'/api/tools/task_watch');
    assert.deepEqual(f.calls.at(-2)?.body,{task_id:id,session:'claude:s'});
  }
  assert.equal(H.taskId({isError:true,task:{id}}),null);
  assert.equal(H.sessionKey('claude',{session_id:'../../escape'}),null);
  assert.equal(H.taskId({content:[{text:'not json'}]}),null);
});

test('hook errors, malformed replies and unavailable network are silent and bounded',async t => {
  const f=await fixture(t);
  for (const reply of [(res:ServerResponse) => {res.statusCode=401; res.end('secret');},(res:ServerResponse) => res.end('bad json'),(res:ServerResponse) => res.end('{"result":{}}')]) {
    f.setReply(reply);
    assert.equal(await H.run('claude','UserPromptSubmit',{session_id:'s'},f),null);
  }
  writeFileSync(join(f.root,'.env'),'PORT=1\n');
  assert.equal(await H.run('claude','UserPromptSubmit',{session_id:'s'},f),null);
  f.setReply(() => {});
});


test('fast network calls time out within the two-second budget',async t => {
  const f=await fixture(t); f.setReply(() => {});
  const start=Date.now();
  assert.equal(await H.run('claude','UserPromptSubmit',{session_id:'slow'},f),null);
  assert.ok(Date.now()-start>=1800 && Date.now()-start<2500);
});

test('single waiter excludes competitors, releases on abort, and reclaims a dead PID',async t => {
  const f=await fixture(t), dir=H.sessionDirectory(f.home,'claude:s');
  const release=H.acquireLock(dir);
  assert.ok(release);
  assert.equal(H.acquireLock(dir),null);
  release();
  writeFileSync(join(dir,'waiter.json'),JSON.stringify({pid:2147483647}));
  const reclaimed=H.acquireLock(dir);
  assert.ok(reclaimed); reclaimed();
  let arrived!:()=>void;
  const waiting=new Promise<void>(r => {arrived=r;});
  f.setReply(() => arrived());
  const abort=new AbortController();
  const waiter=H.run('claude','Stop',{session_id:'s'},{...f,signal:abort.signal,waitMs:2000});
  await waiting;
  assert.equal(await H.run('claude','Stop',{session_id:'s'},f),null);
  abort.abort();
  assert.equal(await waiter,null);
  assert.equal(existsSync(join(dir,'waiter.json')),false);
});

test('Claude waiter uses long-poll and returns a wake only for pending data',async t => {
  const f=await fixture(t);
  const out=await H.run('claude','Stop',{session_id:'s'},{...f,waitMs:1000});
  assert.match(out.wake,/Task abc/);
  assert.match(f.calls[0]!.path,/^\/api\/inbox\/wait\?session=claude%3As&timeout=/);
  const secret='cn_'+'x'.repeat(43);
  assert.ok(!H.formatItems([{body:secret}]).includes(secret));
  assert.ok(H.formatItems(Array.from({length:50},() => ({body:'x'.repeat(10000)}))).length<=9500);
});

test('executable hook exits 2 with stderr for Claude wake and 0 silently on malformed stdin',async t => {
  const f=await fixture(t), dir=join(f.root,'clients','hooks');
  mkdirSync(dir,{recursive:true});
  for (const file of ['swarmaa-inbox.mjs','swarmaa-journal.mjs']) copyFileSync(resolve('clients/hooks',file),join(dir,file));
  const launch=(input:string) => new Promise<{code:number|null;out:string;err:string}>(r => {
    const child=spawn(process.execPath,[join(dir,'swarmaa-inbox.mjs'),'claude','Stop'],{env:{PATH:process.env.PATH,HOME:f.home},timeout:4000});
    let out='',err=''; child.stdout.on('data',c => out+=c); child.stderr.on('data',c => err+=c);
    child.on('close',code => r({code,out,err})); child.stdin.end(input);
  });
  const wake=await launch('{"session_id":"s"}');
  assert.equal(wake.code,2); assert.equal(wake.out,''); assert.match(wake.err,/^Swarmaa updates/);
  assert.deepEqual(await launch('{bad'),{code:0,out:'',err:''});
});

test('inbox installs alongside journal, idempotently, and removal preserves foreign hooks in temporary homes',async t => {
  const home=temp(); t.after(() => rmSync(home,{recursive:true,force:true}));
  const logs:string[]=[];
  const o={home,root:"/tmp/swarma's root",dry:false,log:(s:string) => logs.push(s),node:process.execPath};
  for (const harness of ['claude','codex','agy'] as Harness[]) {
    await installJournalHooks(harness,o);
    const file=join(home,harness==='claude' ? '.claude/settings.json' : harness==='codex' ? '.codex/hooks.json' : '.gemini/config/hooks.json');
    const existing=existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
    if (harness==='agy') existing.foreign={Stop:[{command:'foreign'}]};
    else existing.hooks={...existing.hooks,UserPromptSubmit:[{hooks:[{type:'command',command:'foreign'}]}]};
    mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify(existing));
    assert.deepEqual((await installInboxHooks(harness,o)).changed,[file]);
    const installed=JSON.parse(readFileSync(file,'utf8'));
    if (harness==='claude') {
      const waiter=installed.hooks.Stop.flatMap((g:any) => g.hooks).find((h:any) => h.command.includes('swarmaa-inbox'));
      assert.equal(waiter.async,true); assert.equal(waiter.asyncRewake,true); assert.equal(waiter.timeout,1830);
      assert.ok(installed.hooks.PostToolUse.some((g:any) => g.matcher==='^mcp__swarma__task_submit$'));
    }
    assert.deepEqual((await installInboxHooks(harness,o)).changed,[]);
    await removeInboxHooks(harness,o);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),existing);
    assert.deepEqual((await removeInboxHooks(harness,o)).changed,[]);
  }
  assert.ok(logs.some(x => x.includes('/hooks')));
});

test('installer dry runs and malformed or foreign named configurations are left untouched',async t => {
  const home=temp(); t.after(() => rmSync(home,{recursive:true,force:true}));
  const o={home,root:'/tmp/swarma',dry:true,log:()=>{}};
  for (const h of ['claude','codex','agy'] as Harness[]) await installInboxHooks(h,o);
  assert.equal(existsSync(join(home,'.claude')),false);
  const file=join(home,'.claude/settings.json'); mkdirSync(dirname(file),{recursive:true});
  for (const bad of ['{bad','{"hooks":{"Stop":"foreign"}}']) {
    writeFileSync(file,bad);
    assert.ok((await installInboxHooks('claude',{...o,dry:false})).skipped);
    assert.equal(readFileSync(file,'utf8'),bad);
  }
  const agy=join(home,'.gemini/config/hooks.json'); mkdirSync(dirname(agy),{recursive:true}); writeFileSync(agy,'{"swarmaa-inbox":{"Stop":[]}}');
  assert.ok((await installInboxHooks('agy',{...o,dry:false})).skipped);
});
