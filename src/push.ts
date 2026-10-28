import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { Pool, PoolClient } from 'pg';
import { noExtraKeys, type Db } from './core/shared.js';
import { requireCondition } from './errors.js';
import { enumValue, string } from './validation.js';
import type { Principal } from './types.js';

export async function pushDevice(db:Db,p:Principal,input:Record<string,unknown>,register:boolean):Promise<{ok:true}> {
  noExtraKeys(input,register ? ['token','environment'] : ['token']);
  const token = string(input.token,'token',200).toLowerCase();
  requireCondition(/^[0-9a-f]{64,200}$/.test(token),400,'invalid_arguments','token must be 64–200 hex characters.');
  if (register) {
    const environment = enumValue(input.environment,'environment',['sandbox','production'] as const);
    await db.query(`INSERT INTO push_devices (token,tenant_id,principal_id,environment) VALUES ($1,$2,$3,$4)
      ON CONFLICT (token) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,principal_id=EXCLUDED.principal_id,
      environment=EXCLUDED.environment,updated_at=clock_timestamp()`,[token,p.tenantId,p.id,environment]);
  } else {
    await db.query('DELETE FROM push_devices WHERE token=$1 AND tenant_id=$2 AND principal_id=$3',[token,p.tenantId,p.id]);
  }
  return {ok:true};
}

type Environment = 'sandbox'|'production';
export interface Device {token:string; tenant_id:string; principal_id:string; environment:Environment; updated_at:string}
export interface PushPayload {
  aps:{alert:{title:string;body:'Needs you'|'Replied'|'Task failed'|'Ready for review'};sound:'default';'thread-id':string};
  bot_id:string;
}
export interface PushResult {status:number;reason?:string}
export interface PushSender {send(device:Device,payload:PushPayload):Promise<PushResult>;close():void}
export interface PushEvent {name:string;subject_id:string;tenant_id:string;scope:string;payload:Record<string,unknown>}

// Only allowlisted identifiers and fixed labels cross the APNs boundary. Never spread event data.
export async function eventPayload(db:Db,e:PushEvent):Promise<PushPayload|null> {
  let body:PushPayload['aps']['alert']['body'];
  let bot:{id:string;name:string}|undefined;
  if (e.name === 'task.updated') {
    if (e.payload.action !== 'finished' || !['completed','failed'].includes(String(e.payload.status))) return null;
    bot = (await db.query<{id:string;name:string}>(`SELECT b.id,b.name FROM tasks t JOIN bots b ON b.id=t.bot_id AND b.tenant_id=t.tenant_id
      WHERE t.id::text=$1 AND t.tenant_id=$2 AND t.scope=$3 AND b.scope=t.scope AND NOT b.archived
      AND ($4='failed' OR (t.result->>'head_commit' IS NOT NULL))`,[e.subject_id,e.tenant_id,e.scope,e.payload.status])).rows[0];
    body = e.payload.status === 'failed' ? 'Task failed' : 'Ready for review';
  } else {
    if (e.name === 'question.created') body = 'Needs you';
    else if (e.name === 'message.created' && ['text','notice','answer'].includes(String(e.payload.kind)) &&
      (e.payload.author as {kind?:string}|undefined)?.kind === 'agent') body = 'Replied';
    else return null;
    if (typeof e.payload.thread_id !== 'string') return null;
    bot = (await db.query<{id:string;name:string}>(`SELECT id,name FROM bots
      WHERE thread_id::text=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived`,[e.payload.thread_id,e.tenant_id,e.scope])).rows[0];
  }
  return bot ? {aps:{alert:{title:bot.name,body},sound:'default','thread-id':bot.id},bot_id:bot.id} : null;
}

export async function deliverPush(db:Db,sender:PushSender,device:Device,payload:PushPayload):Promise<void> {
  const result = await sender.send(device,payload);
  if (result.status === 410 || (result.status === 400 && ['BadDeviceToken','Unregistered'].includes(result.reason ?? ''))) {
    // A re-registration while the request was in flight must survive a stale rejection.
    await db.query(`DELETE FROM push_devices WHERE token=$1 AND tenant_id=$2 AND principal_id=$3
      AND environment=$4 AND updated_at=$5::timestamptz`,[device.token,device.tenant_id,device.principal_id,device.environment,device.updated_at]);
  }
}

