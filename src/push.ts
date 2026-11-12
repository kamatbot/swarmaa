import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { Pool, PoolClient } from 'pg';
import { noExtraKeys, type Db } from './core/shared.js';
import { requireCondition } from './errors.js';
import { enumValue, string, uuid } from './validation.js';
import type { Principal } from './types.js';

export async function pushDevice(db:Db,p:Principal,input:Record<string,unknown>,register:boolean):Promise<{ok:true}> {
  noExtraKeys(input,register ? ['token','environment','activity_start_token','activity_token','activity_bot_id'] : ['token']);
  const token = string(input.token,'token',200).toLowerCase();
  requireCondition(/^[0-9a-f]{64,200}$/.test(token),400,'invalid_arguments','token must be 64–200 hex characters.');
  if (register) {
    const environment = enumValue(input.environment,'environment',['sandbox','production'] as const);
    const activityStartToken = input.activity_start_token !== undefined
      ? string(input.activity_start_token,'activity_start_token',512).toLowerCase()
      : undefined;
    if (activityStartToken !== undefined) {
      requireCondition(/^[0-9a-f]{1,512}$/.test(activityStartToken),400,'invalid_arguments','activity_start_token must be hex up to 512 characters.');
    }
    const hasActivityToken = input.activity_token !== undefined;
    const hasActivityBotId = input.activity_bot_id !== undefined;
    requireCondition(hasActivityToken === hasActivityBotId,400,'invalid_arguments','activity_token and activity_bot_id must be provided together.');
    const activityToken = hasActivityToken
      ? string(input.activity_token,'activity_token',512).toLowerCase()
      : undefined;
    if (activityToken !== undefined) {
      requireCondition(/^[0-9a-f]{1,512}$/.test(activityToken),400,'invalid_arguments','activity_token must be hex up to 512 characters.');
    }
    const activityBotId = hasActivityBotId
      ? uuid(input.activity_bot_id,'activity_bot_id')
      : undefined;

    if (activityStartToken !== undefined) {
      await db.query(`INSERT INTO push_devices (token,tenant_id,principal_id,environment,activity_start_token) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (token) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,principal_id=EXCLUDED.principal_id,
        environment=EXCLUDED.environment,updated_at=clock_timestamp(),activity_start_token=EXCLUDED.activity_start_token`,
        [token,p.tenantId,p.id,environment,activityStartToken]);
    } else {
      await db.query(`INSERT INTO push_devices (token,tenant_id,principal_id,environment) VALUES ($1,$2,$3,$4)
        ON CONFLICT (token) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,principal_id=EXCLUDED.principal_id,
        environment=EXCLUDED.environment,updated_at=clock_timestamp()`,[token,p.tenantId,p.id,environment]);
    }

    if (activityToken && activityBotId) {
      await db.query(`INSERT INTO bot_activity_tokens (tenant_id,device_id,bot_id,token,updated_at)
        VALUES ($1,$2,$3,$4,clock_timestamp())
        ON CONFLICT (device_id,bot_id) DO UPDATE SET token=EXCLUDED.token,updated_at=clock_timestamp()`,
        [p.tenantId,token,activityBotId,activityToken]);
    }
  } else {
    await db.query('DELETE FROM push_devices WHERE token=$1 AND tenant_id=$2 AND principal_id=$3',[token,p.tenantId,p.id]);
  }
  return {ok:true};
}

type Environment = 'sandbox'|'production';
export interface Device {
  token:string;
  tenant_id:string;
  principal_id:string;
  environment:Environment;
  updated_at:string;
  activity_start_token?:string|null;
}
export interface PushPayload {
  aps:{alert:{title:string;body:'Needs you'|'Replied'|'Task failed'|'Ready for review'};sound:'default';'thread-id':string;'mutable-content':1};
  bot_id:string;
  bot_name:string;
  bot_avatar:string|null;
  bot_color:string|null;
}

export type LiveActivityStatus = 'running' | 'needs_you' | 'done' | 'failed';

export interface LiveActivityContentState {
  status: LiveActivityStatus;
  step: string;
  startedAt: number;
  endedAt?: number;
}

export interface BotTurnAttributes {
  botId: string;
  botName: string;
  avatar?: string;
  color?: string;
}

export interface LiveActivityPayload {
  aps: {
    timestamp: number;
    event: 'start' | 'update' | 'end';
    'content-state': LiveActivityContentState;
    'attributes-type'?: 'BotTurnAttributes';
    attributes?: BotTurnAttributes;
    'dismissal-date'?: number;
  };
  bot_id: string;
}

export interface SendOptions {
  token?: string;
  pushType?: 'alert' | 'liveactivity';
  topic?: string;
  priority?: '5' | '10';
}

