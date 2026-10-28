import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import type { Principal } from '../types.js';
import { uuid } from '../validation.js';
import { runnerCapability, type RunnerConfig } from '../bridge/adapters.js';
import { COMMIT } from './flow-definition.js';
import { decide, getPolicy, scopeUsage, type RoutingKind, type RoutingPolicy, type UsageRow } from './routing.js';
import { assertKnownScope, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, teamsLock, type Db } from './shared.js';
import { assignThreadSeq, clipUtf8 } from './teams.js';
import { taskChanged, type TaskRow } from './tasks.js';

export interface BotRoutingRow {
  id:string; tenant_id:string; scope:string; thread_id:string; lead_agent_id:string; created_by:string;
  job:string; routing:Partial<Record<BotKind, RunnerConfig | {mode:'different_from_author'}>>;
  rules:{schedule_paused?:boolean; quota_floor_pct?:number; review_edits?:boolean; require_tests?:boolean};
  schedule:string|null; next_run_at:Date|null; archived:boolean;
}
export const BOT_KINDS = ['research','patch','review','summary'] as const;
type BotKind = typeof BOT_KINDS[number];

export function quotaLeft(windows:UsageRow['windows']):number {
  return windows.length ? 100 - Math.max(...windows.map(w => w.used_percent)) : 0;
}

/** Tighten, never replace, the global limits. Unknown readings retain the router's existing fallback. */
export function botPolicy(policy:RoutingPolicy, usage:UsageRow[], floor=0):RoutingPolicy {
  // Floor 0 means "may run to empty": the global policy, fallback included, decides exactly as for any task.
  if (floor <= 0) return policy;
  return {...policy, fallback:'none', providers:policy.providers.filter(p => {
    const u = usage.find(u => u.provider===p.provider && u.ok && u.fresh && u.live && u.windows.length);
    if (!u) return floor===0;
    const gauge = (name:string) => u.windows.find(w => w.name.toLowerCase()===name)?.used_percent ?? Math.max(...u.windows.map(w => w.used_percent));
    return quotaLeft(u.windows)>=floor && gauge('5h')<p.max_five_hour_pct && gauge('weekly')<p.max_weekly_pct;
  })};
}

export async function taskBotPolicy(db:Db, tenantId:string, row:TaskRow, policy:RoutingPolicy, usage:UsageRow[]):Promise<RoutingPolicy> {
  if (!row.bot_id || !row.required_capability.startsWith('auto.')) return policy;
  const bot = (await db.query<BotRoutingRow>('SELECT * FROM bots WHERE tenant_id=$1 AND id=$2 AND scope=$3',[tenantId,row.bot_id,row.scope])).rows[0];
  return bot ? botPolicy(policy,usage,bot.rules.quota_floor_pct ?? 0) : {...policy,providers:[]};
}

export async function routingNow(db:Db, tenantId:string, bot:BotRoutingRow) {
  const [{policy},usage] = await Promise.all([getPolicy(db,tenantId),scopeUsage(db,tenantId,bot.scope)]);
  const floor = bot.rules.quota_floor_pct ?? 0;
  const filtered = botPolicy(policy,usage,floor);
  return Object.fromEntries(BOT_KINDS.map(kind => {
    const runner = bot.routing[kind] ?? {mode:'auto'};
    const routeKind:RoutingKind = kind==='summary' ? 'review' : kind;
    if ('provider' in runner) return [kind,{runner,provider_now:policy.providers.some(p => p.provider===runner.provider && p.enabled && p.kinds.includes(routeKind)) ? runner.provider : null,reason:'named runner'}];
    const decision = decide(filtered,routeKind,usage);
    const below = policy.providers.find(p => p.enabled && p.kinds.includes(routeKind) && usage.some(u => u.provider===p.provider && u.ok && u.fresh && u.live && u.windows.length && quotaLeft(u.windows)<floor));
    const name = below?.provider === 'codex' ? 'Codex' : below?.provider === 'claude' ? 'Claude' : 'Antigravity';
    const reason = runner.mode==='different_from_author' ? 'different from the author' : below ? `${name} below the ${floor}% floor` : decision.provider ? 'most quota left' : 'waiting for quota or a live worker';
    return [kind,{runner,provider_now:decision.provider,reason}];
  }));
}

