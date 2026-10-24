import type { Pool, PoolClient, Notification } from 'pg';
import { inboxSession } from './core/inbox.js';
import { AppError } from './errors.js';
import type { Principal, ToolBackend } from './types.js';

interface Listener { principal:string; wake:(failed?:boolean)=>void }
interface Hub { listeners:Set<Listener>; ready:Promise<PoolClient> }
const hubs = new WeakMap<Pool,Hub>();

async function subscribe(pool:Pool,listener:Listener):Promise<()=>void> {
  let hub = hubs.get(pool);
  if (!hub) {
    const listeners = new Set<Listener>();
    const ready = pool.connect().then(async client => {
      client.on('notification',(n:Notification) => {
        if (n.channel==='swarmaa_inbox') for (const l of listeners) if (l.principal===n.payload) l.wake();
      });
      client.on('error',() => { for (const l of listeners) l.wake(true); });
      try { await client.query('LISTEN swarmaa_inbox'); return client; }
      catch (error) { client.release(true); throw error; }
    });
    hub = {listeners,ready};
    hubs.set(pool,hub);
  }
  hub.listeners.add(listener);
  const release = () => {
    hub.listeners.delete(listener);
    if (!hub.listeners.size && hubs.get(pool)===hub) {
      hubs.delete(pool);
      void hub.ready.then(client => client.release(true),() => {});
    }
  };
  try { await hub.ready; return release; } catch (error) { release(); throw error; }
}

/** One LISTEN connection per active pool, never a connection/transaction held per waiting request. */
export async function waitForInbox(pool:Pool,core:ToolBackend,principal:Principal,sessionValue:unknown,seconds:number,
  signal:AbortSignal,refresh:()=>Promise<Principal>):Promise<unknown> {
  const session = inboxSession(sessionValue);
  if (!Number.isInteger(seconds) || seconds<0 || seconds>25) throw new AppError(400,'invalid_arguments','timeout must be an integer from 0 to 25 seconds.');
  const deadline = Date.now()+seconds*1000;
  let changed = true, failed = false, resolve:(()=>void)|undefined;
  const wake = (broken=false) => { changed=true; failed ||= broken; resolve?.(); };
  const abort = () => wake();
  signal.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(abort,seconds*1000);
  let release:(()=>void)|undefined;
  try {
    // Subscribe before the first read so an insert racing with that read cannot be lost.
    release = await subscribe(pool,{principal:principal.id,wake});
    do {
      changed=false;
      if (signal.aborted) return {items:[]};
      if (failed) throw new AppError(503,'inbox_unavailable','Inbox listener disconnected. Retry the request.');
      const fresh = await refresh();
      if (fresh.id!==principal.id || fresh.tenantId!==principal.tenantId) throw new AppError(401,'unauthorized','Connection changed.');
      const result = await core.call(fresh,'inbox_get',{session}) as {items:unknown[]};
      if (result.items.length || Date.now()>=deadline) return result;
      if (!changed) await new Promise<void>(done => { resolve=done; });
      resolve=undefined;
    } while (!signal.aborted);
    return {items:[]};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort',abort);
    release?.();
  }
}
