import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Delivery, notice, type InboxItem, type Verdict } from './delivery.js';
import type { Harness } from './terminal.js';

export function installRoot() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  return existsSync(join(root,'package.json')) ? root : dirname(root);
}
export function connection(root:string,harness:Harness) {
  const identity=harness==='agy' ? 'antigravity' : 'codex';
  const {token}=JSON.parse(readFileSync(join(root,'.local',`${identity}.json`),'utf8'));
  if (typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('missing wrapper identity');
  let port=8787;
  try {
    const value=readFileSync(join(root,'.env'),'utf8').match(/^PORT=(.*)$/m)?.[1];
    if (value!==undefined) port=Number(value.trim());
  } catch { /* same default as the MCP launcher */ }
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('invalid service port');
  return new Inbox(`http://127.0.0.1:${port}`,token);
}

export class Inbox {
  constructor(private origin:string,private token:string) {}
  async request(path:string,signal:AbortSignal,body?:Record<string,unknown>):Promise<any> {
    const response=await fetch(`${this.origin}${path}`,{method:body ? 'POST' : 'GET',redirect:'error',signal,
      headers:{Authorization:`Bearer ${this.token}`,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) { await response.body?.cancel(); throw new Error('inbox unavailable'); }
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];
    let size=0;
    for (;;) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>65536) { await reader.cancel(); throw new Error('inbox response too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).result;
  }
  wait(session:string,signal:AbortSignal) {
    return this.request(`/api/inbox/wait?session=${encodeURIComponent(session)}&timeout=25`,AbortSignal.any([signal,AbortSignal.timeout(27000)]));
  }
  ack(session:string,delivery_id:string,state:'accepted'|'unconfirmed',signal:AbortSignal) {
    return this.request('/api/tools/inbox_ack',AbortSignal.any([signal,AbortSignal.timeout(2000)]),{session,delivery_id,state});
  }
}
export type Report=(event:{event:string;delivery_id?:string;reason?:string})=>void;

/** Stable IDs are retained before any write; an uncertain acknowledgment never causes a body replay. */
export async function listen(inbox:Pick<Inbox,'wait'|'ack'>,delivery:Delivery,session:string,signal:AbortSignal,report:Report) {
  const attempted=new Set<string>(),pending=new Map<string,'accepted'|'unconfirmed'>();
  let errors=0, registered=false;
  const flush=async () => {
    for (const [id,state] of pending) {
      await inbox.ack(session,id,state,signal); pending.delete(id);
      report({event:'receipt_recorded',delivery_id:id,reason:state});
    }
  };
  while (!signal.aborted) {
    try {
      await flush();
      const generation=delivery.generation;
      const result=await inbox.wait(session,signal);
      if (!registered) { registered=true; report({event:'session_registered'}); }
      errors=0;
      if (signal.aborted) break;
      const items:InboxItem[]=Array.isArray(result?.items) ? result.items.filter((x:any) => x && typeof x.body==='string' && typeof x.delivery_id==='string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.delivery_id) && !attempted.has(x.delivery_id)).slice(0,4) : [];
      if (!items.length) continue;
      // ponytail: stop automatic input after 4096 deliveries per session to bound replay protection; start a new wrap session for longer use.
      if (attempted.size+items.length>4096) { report({event:'delivery_limit'}); return; }
      for (const item of items) attempted.add(item.delivery_id);
      const formatted=notice(items,session),verdict:Verdict=await delivery.deliver(formatted.text,generation);
      for (const item of items) {
        // Acceptance hides bodies from inbox_get; a summary has not delivered those bodies.
        pending.set(item.delivery_id,verdict==='accepted' && !formatted.summary ? 'accepted' : 'unconfirmed');
        report({event:'delivery',delivery_id:item.delivery_id,reason:verdict==='accepted' && formatted.summary ? 'summary_accepted' : verdict});
      }
      await flush();
    } catch {
      if (signal.aborted) break;
      if (!errors) report({event:'inbox_unavailable'});
      errors++;
      try { await delay(Math.min(30000,1000*2**Math.min(errors-1,5)),undefined,{signal}); } catch { break; }
    }
  }
}