interface APNsConfig {keyPath:string;keyId:string;teamId:string;bundleId:string}
export function createAPNsSender(config:APNsConfig,openSession:typeof connect=connect):PushSender {
  const key = createPrivateKey(readFileSync(config.keyPath,'utf8'));
  let jwt = '', issuedAt = 0;
  const sessions = new Map<Environment,ClientHttp2Session>();
  function token(force:boolean):string {
    if (!jwt || force || Date.now()-issuedAt >= 50*60_000) {
      issuedAt = Date.now();
      const header = Buffer.from(JSON.stringify({alg:'ES256',kid:config.keyId})).toString('base64url');
      const claims = Buffer.from(JSON.stringify({iss:config.teamId,iat:Math.floor(issuedAt/1000)})).toString('base64url');
      const data = `${header}.${claims}`;
      jwt = `${data}.${sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
    }
    return jwt;
  }
  function once(device:Device,payload:PushPayload,force:boolean):Promise<PushResult> {
    return new Promise(resolve => {
      let request:ReturnType<ClientHttp2Session['request']>|undefined;
      let session = sessions.get(device.environment);
      let settled = false;
      const finish = (result:PushResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        session?.removeListener('error',fail);
        session?.removeListener('close',fail);
        resolve(result);
      };
      const fail = () => finish({status:0});
      const deadline = setTimeout(() => { request?.close(); session?.destroy(); fail(); },10_000);
      try {
        if (!session || session.closed || session.destroyed) {
          session = openSession(`https://${device.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'}`);
          sessions.set(device.environment,session);
          session.on('error',() => {}); // Request errors are deliberately never logged (may include tokens).
          session.on('goaway',() => session?.close());
        }
        session.once('error',fail);
        session.once('close',fail);
        request = session.request({':method':'POST',':path':`/3/device/${device.token}`,
          authorization:`bearer ${token(force)}`,'apns-topic':config.bundleId,'apns-push-type':'alert',
          'apns-priority':'10','apns-collapse-id':payload.bot_id});
        let status = 0, data = '';
        request.on('response',headers => { status = Number(headers[':status']); });
        request.setEncoding('utf8');
        request.on('data',(chunk:string) => {
          data += chunk;
          if (data.length > 8192) { request?.close(); fail(); }
        });
        request.on('error',fail);
        request.on('close',() => { if (!settled) fail(); });
        request.on('end',() => {
          let reason:string|undefined;
          try { reason = JSON.parse(data).reason; } catch { /* Empty/non-JSON response. */ }
          finish({status,reason});
        });
        request.end(JSON.stringify(payload));
      } catch { request?.close(); fail(); }
    });
  }
  return {
    async send(device,payload) {
      const result = await once(device,payload,false);
      if (result.status === 0 || result.status >= 500 || result.status === 429 || result.reason === 'ExpiredProviderToken') {
        return once(device,payload,result.reason === 'ExpiredProviderToken');
      }
      return result;
    },
    close() { for (const session of sessions.values()) session.destroy(); sessions.clear(); },
  };
}

export class PushWorker {
  private timer:NodeJS.Timeout|undefined;
  private listener:PoolClient|undefined;
  private active:Promise<void>|undefined;
  private sender:PushSender|undefined;
  private started = false;
  private stopped = false;
  constructor(private readonly pool:Pool,private readonly options:{env?:NodeJS.ProcessEnv;log?:(message:string)=>void;sender?:PushSender}={}) {}
  start():void {
    if (this.started) return;
    this.started = true;
    const env = this.options.env ?? process.env;
    const log = this.options.log ?? ((message:string) => process.stderr.write(`${message}\n`));
    if (['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_BUNDLE_ID'].some(name => !env[name]?.trim())) {
      log('Push worker disabled: APNs configuration is incomplete.');
      return;
    }
    try {
      this.sender = this.options.sender ?? createAPNsSender({keyPath:env.APNS_KEY_PATH!,keyId:env.APNS_KEY_ID!,teamId:env.APNS_TEAM_ID!,bundleId:env.APNS_BUNDLE_ID!});
    } catch { log('Push worker disabled: APNs key could not be loaded.'); return; }
    const wake = () => {
      if (!this.active && !this.stopped) this.active = this.tick().catch(() => {
        log('Push worker sweep failed; will retry.');
      }).finally(() => { this.active = undefined; });
    };
    this.wake = wake;
    this.timer = setInterval(wake,5000);
    this.timer.unref();
    wake();
  }
  private wake = ():void => {};
  private async tick():Promise<void> {
    if (!this.listener) {
      const client = await this.pool.connect();
      this.listener = client;
      const lost = () => {
        if (this.listener === client) { this.listener = undefined; client.release(true); }
      };
      client.on('error',lost);
      client.on('end',lost);
      client.on('notification',msg => { if (msg.channel === 'swarmaa_events') this.wake(); });
      try { await client.query('LISTEN swarmaa_events'); } catch { lost(); throw new Error('Push listener failed.'); }
    }
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // One worker owns cursor and coalescing through delivery, including across server processes.
      const cursor = (await db.query<{last_xid:string;last_seq:string}>('SELECT last_xid,last_seq FROM push_cursor WHERE id=1 FOR UPDATE')).rows[0]!;
      const rows = (await db.query<PushEvent & {xid:string;seq:string;fresh:boolean}>(`SELECT name,subject_id,tenant_id,scope,payload,xid::text,seq::text,
        created_at >= clock_timestamp()-interval '10 minutes' AS fresh FROM events
        WHERE (xid,seq)>($1::xid8,$2::bigint) AND xid<pg_snapshot_xmin(pg_current_snapshot())
        ORDER BY xid,seq LIMIT 100`,[cursor.last_xid,cursor.last_seq])).rows;
      for (const e of rows) {
        const payload = e.fresh ? await eventPayload(db,e) : null;
        if (payload) {
          const allowed = await db.query(`INSERT INTO push_cooldowns (bot_id,sent_at) VALUES ($1,clock_timestamp())
            ON CONFLICT (bot_id) DO UPDATE SET sent_at=EXCLUDED.sent_at
            WHERE push_cooldowns.sent_at <= clock_timestamp()-interval '20 seconds' RETURNING bot_id`,[payload.bot_id]);
          if (allowed.rows.length) {
            const devices = (await db.query<Device>('SELECT token,tenant_id,principal_id,environment,updated_at::text FROM push_devices WHERE tenant_id=$1',[e.tenant_id])).rows;
            for (const device of devices) await deliverPush(db,this.sender!,device,payload);
          }
        }
        await db.query('UPDATE push_cursor SET last_xid=$1::xid8,last_seq=$2 WHERE id=1',[e.xid,e.seq]);
      }
      await db.query('COMMIT');
      if (rows.length === 100) setImmediate(this.wake);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async stop():Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
    if (this.listener) {
      const client = this.listener;
      this.listener = undefined;
      client.release(true);
    }
    this.sender?.close();
  }
}