export async function botRoutingPreview(db:Db,p:Principal,input:Record<string,unknown>) {
  noExtraKeys(input,['bot_id']);
  const [all,scopes] = scopeSql(p);
  const bot = requireFound((await db.query<BotRoutingRow>(`SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR scope=ANY($4::text[]))`,[uuid(input.bot_id,'bot_id'),p.tenantId,all,scopes])).rows[0],'Bot');
  assertKnownScope(p,bot.scope);
  return routingNow(db,p.tenantId,bot);
}

async function notice(db:Db,p:Principal,bot:BotRoutingRow,body:string) {
  const seq = await assignThreadSeq(db,p.tenantId,bot.thread_id), id = newId();
  await db.query(`INSERT INTO messages(id,tenant_id,scope,thread_id,seq,author,kind,body) VALUES($1,$2,$3,$4,$5,'{"kind":"system","id":"service"}','notice',$6)`,[id,p.tenantId,bot.scope,bot.thread_id,seq,body]);
  await event(db,p,bot.scope,'message.created',id,{thread_id:bot.thread_id,message_id:id,seq:Number(seq),kind:'notice'});
}

/** Called with scopeLock and teamsLock, after fenced completion, in the same transaction. */
export async function botTaskFinished(db:PoolClient,p:Principal,row:TaskRow):Promise<void> {
  if (!row.bot_id) return;
  const bot = (await db.query<BotRoutingRow>('SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 AND scope=$3',[row.bot_id,p.tenantId,row.scope])).rows[0];
  if (!bot) return;
  if (row.kind==='check' && row.initiator_kind==='bot_check' && row.initiator_id) {
    const status = row.status==='completed' ? 'passed' : 'failed';
    const parent = (await db.query<TaskRow>(`UPDATE tasks SET result=jsonb_set(coalesce(result,'{}'),'{check}',$4::jsonb),version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND bot_id=$3 RETURNING *`,[row.initiator_id,p.tenantId,bot.id,JSON.stringify({status,task_id:row.id})])).rows[0];
    if (parent) await taskChanged(db,p,parent,'bot_check',false);
    return;
  }
  const result = row.result ?? {};
  if (bot.archived || row.status!=='completed' || !(row.kind==='patch' || row.kind==='turn' && row.required_capability.endsWith('.patch')) || typeof result.head_commit!=='string' || !COMMIT.test(result.head_commit)) return;
  const branch = typeof result.branch==='string' ? result.branch : null;
  if (!branch) { await notice(db,p,bot,'Cannot queue bot checks: edit has no branch.'); return; }
  const enqueue = async(kind:'review'|'check',capability:string,exclusions:string[]=[]) => {
    const key = `bot-${kind}:${row.id}`;
    if ((await db.query('SELECT 1 FROM tasks WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',[p.tenantId,row.created_by,key])).rowCount) return;
    let flowId:string|null = null, flow:Record<string,unknown>|null = null;
    if (kind==='check') {
      if (typeof result.base_commit!=='string' || !COMMIT.test(result.base_commit)) { await notice(db,p,bot,'Cannot queue tests: edit has no base commit provenance.'); return; }
      flowId = newId();
      const step = {id:'tests',kind:'check',capability:'bridge.check',objective:'Run project tests on the bot edit',needs:[],check:{type:'tests_pass'}};
      await db.query(`INSERT INTO flow_runs(id,tenant_id,scope,definition,inputs,created_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'{}',$5,$6,$7)`,[flowId,p.tenantId,row.scope,JSON.stringify({id:'bot-tests',title:'Bot tests',steps:[step]}),row.created_by,key,sha256(key)]);
      flow = {step_id:'tests',needs:[],ready:true,commit:result.head_commit,diff_base:result.base_commit,provider:'bridge',check:{type:'tests_pass'}};
    }
    const objective = clipUtf8(`${kind==='review' ? 'Review' : 'Run project tests on'} branch ${branch}. Original objective: ${row.objective}`,16000);
    const task = (await db.query<TaskRow>(`INSERT INTO tasks(id,tenant_id,scope,kind,objective,required_capability,base_ref,resource_key,permission_envelope,created_by,idempotency_key,request_hash,bot_id,thread_id,initiator_kind,initiator_id,excluded_providers,flow_id,flow,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bot_check',$15,$16,$17,$18,'queued') RETURNING *`,[newId(),p.tenantId,row.scope,kind,objective,capability,kind==='check' ? result.head_commit : branch,kind==='check' ? null : row.resource_key,JSON.stringify({...row.permission_envelope,local_patch:kind==='check',deploy:false,publish:false,purchase:false,send_messages:false,permission_changes:false,external_side_effects:false}),row.created_by,key,sha256(key),bot.id,bot.thread_id,row.id,exclusions,flowId,flow && JSON.stringify(flow)])).rows[0]!;
    await taskChanged(db,p,task,'submitted',false);
  };
  if (bot.rules.review_edits!==false) {
    const runner = bot.routing.review ?? {mode:'different_from_author'};
    const author = (result.served as {provider?:string}|undefined)?.provider;
    const different = 'mode' in runner && runner.mode==='different_from_author';
    const {policy} = await getPolicy(db,p.tenantId);
    if (different && (!author || !policy.providers.some(x => x.enabled && x.kinds.includes('review') && x.provider!==author))) await notice(db,p,bot,'Review waiting: no different provider is enabled for reviews.');
    else await enqueue('review',different ? 'auto.read' : runnerCapability(runner as RunnerConfig,false),different ? [author!] : []);
  }
  if (bot.rules.require_tests) await enqueue('check','bridge.check');
}

