import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { requirePermission, requireScope } from '../policy.js';
import type { Principal } from '../types.js';
import { integer, object, string, uuid } from '../validation.js';
import { audit, event, newId, noExtraKeys, teamsLock } from './shared.js';
import { redactSecrets } from '../safety/redact.js';
import { assignThreadSeq, clipUtf8, enqueueAgentTurn, type AgentRow } from './teams.js';

const CHUNK = 131072, MAX = 20 * 1024 * 1024;
const digest = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
// lock=false for calls that wait on RetireOdds: a thread row lock would block thread_post for up to 15 s.
async function authorize(db: PoolClient, p: Principal, thread: string, write: boolean, lock = true): Promise<string> {
  requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use watch host services.');
  requirePermission(p, 'thread:read'); if (write) requirePermission(p, 'thread:write');
  const row = (await db.query(`SELECT scope FROM threads WHERE id=$1 AND tenant_id=$2${lock ? ' FOR UPDATE' : ''}`, [thread,p.tenantId])).rows[0];
  requireCondition(row, 404, 'thread_not_found', 'Thread not found.'); requireScope(p,row.scope); return row.scope;
}
function root(): string {
  const dir = process.env.SWARMAA_MEMO_DIR || path.join(homedir(), '.swarmaa', 'memos');
  requireCondition(path.isAbsolute(dir), 503, 'memo_config_invalid', 'Memo directory must be absolute.'); return path.resolve(dir);
}
async function safeDir(dir: string): Promise<void> {
  const parsed = path.parse(dir); let current = parsed.root;
  for (const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    try { await mkdir(current, {mode:0o700}); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    const st = await lstat(current);
    requireCondition(st.isDirectory() && !st.isSymbolicLink(), 503, 'memo_path_unsafe', 'Memo directory is unsafe.');
    if (current === root() || current.startsWith(root() + path.sep)) requireCondition(st.uid === process.getuid?.() && (st.mode & 0o077) === 0,503,'memo_path_unsafe','Memo directory must be owner-only.');
  }
}
function memoPath(p:Principal, thread:string, memo:string): string {
  const tenant = digest(p.tenantId);
  return path.join(root(),tenant,thread.toLowerCase(),`${memo.toLowerCase()}.m4a`);
}
async function durableSave(filename:string, data:Buffer): Promise<void> {
  const dir = path.dirname(filename); await safeDir(dir);
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary,filename);
    const d = await open(dir,constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
  } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
}
async function storedFileValid(filename:string, length:number, sha:string):Promise<boolean> {
  await safeDir(path.dirname(filename));
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e:any) { if (e.code === 'ENOENT' || e.code === 'ELOOP') return false; throw e; }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size !== length || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return false;
    const data = Buffer.alloc(length + 1); let offset = 0;
    while (offset < data.length) { const read = await file.read(data,offset,data.length-offset,offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    return offset === length && digest(data.subarray(0,length)) === sha;
  } finally { await file.close(); }
}
function response(row:any, indices?:number[]): unknown {
  return {memo_id:row.memo_id,sha256:row.sha256,byte_length:row.byte_length,status:row.status,...(row.status === 'stored' ? {stored_on:'mac'} : {}),...(indices ? {received_indices:indices} : {})};
}
export class WatchServices {
  constructor(private pool:Pool) {}
  async memo(p:Principal, action:'put'|'status'|'delete', input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input, action === 'put' ? ['memo_id','thread_id','sha256','byte_length','captured_at','index','data_base64','transcript'] : ['memo_id','thread_id']);
    const thread = uuid(input.thread_id,'thread_id').toLowerCase(), memo = uuid(input.memo_id,'memo_id').toLowerCase();
    requireCondition(process.platform === 'darwin',503,'memo_host_invalid','Memo storage requires the service to run on a Mac.');
    const filename = memoPath(p,thread,memo);
    let parsed: {sha:string,length:number,captured:string,index:number,data:Buffer,transcript:string} | undefined;
    if (action === 'put') {
      const sha = string(input.sha256,'sha256',64); requireCondition(/^[0-9a-f]{64}$/.test(sha),400,'invalid_arguments','Invalid SHA-256.');
      const length = integer(input.byte_length,'byte_length',1,MAX), index = integer(input.index,'index',0,Math.ceil(length/CHUNK)-1);
      const captured = string(input.captured_at,'captured_at',40); requireCondition(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(captured) && Number.isFinite(Date.parse(captured)),400,'invalid_arguments','Invalid captured_at.');
      const encoded = string(input.data_base64,'data_base64',Math.ceil(CHUNK/3)*4), data = Buffer.from(encoded,'base64');
      requireCondition(data.toString('base64') === encoded && data.length === Math.min(CHUNK,length-index*CHUNK),400,'invalid_arguments','Invalid canonical chunk.');
      const transcript = input.transcript === undefined ? '' : string(input.transcript,'transcript',16384);
      requireCondition(Buffer.byteLength(transcript,'utf8') <= 16384,400,'invalid_arguments','transcript exceeds 16 KB.');
      parsed = {sha,length,captured:new Date(captured).toISOString(),index,data,transcript};
    }
    const result = await transaction(this.pool,async db => {
      const scope = await authorize(db,p,thread,true);
      let row = (await db.query('SELECT * FROM watch_memos WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3 FOR UPDATE',[p.tenantId,thread,memo])).rows[0];
      if (!row && parsed) {
        const count = Number((await db.query('SELECT count(*) AS n FROM watch_memos WHERE tenant_id=$1 AND thread_id=$2',[p.tenantId,thread])).rows[0].n);
        requireCondition(count < 20,409,'memo_limit','Thread memo limit reached.');
        row = (await db.query('INSERT INTO watch_memos (tenant_id,scope,thread_id,memo_id,sha256,byte_length,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[p.tenantId,scope,thread,memo,parsed.sha,parsed.length,parsed.captured])).rows[0];
      }
      requireCondition(row,404,'memo_not_found','Memo not found.');
      if (action === 'delete') {
        await safeDir(path.dirname(filename));
        await unlink(filename).catch((e:any) => { if (e.code !== 'ENOENT') throw e; });
        await db.query('DELETE FROM watch_memos WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3',[p.tenantId,thread,memo]); return {deleted:true};
      }
      if (parsed) {
        requireCondition(row.scope === scope && row.sha256 === parsed.sha && row.byte_length === parsed.length && new Date(row.captured_at).toISOString() === parsed.captured,409,'memo_conflict','Memo metadata conflicts.');
        const old = (await db.query('SELECT data FROM watch_memo_chunks WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3 AND chunk_index=$4',[p.tenantId,thread,memo,parsed.index])).rows[0];
        requireCondition(!old || old.data.equals(parsed.data),409,'memo_conflict','Memo chunk conflicts.');
        if (parsed.transcript && !row.transcript) { await db.query('UPDATE watch_memos SET transcript=$4 WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3',[p.tenantId,thread,memo,parsed.transcript]); row.transcript = parsed.transcript; }
        if (!old) await db.query('INSERT INTO watch_memo_chunks VALUES ($1,$2,$3,$4,$5)',[p.tenantId,thread,memo,parsed.index,parsed.data]);
      }
      if (action === 'status' && row.status === 'stored' && !await storedFileValid(filename,row.byte_length,row.sha256)) {
        await db.query("UPDATE watch_memos SET status='uploading' WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3",[p.tenantId,thread,memo]);
        row.status = 'uploading';
        return response(row,[]);
      }
      const chunks = (await db.query('SELECT chunk_index,data FROM watch_memo_chunks WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3 ORDER BY chunk_index',[p.tenantId,thread,memo])).rows;
      if (parsed && chunks.length === Math.ceil(row.byte_length/CHUNK)) {
        const data = Buffer.concat(chunks.map(c => c.data));
        requireCondition(data.length === row.byte_length && digest(data) === row.sha256 && data.length >= 12 && data.toString('ascii',4,8) === 'ftyp' && /^(M4A |M4B |isom|mp4[12])$/.test(data.toString('ascii',8,12)),400,'memo_invalid','Memo failed integrity or M4A validation.');
        await durableSave(filename,data);
        await durableSave(filename.replace(/\.m4a$/,'.txt'),Buffer.from(row.transcript,'utf8')).catch(() => {}); // best effort; the DB keeps the transcript
        await db.query("UPDATE watch_memos SET status='stored' WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3",[p.tenantId,thread,memo]); row.status = 'stored';
      }
      return response(row,action === 'status' ? (row.status === 'uploading' && chunks.length === Math.ceil(row.byte_length / CHUNK) ? [] : chunks.map(c => c.chunk_index)) : undefined);
    });
    if ((result as any).status === 'stored' && action !== 'delete') await this.announce(p,thread,memo);
    return result;
  }
  // Posts the memo into its thread and queues the bot turn, exactly once: the `announced` claim is taken under the thread lock.
  private async announce(p:Principal, threadId:string, memo:string):Promise<void> {
    await transaction(this.pool,async db => {
      await teamsLock(db,p.tenantId);
      const thread = (await db.query('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[threadId,p.tenantId])).rows[0];
      if (!thread) return;
      const row = (await db.query('UPDATE watch_memos SET announced=true WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3 AND status=\'stored\' AND NOT announced RETURNING transcript,byte_length,captured_at',[p.tenantId,threadId,memo])).rows[0];
      if (!row) return;
      const transcript = String(row.transcript).trim();
      const body = clipUtf8(redactSecrets(`🎙 Voice memo\n\n${transcript || '(no transcript)'}`),16384);
      const ref = {voice_memo:{memo_id:memo,byte_length:row.byte_length,captured_at:new Date(row.captured_at).toISOString()}};
      const seq = await assignThreadSeq(db,p.tenantId,threadId), msgId = newId(), author = {kind:'human',id:p.id};
      await db.query(`INSERT INTO messages (id,tenant_id,scope,thread_id,seq,author,kind,body,ref,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'text',$7,$8::jsonb,$9)`,[msgId,p.tenantId,thread.scope,threadId,seq,JSON.stringify(author),body,JSON.stringify(ref),`voice-memo:${memo}`]);
      await db.query('UPDATE threads SET updated_at=clock_timestamp() WHERE id=$1',[threadId]);
      await audit(db,p,thread.scope,'message.create',msgId,{thread_id:threadId,seq:Number(seq)});
      await event(db,p,thread.scope,'message.created',msgId,{thread_id:threadId,message_id:msgId,seq:Number(seq),kind:'text',author});
      const bot = thread.kind === 'bot' ? (await db.query('SELECT id,routing,rules,lead_agent_id FROM bots WHERE thread_id=$1 AND tenant_id=$2 AND NOT archived',[threadId,p.tenantId])).rows[0] : undefined;
      const agent = bot && (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE',[bot.lead_agent_id])).rows[0];
      if (bot && agent) await enqueueAgentTurn(db,p,{thread,agent,bot,seq,initiatorKind:'person',objective:MEMO_OBJECTIVE});
    });
  }
}
const MEMO_OBJECTIVE = 'The user just sent a voice memo (see the latest "Voice memo" message). Summarize it, list the action items, then ask the user with a structured question (question_ask) with options "Do it now", "Remind me later", "Done" so it shows as Needs you.';

function transactionConfig(p:Principal): {origin:string,user:string,cookieFile:string} {
  const allowed = (process.env.SWARMAA_RETIREODDS_PRINCIPALS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  requireCondition(allowed.includes(p.id.toLowerCase()),403,'retireodds_forbidden','This principal is not enabled for RetireOdds.');
  const origin = process.env.SWARMAA_RETIREODDS_ORIGIN, user = process.env.SWARMAA_RETIREODDS_USER_ID, cookieFile = process.env.SWARMAA_RETIREODDS_COOKIE_FILE;
  requireCondition(origin && user && cookieFile && path.isAbsolute(cookieFile),503,'retireodds_config_missing','RetireOdds host configuration is missing.');
  let url:URL; try { url = new URL(origin); } catch { throw new AppError(503,'retireodds_config_invalid','RetireOdds origin is invalid.'); }
  requireCondition((url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,503,'retireodds_config_invalid','RetireOdds origin is invalid.');
  return {origin:url.origin,user,cookieFile};
}
async function remote(config:ReturnType<typeof transactionConfig>, endpoint:string, body?:unknown):Promise<Record<string,unknown>> {
  const st = await lstat(config.cookieFile);
  requireCondition(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600 && st.uid === process.getuid?.(),503,'retireodds_config_invalid','RetireOdds credential file is unsafe.');
  const credential = await open(config.cookieFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let cookie:string;
  try { const actual = await credential.stat(); requireCondition(actual.isFile() && actual.uid === process.getuid?.() && (actual.mode & 0o777) === 0o600 && actual.size <= 8192,503,'retireodds_config_invalid','RetireOdds credential file is unsafe.'); cookie = (await credential.readFile('utf8')).trim(); } finally { await credential.close(); }
  requireCondition(cookie.length > 0 && cookie.length <= 8192 && !/[\r\n]/.test(cookie),503,'retireodds_config_invalid','RetireOdds credential file is invalid.');
  let res:Response;
  try { res = await fetch(config.origin + endpoint,{method:body === undefined ? 'GET':'POST',headers:{cookie,...(body === undefined ? {} : {'content-type':'application/json'})},body:body === undefined ? undefined : JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)}); }
  catch { throw new AppError(502,'retireodds_unavailable','RetireOdds request failed or timed out; retry only with the same identifiers.'); }
  requireCondition(res.ok,502,'retireodds_remote_error','RetireOdds rejected the request.');
  const reader = res.body?.getReader(); requireCondition(reader,502,'retireodds_response_invalid','RetireOdds response is invalid.');
  const pieces:Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; requireCondition(size <= 65536,502,'retireodds_response_invalid','RetireOdds response is too large.'); pieces.push(next.value); } }
  finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(pieces).toString('utf8'))); } catch { throw new AppError(502,'retireodds_response_invalid','RetireOdds response is invalid.'); }
}
function expense(value:unknown, idRequired:boolean):Record<string,unknown> {
  const v = object(value); noExtraKeys(v,['id','payee','date','amount','currency','category']);
  if (idRequired || v.id !== undefined) string(v.id,'id',200);
  string(v.payee,'payee',200); const date = string(v.date,'date',10); requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(date),400,'invalid_arguments','Invalid transaction date.');
  const amount = string(v.amount,'amount',32); requireCondition(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount),400,'invalid_arguments','Invalid transaction amount.');
  requireCondition(['THB','USD','EUR'].includes(String(v.currency)),400,'invalid_arguments','Invalid currency.'); string(v.category,'category',200); return v;
}
function review(value:Record<string,unknown>):Record<string,unknown> {
  try {
    noExtraKeys(value,['reviewId','reviewToken','expiresAt','accountId','operation','before','after','status','receipt']);
    string(value.reviewId,'reviewId',200); string(value.reviewToken,'reviewToken',4096); string(value.accountId,'accountId',200);
    requireCondition(Number.isFinite(Date.parse(string(value.expiresAt,'expiresAt',40))),400,'invalid_arguments','Invalid expiry.');
    requireCondition(value.operation === 'create' || value.operation === 'update',400,'invalid_arguments','Invalid operation.');
    requireCondition(value.status === 'pending' || value.status === 'confirmed',400,'invalid_arguments','Invalid status.');
    if (value.before !== null) expense(value.before,true); expense(value.after,false);
    if (value.status === 'confirmed') { const r = object(value.receipt); noExtraKeys(r,['id','reviewId','accountId','expense','confirmedAt','status']); uuid(r.id,'receipt id'); string(r.reviewId,'reviewId',200); string(r.accountId,'accountId',200); expense(r.expense,true); requireCondition(r.status === 'confirmed' && Number.isFinite(Date.parse(string(r.confirmedAt,'confirmedAt',40))) && r.reviewId === value.reviewId && r.accountId === value.accountId,400,'invalid_arguments','Invalid receipt.'); }
    else requireCondition(value.receipt === undefined || value.receipt === null,400,'invalid_arguments','Unexpected receipt.');
    return value;
  } catch { throw new AppError(502,'retireodds_response_invalid','RetireOdds response is invalid.'); }
}
export async function watchTransaction(pool:Pool,p:Principal,action:'preview'|'confirm'|'get',input:Record<string,unknown>):Promise<unknown> {
  noExtraKeys(input,action === 'preview' ? ['thread_id','request_id','operation','expense_id','values'] : action === 'confirm' ? ['thread_id','review_id','review_token','confirmation_id'] : ['thread_id','review_id']);
  const thread = uuid(input.thread_id,'thread_id').toLowerCase(), config = transactionConfig(p);
  // Persist the request binding before making an external call, including uncertain timeouts.
  if (action === 'preview') {
    const requestId = uuid(input.request_id,'request_id'), operation = input.operation;
    requireCondition(operation === 'create' || operation === 'update',400,'invalid_arguments','Invalid operation.');
    const values = expense(input.values,false); requireCondition(values.id === undefined,400,'invalid_arguments','Unexpected expense id.');
    const expenseId = input.expense_id === undefined ? undefined : string(input.expense_id,'expense_id',200);
    requireCondition(operation === 'update' ? !!expenseId : !expenseId,400,'invalid_arguments','Invalid expense id.');
    const payload = {requestId,expectedUserId:config.user,operation,...(expenseId ? {expenseId}:{}),values:{payee:values.payee,date:values.date,amount:values.amount,currency:values.currency,category:values.category}};
    await transaction(pool,async db => {
      const scope = await authorize(db,p,thread,true,false);
      await db.query('INSERT INTO watch_transaction_requests (tenant_id,scope,thread_id,principal_id,request_id,request_hash,origin,expected_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[p.tenantId,scope,thread,p.id,requestId,digest(JSON.stringify(payload)),config.origin,config.user]);
      const row = (await db.query('SELECT * FROM watch_transaction_requests WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 FOR UPDATE',[p.tenantId,p.id,requestId])).rows[0];
      requireCondition(row.thread_id === thread && row.scope === scope && row.request_hash === digest(JSON.stringify(payload)) && row.origin === config.origin && row.expected_user_id === config.user,409,'transaction_conflict','Transaction request conflicts.');
    });
  }
  // Pin the confirmation to the previewed token before the external call, so a timeout cannot be replayed
  // with another confirmation ID, a different token, or after the review expired.
  if (action === 'confirm') {
    const reviewId = string(input.review_id,'review_id',200), token = string(input.review_token,'review_token',4096);
    const confirmationId = uuid(input.confirmation_id,'confirmation_id').toLowerCase();
    await transaction(pool,async db => {
      const scope = await authorize(db,p,thread,true,false);
      const row = (await db.query('SELECT * FROM watch_transaction_requests WHERE tenant_id=$1 AND principal_id=$2 AND thread_id=$3 AND review_id=$4 FOR UPDATE',[p.tenantId,p.id,thread,reviewId])).rows[0];
      requireCondition(row && row.scope === scope,404,'review_not_found','Review not found.');
      requireCondition(row.review_token_sha256 === digest(token),409,'review_stale','Review token does not match the previewed review.');
      if (row.confirmation_id) { requireCondition(row.confirmation_id === confirmationId,409,'review_already_confirmed','This review already has a different confirmation.'); return; }
      requireCondition(new Date(row.review_expires_at).getTime() > Date.now(),409,'review_expired','Review expired; request a new preview.');
      await db.query('UPDATE watch_transaction_requests SET confirmation_id=$1 WHERE tenant_id=$2 AND principal_id=$3 AND request_id=$4',[confirmationId,p.tenantId,p.id,row.request_id]);
    });
  }
  return transaction(pool,async db => {
    const scope = await authorize(db,p,thread,true,false);
    if (action === 'preview') {
      const requestId = uuid(input.request_id,'request_id'), operation = input.operation;
      requireCondition(operation === 'create' || operation === 'update',400,'invalid_arguments','Invalid operation.');
      const values = expense(input.values,false); requireCondition(values.id === undefined,400,'invalid_arguments','Unexpected expense id.');
      const expenseId = input.expense_id === undefined ? undefined : string(input.expense_id,'expense_id',200);
      requireCondition(operation === 'update' ? !!expenseId : !expenseId,400,'invalid_arguments','Invalid expense id.');
      const payload = {requestId,expectedUserId:config.user,operation,...(expenseId ? {expenseId}:{}),values:{payee:values.payee,date:values.date,amount:values.amount,currency:values.currency,category:values.category}};
      const hash = digest(JSON.stringify(payload));
      await db.query('INSERT INTO watch_transaction_requests (tenant_id,scope,thread_id,principal_id,request_id,request_hash,origin,expected_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[p.tenantId,scope,thread,p.id,requestId,hash,config.origin,config.user]);
      const row = (await db.query('SELECT * FROM watch_transaction_requests WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 FOR UPDATE',[p.tenantId,p.id,requestId])).rows[0];
      requireCondition(row.thread_id === thread && row.scope === scope && row.request_hash === hash && row.origin === config.origin && row.expected_user_id === config.user,409,'transaction_conflict','Transaction request conflicts.');
      const result = review(await remote(config,'/api/integrations/swarmaa/transactions/preview',payload));
      const after = object(result.after);
      const cents = (amount:unknown):string => { const [whole, fraction = ''] = String(amount).split('.'); return `${whole}.${fraction.padEnd(2,'0')}`; };
      const before = result.before === null ? null : object(result.before);
      requireCondition(result.accountId === config.user && (!row.review_id || row.review_id === result.reviewId) && (!row.review_token_sha256 || row.review_token_sha256 === digest(String(result.reviewToken))) && (!row.account_id || row.account_id === result.accountId) && result.operation === operation &&
        after.payee === String(values.payee).trim() && after.date === values.date && cents(after.amount) === cents(values.amount) && after.currency === values.currency && after.category === values.category &&
        (operation === 'create' ? before === null : before !== null && before.id === expenseId && (after.id === undefined || after.id === expenseId)),502,'retireodds_response_invalid','RetireOdds review does not match the request.');
      await db.query('UPDATE watch_transaction_requests SET review_id=$1,account_id=$2,review_token_sha256=$6,review_expires_at=$7 WHERE tenant_id=$3 AND principal_id=$4 AND request_id=$5',[result.reviewId,result.accountId,p.tenantId,p.id,requestId,digest(String(result.reviewToken)),new Date(String(result.expiresAt))]); return result;
    }
    const reviewId = string(input.review_id,'review_id',200);
    const row = (await db.query('SELECT * FROM watch_transaction_requests WHERE tenant_id=$1 AND principal_id=$2 AND thread_id=$3 AND review_id=$4 FOR UPDATE',[p.tenantId,p.id,thread,reviewId])).rows[0];
    requireCondition(row && row.scope === scope,404,'review_not_found','Review not found.');
    requireCondition(row.origin === config.origin && row.expected_user_id === config.user,409,'transaction_config_changed','RetireOdds configuration changed.');
    let endpoint = '/api/integrations/swarmaa/transactions/'; let body:unknown;
    if (action === 'confirm') { const confirmationId = uuid(input.confirmation_id,'confirmation_id'); const reviewToken = string(input.review_token,'review_token',4096); endpoint += 'confirm'; body = {expectedUserId:config.user,reviewId,reviewToken,confirmationId}; }
    else endpoint += `${encodeURIComponent(reviewId)}?expectedUserId=${encodeURIComponent(config.user)}`;
    const result = review(await remote(config,endpoint,body));
    requireCondition(result.reviewId === reviewId && result.accountId === row.account_id,502,'retireodds_response_invalid','RetireOdds review binding changed.');
    if (action === 'confirm') { const receipt = object(result.receipt); requireCondition(result.status === 'confirmed' && String(receipt.id).toLowerCase() === String(input.confirmation_id).toLowerCase(),502,'retireodds_response_invalid','RetireOdds receipt does not match confirmation.'); }
    return result;
  });
}