export interface PushResult {status:number;reason?:string}
export interface PushSender {
  send(device:Device,payload:PushPayload|LiveActivityPayload,options?:SendOptions):Promise<PushResult>;
  close():void;
}
export interface PushEvent {name:string;subject_id:string;tenant_id:string;scope:string;payload:Record<string,unknown>}

export function extractActivityStep(checkpoint: unknown): string {
  if (checkpoint && typeof checkpoint === 'object' && 'activity' in checkpoint) {
    const list = (checkpoint as { activity?: unknown }).activity;
    if (Array.isArray(list)) {
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (item && typeof item === 'object' && typeof (item as { label?: unknown }).label === 'string') {
          const label = (item as { label: string }).label.trim();
          if (label.length > 0) return label.slice(0, 80);
        }
      }
    }
  }
  return 'Working';
}

export interface BuildLiveActivityOptions {
  event: 'start' | 'update' | 'end';
  status: LiveActivityStatus;
  step?: string;
  startedAt: number;
  endedAt?: number;
  bot: { id: string; name: string; avatar?: string | null; color?: string | null };
  now?: number;
}

export function buildLiveActivityPayload(options: BuildLiveActivityOptions): LiveActivityPayload {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const step = (options.step ?? 'Working').slice(0, 80);
  const contentState: LiveActivityContentState = {
    status: options.status,
    step,
    startedAt: options.startedAt,
    ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
  };

  const aps: LiveActivityPayload['aps'] = {
    timestamp: now,
    event: options.event,
    'content-state': contentState,
  };

  if (options.event === 'start') {
    const attributes: BotTurnAttributes = {
      botId: options.bot.id,
      botName: options.bot.name,
      ...(options.bot.avatar ? { avatar: options.bot.avatar } : {}),
      ...(options.bot.color ? { color: options.bot.color } : {}),
    };
    aps['attributes-type'] = 'BotTurnAttributes';
    aps.attributes = attributes;
  } else if (options.event === 'end') {
    aps['dismissal-date'] = now + 15 * 60;
  }

  return { aps, bot_id: options.bot.id };
}

export function liveActivityHeaders(bundleId: string, event: 'start' | 'update' | 'end', token: string): Record<string, string> {
  return {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    'apns-topic': `${bundleId}.push-type.liveactivity`,
    'apns-push-type': 'liveactivity',
    'apns-priority': event === 'update' ? '5' : '10',
  };
}

export class ActivityUpdateThrottle {
  private readonly lastUpdates = new Map<string, number>();

  constructor(private readonly windowMs = 15_000) {}

  shouldUpdate(botId: string, now = Date.now()): boolean {
    const last = this.lastUpdates.get(botId);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    this.lastUpdates.set(botId, now);
    return true;
  }

  record(botId: string, now = Date.now()): void {
    this.lastUpdates.set(botId, now);
  }

  clear(botId?: string): void {
    if (botId) this.lastUpdates.delete(botId);
    else this.lastUpdates.clear();
  }
}

export function shouldThrottleActivityUpdate(lastSentMs: number | undefined, nowMs = Date.now(), windowMs = 15_000): boolean {
  if (lastSentMs === undefined) return false;
  return nowMs - lastSentMs < windowMs;
}

// Only allowlisted identifiers and fixed labels cross the APNs boundary. Never spread event data.
export async function eventPayload(db:Db,e:PushEvent):Promise<PushPayload|null> {
  let body:PushPayload['aps']['alert']['body'];
  let bot:{id:string;name:string;avatar:string|null;color:string|null}|undefined;
  if (e.name === 'task.updated') {
    if (e.payload.action !== 'finished' || !['completed','failed'].includes(String(e.payload.status))) return null;
    bot = (await db.query<{id:string;name:string;avatar:string|null;color:string|null}>(`SELECT b.id,b.name,b.avatar,b.color FROM tasks t JOIN bots b ON b.id=t.bot_id AND b.tenant_id=t.tenant_id
      WHERE t.id::text=$1 AND t.tenant_id=$2 AND t.scope=$3 AND b.scope=t.scope AND NOT b.archived
      AND ($4='failed' OR (t.result->>'head_commit' IS NOT NULL))`,[e.subject_id,e.tenant_id,e.scope,e.payload.status])).rows[0];
    body = e.payload.status === 'failed' ? 'Task failed' : 'Ready for review';
  } else {
    if (e.name === 'question.created') body = 'Needs you';
    else if (e.name === 'message.created' && ['text','notice','answer'].includes(String(e.payload.kind)) &&
      (e.payload.author as {kind?:string}|undefined)?.kind === 'agent') body = 'Replied';
    else return null;
    if (typeof e.payload.thread_id !== 'string') return null;
    bot = (await db.query<{id:string;name:string;avatar:string|null;color:string|null}>(`SELECT id,name,avatar,color FROM bots
      WHERE thread_id::text=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived`,[e.payload.thread_id,e.tenant_id,e.scope])).rows[0];
  }
  return bot ? {
    aps:{alert:{title:bot.name,body},sound:'default','thread-id':bot.id,'mutable-content':1},
    bot_id:bot.id,
    bot_name:bot.name,
    bot_avatar:bot.avatar ?? null,
    bot_color:bot.color ?? null,
  } : null;
}

