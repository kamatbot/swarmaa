import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childEnvironment, main } from '../src/wrap/cli.js';
import { Delivery, type Verdict } from '../src/wrap/delivery.js';
import { connection, Inbox, listen } from '../src/wrap/inbox.js';
const H:Record<string,any>=await import('../clients/hooks/swarmaa-inbox.mjs' as string);

test('child environment preserves terminal keys and colours but removes every service token',() => {
  const env=childEnvironment({PATH:'/bin',TERM:'xterm-256color',COLORTERM:'truecolor',NO_COLOR:'0',COLLECTIVE_TOKEN:'hidden',SWARMAA_MCP_TOKEN:'hidden',SWARMA_TOKEN:'hidden',SWARMAA_WRAP_ROOT:'/private'},'wrap:codex:test');
  assert.deepEqual(env,{PATH:'/bin',TERM:'xterm-256color',COLORTERM:'truecolor',NO_COLOR:'0',SWARMAA_WRAP_SESSION:'wrap:codex:test'});
});

test('wrapped hooks share exactly the wrapper receipt stream; unrelated/invalid overrides are ignored',() => {
  const old=process.env.SWARMAA_WRAP_SESSION;
  try {
    const session=`wrap:codex:${randomUUID()}`; process.env.SWARMAA_WRAP_SESSION=session;
    assert.equal(H.sessionKey('codex',{session_id:'native'}),session);
    assert.equal(H.sessionKey('agy',{conversationId:'native'}),'agy:native');
    assert.equal(H.sessionKey('claude',{session_id:'native'}),'claude:native');
    process.env.SWARMAA_WRAP_SESSION='wrap:codex:bad';
    assert.equal(H.sessionKey('codex',{session_id:'native'}),'codex:native');
  } finally { if (old===undefined) delete process.env.SWARMAA_WRAP_SESSION; else process.env.SWARMAA_WRAP_SESSION=old; }
});

test('the wrapper retains stable IDs through an uncertain ack and never writes a re-offered body again',async () => {
  const stop=new AbortController(),id=randomUUID(),events:any[]=[],order:string[]=[];
  let polls=0,acks=0,writes=0;
  const delivery={generation:7,deliver:async(text:string,generation:number) => {
    assert.equal(generation,7); assert.match(text,/untrusted data/); writes++; return 'accepted';
  }} as Delivery;
  await listen({wait:async() => {
    order.push('poll'); polls++;
    if (polls===3) stop.abort();
    return {items:[{delivery_id:id,body:'private body'}]};
  },ack:async(_session,delivery_id,state) => {
    order.push('ack'); assert.equal(delivery_id,id); assert.equal(state,'accepted');
    if (++acks===1) throw new Error('lost ack response');
    return {};
  }},delivery,`wrap:codex:${randomUUID()}`,stop.signal,e=>events.push(e));
  assert.equal(writes,1); assert.equal(acks,2);
  assert.deepEqual(order,['poll','ack','ack','poll','poll']);
  assert.ok(!JSON.stringify(events).includes('private body'));
});

test('every failed/cancelled delivery is unconfirmed, and input generation is captured before waiting',async () => {
  for (const verdict of ['unconfirmed','user_cancelled','prompt_unproven','write_failed'] as Verdict[]) {
    const stop=new AbortController(),id=randomUUID(); let written=0,polled=0;
    let generation=3;
    const delivery={get generation(){return generation;},deliver:async(_text:string,offeredGeneration:number)=>{assert.equal(offeredGeneration,3); written++; return verdict;}} as Delivery;
    await listen({wait:async()=>{
      if (++polled>1) stop.abort();
      generation=4;
      return {items:[{delivery_id:id,body:'pending'}]};
    },ack:async(_s,_id,state)=>{ assert.equal(state,'unconfirmed'); return {}; }},delivery,'codex:test',stop.signal,()=>{});
    assert.equal(written,1);
  }
});

test('an accepted summary leaves original bodies unconfirmed so inbox_get can still read them',async () => {
  const stop=new AbortController(),id=randomUUID(),events:any[]=[];
  let polls=0;
  const delivery={generation:0,deliver:async(text:string)=>{
    assert.match(text,/1 new Swarmaa updates; call inbox_get/);
    assert.doesNotMatch(text,/full brief/); return 'accepted';
  }} as Delivery;
  await listen({wait:async()=>{
    if (++polls>1) stop.abort();
    return {items:[{delivery_id:id,body:'full brief '.repeat(170)}]};
  },ack:async(_session,delivery_id,state)=>{
    assert.equal(delivery_id,id); assert.equal(state,'unconfirmed'); return {};
  }},delivery,`wrap:codex:${randomUUID()}`,stop.signal,e=>events.push(e));
  assert.equal(events.find(e=>e.event==='delivery').reason,'summary_accepted');
});

test('connection reads only the MCP identity token file and local port; network responses are byte-bounded and redirects refused',async t => {
  const root=mkdtempSync(join(tmpdir(),'wrap-inbox-')); mkdirSync(join(root,'.local'));
  for (const name of ['codex','antigravity']) writeFileSync(join(root,'.local',`${name}.json`),JSON.stringify({token:'fixture-token'}));
  const server=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    if (req.url==='/redirect') { res.writeHead(302,{Location:'/never'}); res.end(); }
    else if (req.url==='/large') res.end('界'.repeat(23000));
    else res.end(JSON.stringify({result:{items:[]}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{ server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(root,{recursive:true,force:true}); });
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  writeFileSync(join(root,'.env'),`PORT=${(server.address() as {port:number}).port}\n`);
  for (const harness of ['codex','agy'] as const) assert.deepEqual(await connection(root,harness).wait(`${harness}:fixture`,AbortSignal.timeout(1000)),{items:[]});
  const inbox=new Inbox(origin,'fixture-token');
  await assert.rejects(inbox.request('/large',AbortSignal.timeout(1000)),/response too large/);
  await assert.rejects(inbox.request('/redirect',AbortSignal.timeout(1000)));
  writeFileSync(join(root,'.env'),'PORT=invalid\n');
  assert.throws(()=>connection(root,'codex'),/invalid service port/);
});

test('alias command is print-only and can run without a TTY or service identity',async t => {
  let output=''; t.mock.method(process.stdout,'write',(chunk:string)=>{output+=chunk; return true;});
  assert.equal(await main(['wrap','--aliases']),0);
  assert.equal(output,"alias codex='swarmaa wrap codex'\nalias agy='swarmaa wrap agy'\n");
});
