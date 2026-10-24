import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawn, type IPty } from 'node-pty';

async function fixture(t:any) {
  const home=mkdtempSync(join(tmpdir(),'wrap-pty-')),bin=join(home,'bin');
  mkdirSync(bin); mkdirSync(join(home,'.local'));
  writeFileSync(join(bin,'codex'),`#!${process.execPath}\n${readFileSync(new URL('./fixtures/pty/harness.mjs',import.meta.url),'utf8')}`,{mode:0o700});
  writeFileSync(join(home,'.local/codex.json'),JSON.stringify({token:'fixture-only-token'}));
  let offer:ServerResponse|undefined,child:IPty|undefined,output='',acks:any[]=[],exited=false;
  const id=randomUUID(),server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-only-token');
    if (req.url?.startsWith('/api/inbox/wait')) { offer=res; return; }
    let data=''; for await (const c of req) data+=c;
    acks.push(JSON.parse(data)); res.end(JSON.stringify({result:{}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  writeFileSync(join(home,'.env'),`PORT=${(server.address() as {port:number}).port}\n`);
  let notify:()=>void=()=>{};
  const until=async(check:()=>boolean) => {
    const deadline=Date.now()+10000;
    while (!check()) {
      if (Date.now()>=deadline) throw new Error(`PTY condition timed out: ${output.slice(-1000)}`);
      await new Promise<void>(r=>{const timer=setTimeout(r,50); notify=()=>{clearTimeout(timer); r();};});
    }
  };
  t.after(async()=>{
    if (!exited) try { child?.kill('SIGKILL'); } catch { /* gone */ }
    server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(home,{recursive:true,force:true});
  });
  child=spawn(process.execPath,['--import','tsx',resolve('src/wrap/cli.ts'),'wrap','codex'],{
    cwd:process.cwd(),cols:120,rows:32,name:'xterm-256color',env:{HOME:home,PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,SWARMAA_WRAP_ROOT:home},
  });
  const exit=new Promise<number>(r=>child!.onExit(e=>{exited=true; r(e.exitCode); notify();}));
  child.onData(data=>{output+=data; notify();});
  await until(()=>output.includes('Ask Codex to do anything') && !!offer);
  return {child,home,exit,acks,until,output:()=>output,send:()=>{
    assert.ok(offer); offer.end(JSON.stringify({result:{items:[{delivery_id:id,body:'local PTY wake fixture'}]}})); offer=undefined;
  }};
}

test('real PTYs preserve colours, resize and human keys/exit code while recording proven harness acceptance', {timeout:15000},async t=>{
  const f=await fixture(t);
  assert.match(f.output(),/\x1b\[32mPTY fixture/);
  f.child.resize(100,35); await f.until(()=>f.output().includes('SIZE 100x35'));
  f.send(); await f.until(()=>f.acks.length>0);
  assert.equal(f.acks[0].state,'accepted'); assert.match(f.acks[0].session,/^wrap:codex:/);
  assert.match(f.output(),/BODY_ACCEPTED.*local PTY wake fixture/);
  assert.doesNotMatch(f.output(),/PARKED/);
  f.child.write('q'); assert.equal(await f.exit,23);
});

test('Ctrl-Z/resume and a real termination signal reach the child while preserving its exit code', {timeout:15000},async t=>{
  const f=await fixture(t);
  f.child.write('\x1a'); await delay(100); f.child.kill('SIGCONT');
  await f.until(()=>f.output().includes('SIGNAL SIGCONT'));
  f.child.kill('SIGTERM'); assert.equal(await f.exit,41);
  assert.match(f.output(),/SIGNAL SIGTERM/);
});