export async function deliverPush(db:Db,sender:PushSender,device:Device,payload:PushPayload):Promise<void> {
  const result = await sender.send(device,payload);
  if (result.status === 410 || (result.status === 400 && ['BadDeviceToken','Unregistered'].includes(result.reason ?? ''))) {
    // A re-registration while the request was in flight must survive a stale rejection.
    await db.query(`DELETE FROM push_devices WHERE token=$1 AND tenant_id=$2 AND principal_id=$3
      AND environment=$4 AND updated_at=$5::timestamptz`,[device.token,device.tenant_id,device.principal_id,device.environment,device.updated_at]);
  }
}

export async function deliverLiveActivity(
  db: Db,
  sender: PushSender,
  device: Device,
  botId: string,
  payload: LiveActivityPayload,
  targetToken: string,
  isStartToken: boolean,
): Promise<PushResult> {
  const priority = payload.aps.event === 'update' ? '5' : '10';
  const result = await sender.send(device, payload, {
    token: targetToken,
    pushType: 'liveactivity',
    priority,
  });
  if (result.status === 410 || (result.status === 400 && ['BadDeviceToken', 'Unregistered'].includes(result.reason ?? ''))) {
    if (isStartToken) {
      await db.query(`UPDATE push_devices SET activity_start_token=NULL WHERE token=$1 AND activity_start_token=$2`, [device.token, targetToken]);
    } else {
      await db.query(`DELETE FROM bot_activity_tokens WHERE device_id=$1 AND bot_id=$2 AND token=$3`, [device.token, botId, targetToken]);
    }
  }
  return result;
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
  function once(device:Device,payload:PushPayload|LiveActivityPayload,force:boolean,options?:SendOptions):Promise<PushResult> {
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

        const isLive = options?.pushType === 'liveactivity' || ('event' in payload.aps);
        const pushType = options?.pushType ?? (isLive ? 'liveactivity' : 'alert');
        const defaultTopic = isLive ? `${config.bundleId}.push-type.liveactivity` : config.bundleId;
        const topic = options?.topic ?? defaultTopic;
        const defaultPriority = (isLive && 'event' in payload.aps && payload.aps.event === 'update') ? '5' : '10';
        const priority = options?.priority ?? defaultPriority;
        const targetToken = options?.token ?? device.token;

        const headers: Record<string, string> = {
          ':method': 'POST',
          ':path': `/3/device/${targetToken}`,
          authorization: `bearer ${token(force)}`,
          'apns-topic': topic,
          'apns-push-type': pushType,
          'apns-priority': priority,
        };
        if (!isLive && 'bot_id' in payload && payload.bot_id) {
          headers['apns-collapse-id'] = payload.bot_id;
        }

        request = session.request(headers);
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
    async send(device,payload,options) {
      const result = await once(device,payload,false,options);
      if (result.status === 0 || result.status >= 500 || result.status === 429 || result.reason === 'ExpiredProviderToken') {
        return once(device,payload,result.reason === 'ExpiredProviderToken',options);
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
  private throttle = new ActivityUpdateThrottle(15_000);
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
        if (e.fresh) {
          await this.sweepLiveActivity(db, e);
        }
        await db.query('UPDATE push_cursor SET last_xid=$1::xid8,last_seq=$2 WHERE id=1',[e.xid,e.seq]);
      }
      await db.query('COMMIT');
      if (rows.length === 100) setImmediate(this.wake);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  private async sweepLiveActivity(db:Db,e:PushEvent):Promise<void> {
    if (!this.sender) return;
    if (e.name === 'task.updated') {
      const status = String(e.payload.status ?? '');
      const action = String(e.payload.action ?? '');
      const isRunning = status === 'running';
      const isFinished = action === 'finished' || ['completed','failed'].includes(status);
      if (!isRunning && !isFinished) return;

      const taskRow = (await db.query<{
        id:string;status:string;checkpoint:unknown;created_at:string;updated_at:string;completed_at?:string;
        bot_id:string;bot_name:string;bot_avatar?:string|null;bot_color?:string|null;
      }>(`SELECT t.id,t.status,t.checkpoint,t.created_at::text,t.updated_at::text,t.completed_at::text,
        b.id AS bot_id,b.name AS bot_name,b.avatar AS bot_avatar,b.color AS bot_color
        FROM tasks t JOIN bots b ON b.id=t.bot_id AND b.tenant_id=t.tenant_id
        WHERE t.id::text=$1 AND t.tenant_id=$2 AND t.scope=$3 AND b.scope=t.scope AND NOT b.archived`,
        [e.subject_id,e.tenant_id,e.scope])).rows[0];
      if (!taskRow) return;

      const bot = {id:taskRow.bot_id,name:taskRow.bot_name,avatar:taskRow.bot_avatar,color:taskRow.bot_color};
      const step = extractActivityStep(taskRow.checkpoint);
      const startedAt = Math.floor(new Date(taskRow.created_at).getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);

      const devices = (await db.query<Device>('SELECT token,tenant_id,principal_id,environment,updated_at::text,activity_start_token FROM push_devices WHERE tenant_id=$1',[e.tenant_id])).rows;
      if (!devices.length) return;

      const activityTokens = (await db.query<{device_id:string;token:string}>('SELECT device_id,token FROM bot_activity_tokens WHERE tenant_id=$1 AND bot_id=$2',[e.tenant_id,bot.id])).rows;
      const tokenMap = new Map(activityTokens.map(r => [r.device_id,r.token]));

      if (isFinished) {
        const finalStatus = (taskRow.status === 'failed' || status === 'failed') ? 'failed' : 'done';
        const endedAt = taskRow.completed_at ? Math.floor(new Date(taskRow.completed_at).getTime() / 1000) : now;
        const payload = buildLiveActivityPayload({event:'end',status:finalStatus,step,startedAt,endedAt,bot,now});
        for (const device of devices) {
          const actToken = tokenMap.get(device.token);
          if (actToken) {
            await deliverLiveActivity(db,this.sender,device,bot.id,payload,actToken,false);
          }
        }
      } else if (isRunning) {
        let hasUpdates = false;
        for (const device of devices) {
          if (tokenMap.has(device.token)) { hasUpdates = true; break; }
        }
        if (hasUpdates) {
          if (this.throttle.shouldUpdate(bot.id)) {
            const payload = buildLiveActivityPayload({event:'update',status:'running',step,startedAt,bot,now});
            for (const device of devices) {
              const actToken = tokenMap.get(device.token);
              if (actToken) {
                await deliverLiveActivity(db,this.sender,device,bot.id,payload,actToken,false);
              }
            }
          }
        }
        for (const device of devices) {
          if (!tokenMap.has(device.token) && device.activity_start_token) {
            const payload = buildLiveActivityPayload({event:'start',status:'running',step,startedAt,bot,now});
            await deliverLiveActivity(db,this.sender,device,bot.id,payload,device.activity_start_token,true);
          }
        }
      }
    } else if (e.name === 'question.created') {
      if (typeof e.payload.thread_id !== 'string') return;
      const bot = (await db.query<{id:string;name:string;avatar?:string|null;color?:string|null}>(`SELECT id,name,avatar,color FROM bots
        WHERE thread_id::text=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived`,[e.payload.thread_id,e.tenant_id,e.scope])).rows[0];
      if (!bot) return;

      const task = (await db.query<{checkpoint:unknown;created_at:string}>(`SELECT checkpoint,created_at::text FROM tasks
        WHERE bot_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1`,[bot.id,e.tenant_id])).rows[0];
      const step = extractActivityStep(task?.checkpoint);
      const now = Math.floor(Date.now() / 1000);
      const startedAt = task?.created_at ? Math.floor(new Date(task.created_at).getTime() / 1000) : now;

      const devices = (await db.query<Device>('SELECT token,tenant_id,principal_id,environment,updated_at::text,activity_start_token FROM push_devices WHERE tenant_id=$1',[e.tenant_id])).rows;
      if (!devices.length) return;

      const activityTokens = (await db.query<{device_id:string;token:string}>('SELECT device_id,token FROM bot_activity_tokens WHERE tenant_id=$1 AND bot_id=$2',[e.tenant_id,bot.id])).rows;
      const tokenMap = new Map(activityTokens.map(r => [r.device_id,r.token]));

      this.throttle.record(bot.id);
      const payload = buildLiveActivityPayload({event:'update',status:'needs_you',step,startedAt,bot,now});
      for (const device of devices) {
        const actToken = tokenMap.get(device.token);
        if (actToken) {
          await deliverLiveActivity(db,this.sender,device,bot.id,payload,actToken,false);
        }
      }
    }
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