interface CronField {values:Set<number>; wildcard:boolean}
function cronField(text:string,min:number,max:number):CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    requireCondition(match,400,'invalid_schedule','Invalid cron field.');
    const step = Number(match[2] ?? 1);
    const range = match[1]==='*' ? [min,max] : match[1]!.split('-').map(Number);
    const start = range[0]!, end = range[1] ?? (match[2] ? max : start);
    requireCondition(step>=1 && step<=max-min+1 && start>=min && end<=max && end>=start,400,'invalid_schedule','Cron range or step is out of bounds.');
    for (let n=start;n<=end;n+=step) values.add(n);
  }
  return {values,wildcard:text.startsWith('*')};
}

/** UTC default; POSIX day fields use OR when both are restricted. Scan real minutes so DST is honoured. */
export function nextCronRun(schedule:string,after:Date):Date {
  const parts = schedule.trim().split(/\s+/);
  const tz = parts[0]?.startsWith('CRON_TZ=') ? parts.shift()!.slice(8) : 'UTC';
  requireCondition(parts.length===5 && Number.isFinite(after.getTime()),400,'invalid_schedule','Expected five cron fields.');
  const fields = parts.map((s,i) => cronField(s,[0,0,1,1,0][i]!,[59,23,31,12,7][i]!));
  if (fields[4]!.values.has(7)) fields[4]!.values.add(0);
  let fmt:Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat('en-US',{timeZone:tz,minute:'numeric',hour:'numeric',hourCycle:'h23',day:'numeric',month:'numeric',weekday:'short'}); }
  catch { requireCondition(false,400,'invalid_schedule','Unknown CRON_TZ time zone.'); }
  const local = (t:number) => Object.fromEntries(fmt!.formatToParts(new Date(t)).map(p => [p.type,p.value]));
  const wall = (p:Record<string,string>) => `${p.month}/${p.day} ${p.hour}:${p.minute}`;
  // A wall-clock time that repeats when clocks go back fires once, as in Vixie cron.
  const afterWall = wall(local(after.getTime()));
  // ponytail: eight-year ceiling covers leap days. Jump a whole day or hour when it cannot match, so a
  // never-matching schedule costs a few thousand date conversions, not four million.
  const start = Math.floor(after.getTime()/60000)*60000+60000;
  for (let t=start;t<start+8*366*86400000;) {
    const p = local(t), hour = Number(p.hour), minute = Number(p.minute);
    const dom = fields[2]!.values.has(Number(p.day)), dow = fields[4]!.values.has(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday!));
    const dayOk = fields[3]!.values.has(Number(p.month)) && (fields[2]!.wildcard || fields[4]!.wildcard ? dom && dow : dom || dow);
    if (!dayOk) { t += ((23-hour)*60 + (60-minute))*60000; continue; }
    if (!fields[1]!.values.has(hour)) { t += (60-minute)*60000; continue; }
    if (fields[0]!.values.has(minute) && wall(p) !== afterWall) return new Date(t);
    t += 60000;
  }
  requireCondition(false,400,'invalid_schedule','Cron has no occurrence in the next eight years.');
  throw new Error('unreachable');
}

/** Describe only simple, unambiguous cron patterns; preserve everything else verbatim. */
export function describeSchedule(expression:string):string {
  const [minute,hour,day,month,weekday] = expression.split(/\s+/);
  if (day!=='*' || month!=='*') return expression;
  if (weekday==='*' && hour==='*' && (minute==='*' || /^\*\/\d+$/.test(minute!))) {
    const n = minute==='*' ? 1 : Number(minute!.slice(2));
    if (60 % n === 0) return n===1 ? 'Every minute' : `Every ${n} minutes`;
  }
  if (weekday==='*' && minute==='0' && (hour==='*' || /^\*\/\d+$/.test(hour!))) {
    const n = hour==='*' ? 1 : Number(hour!.slice(2));
    if (24 % n === 0) return n===1 ? 'Every hour' : `Every ${n} hours`;
  }
  if (!/^\d+$/.test(minute!) || !/^\d+$/.test(hour!)) return expression;
  const at = `${hour!.padStart(2,'0')}:${minute!.padStart(2,'0')}`;
  if (weekday==='*') return `Daily at ${at}`;
  if (weekday==='1-5') return `Weekdays at ${at}`;
  if (/^[0-7]$/.test(weekday!)) return `Weekly on ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][Number(weekday)%7]} at ${at}`;
  return expression;
}

export function scheduleCard(schedule:string|null, paused:boolean, now:Date) {
  const parts = schedule?.trim().split(/\s+/) ?? [];
  const timezone = parts[0]?.startsWith('CRON_TZ=') ? parts.shift()!.slice(8) : 'UTC';
  const cron = schedule ? parts.join(' ') : null;
  const next_runs:string[] = [];
  if (schedule && !paused) {
    let next = now;
    for (let i=0;i<3;i++) { next=nextCronRun(schedule,next); next_runs.push(next.toISOString()); }
  }
  return {cron,description:cron ? describeSchedule(cron) : 'Schedule cleared',timezone,next_runs,paused};
}

/** Caller holds teamsLock. Preserve the card's id and seq for message.updated consumers. */
export async function syncScheduleCard(db:Db,p:Principal,bot:{id:string;scope:string;thread_id:string;schedule:string|null;rules:Record<string,unknown>},now:Date):Promise<void> {
  const card = scheduleCard(bot.schedule,bot.rules.schedule_paused===true,now);
  const ref = JSON.stringify({bot_id:bot.id,...card});
  const body = `${card.description} · ${card.timezone}${card.paused ? ' · Paused' : ''}`;
  const previous = (await db.query<{id:string;seq:string}>(
    `SELECT id,seq FROM messages WHERE tenant_id=$1 AND thread_id=$2 AND kind='schedule' AND ref->>'bot_id'=$3`,
    [p.tenantId,bot.thread_id,bot.id])).rows[0];
  const id = previous?.id ?? newId();
  const seq = previous?.seq ?? await assignThreadSeq(db,p.tenantId,bot.thread_id);
  if (previous) await db.query('UPDATE messages SET body=$3,ref=$4::jsonb,edited_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2',[id,p.tenantId,body,ref]);
  else await db.query(`INSERT INTO messages(id,tenant_id,scope,thread_id,seq,author,kind,body,ref)
    VALUES($1,$2,$3,$4,$5,'{"kind":"system","id":"service"}','schedule',$6,$7::jsonb)`,[id,p.tenantId,bot.scope,bot.thread_id,seq,body,ref]);
  await event(db,p,bot.scope,previous ? 'message.updated' : 'message.created',id,{thread_id:bot.thread_id,message_id:id,seq:Number(seq),kind:'schedule'});
}

/** One bounded sweep; locks are ordered scope, Teams, then rows just like task claims. */
export async function tickBotSchedules(pool:Pool):Promise<void> {
  const bots = (await pool.query<BotRoutingRow>(`SELECT * FROM bots WHERE NOT archived AND schedule IS NOT NULL AND rules->>'schedule_paused' IS DISTINCT FROM 'true' AND (next_run_at IS NULL OR next_run_at<=clock_timestamp()) ORDER BY next_run_at NULLS FIRST,id LIMIT 100`)).rows;
  for (const candidate of bots) {
    try { await fireSchedule(pool,candidate); }
    catch (err) {
      if (!(err instanceof AppError) || err.code !== 'invalid_schedule') throw err;
      // One bad schedule must not stop the sweep: park it ('infinity' is never due) and say why in its thread.
      await transaction(pool,async db => {
        const p:Principal = {id:candidate.created_by,tenantId:candidate.tenant_id,name:'bot-scheduler',role:'admin',scopes:[candidate.scope],permissions:[]};
        await teamsLock(db,p.tenantId);
        await db.query(`UPDATE bots SET next_run_at='infinity',updated_at=clock_timestamp() WHERE id=$1`,[candidate.id]);
        await notice(db,p,candidate,`Schedule paused: ${err.message} Fix it in Bot settings.`);
      });
    }
  }
}

async function fireSchedule(pool:Pool,candidate:BotRoutingRow):Promise<void> {
  await transaction(pool,async db => {
    const p:Principal = {id:candidate.created_by,tenantId:candidate.tenant_id,name:'bot-scheduler',role:'admin',scopes:[candidate.scope],permissions:[]};
    await scopeLock(db,'tasks',p,candidate.scope);
    await teamsLock(db,p.tenantId);
    const bot = (await db.query<BotRoutingRow>(`SELECT * FROM bots WHERE id=$1 AND NOT archived AND schedule IS NOT NULL AND rules->>'schedule_paused' IS DISTINCT FROM 'true' AND (next_run_at IS NULL OR next_run_at<=clock_timestamp()) FOR UPDATE`,[candidate.id])).rows[0];
    if (!bot) return;
    const now = (await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const next = nextCronRun(bot.schedule!,now);
    await db.query('UPDATE bots SET next_run_at=$2,updated_at=clock_timestamp() WHERE id=$1',[bot.id,next]);
    await syncScheduleCard(db,p,bot,now);
    if (!bot.next_run_at) return;
    const agent = (await db.query<{id:string;edits:boolean;archived:boolean}>('SELECT id,edits,archived FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3',[bot.lead_agent_id,p.tenantId,bot.scope])).rows[0];
    if (!agent || agent.archived || (await db.query(`SELECT 1 FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND kind='turn' AND status IN ('queued','running')`,[p.tenantId,agent.id])).rowCount) return;
    await notice(db,p,bot,'Scheduled run');
    const key = `bot-schedule:${bot.id}:${bot.next_run_at.toISOString()}`;
    const task = (await db.query<TaskRow>(`INSERT INTO tasks(id,tenant_id,scope,kind,objective,agent_id,thread_id,bot_id,initiator_kind,required_capability,resource_key,permission_envelope,created_by,idempotency_key,request_hash,status)
      VALUES($1,$2,$3,'turn',$4,$5,$6,$7,'schedule',$8,$9,$10,$11,$12,$13,'queued') RETURNING *`,[newId(),p.tenantId,bot.scope,clipUtf8(`Scheduled run: ${bot.job}`,16000),agent.id,bot.thread_id,bot.id,runnerCapability((bot.routing[agent.edits ? 'patch' : 'summary'] ?? {mode:'auto'}) as RunnerConfig,agent.edits),`agent:${agent.id}`,JSON.stringify({read_project:true,local_patch:agent.edits,deploy:false,publish:false,purchase:false,send_messages:false,permission_changes:false,external_side_effects:false}),bot.created_by,key,sha256(key)])).rows[0]!;
    await taskChanged(db,p,task,'submitted',false);
  });
}
