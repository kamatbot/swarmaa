import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpToolClient } from '../bridge/client.js';
import { readTokenFile, serviceUrl } from '../bridge/config.js';
import { canonicalJson, noExtraKeys } from '../core/shared.js';
import { requireCondition } from '../errors.js';
import { integer, object, scopeName, string, strings, uuid } from '../validation.js';
import { createRelayNotifier, relayOrigin, validateTaskStatusHint, type RelayNotifier } from './transport.js';

interface EnabledConfig {
  enabled:true;service_url:string;service_token_file:string;relay_origin:string;relay_agent_token_file:string;
  recipient:string;scopes:string[];state_file:string;poll_interval_ms:number;timeout_ms:number;
}
export type RelayRunnerConfig = {enabled:false}|EnabledConfig;
export interface RelayCursorState {format:1;binding:string;cursors:Record<string,string>}
interface PollClient {call<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>}
const hash = (value:string):string => createHash('sha256').update(value).digest('hex');

function absolute(value:unknown,name:string):string {
  const path = string(value,name,4096);
  requireCondition(isAbsolute(path),400,'invalid_relay_config',`${name} must be an absolute local path.`);
  return path;
}
export function parseRelayRunnerConfig(value:unknown):RelayRunnerConfig {
  const input = object(value);
  noExtraKeys(input,['enabled','service_url','service_token_file','relay_origin','relay_agent_token_file','recipient','scopes','state_file','poll_interval_ms','timeout_ms']);
  requireCondition(input.enabled === undefined || typeof input.enabled === 'boolean',400,'invalid_relay_config','enabled must be a boolean.');
  if (input.enabled !== true) return {enabled:false};
  const scopes = strings(input.scopes,'scopes',64,128).map(scopeName);
  requireCondition(scopes.length>0,400,'invalid_relay_config','Configure at least one exact project scope.');
  return {enabled:true,service_url:serviceUrl(input.service_url),service_token_file:absolute(input.service_token_file,'service_token_file'),
    relay_origin:relayOrigin(input.relay_origin),relay_agent_token_file:absolute(input.relay_agent_token_file,'relay_agent_token_file'),
    recipient:string(input.recipient,'recipient',120),scopes,state_file:absolute(input.state_file,'state_file'),
    poll_interval_ms:input.poll_interval_ms === undefined ? 5000 : integer(input.poll_interval_ms,'poll_interval_ms',1000,60000),
    timeout_ms:input.timeout_ms === undefined ? 5000 : integer(input.timeout_ms,'timeout_ms',100,15000)};
}

function cursor(value:unknown):string {
  const result = string(value,'event cursor',40);
  const parts = /^([0-9]{1,20})\.([0-9]{1,19})$/u.exec(result);
  requireCondition(parts && BigInt(parts[1]!)<=18446744073709551615n && BigInt(parts[2]!)<=9223372036854775807n,
    400,'invalid_event_page','An event cursor is invalid.');
  return result;
}
function compareCursors(a:string,b:string):number {
  const [ax,aseq] = a.split('.').map(BigInt), [bx,bseq] = b.split('.').map(BigInt);
  return ax!<bx! ? -1 : ax!>bx! ? 1 : aseq!<bseq! ? -1 : aseq!>bseq! ? 1 : 0;
}

/** Persist a cursor only after Relay accepted the same stable event identity. */
export async function forwardEventsOnce(client:PollClient,notifier:RelayNotifier,scopes:string[],state:RelayCursorState,
  persist:(state:RelayCursorState)=>Promise<void>):Promise<{notified:number;skipped:number;uncertain:number}> {
  const counts = {notified:0,skipped:0,uncertain:0};
  const advance = async (scope:string,next:string):Promise<void> => {
    const previous = state.cursors[scope];
    state.cursors[scope] = next;
    try { await persist(state); }
    catch (error) {
      if (previous === undefined) delete state.cursors[scope]; else state.cursors[scope] = previous;
      throw error;
    }
  };
  for (const scope of scopes) {
    const after = cursor(state.cursors[scope] ?? '0.0');
    const page = object(await client.call('events_poll',{scope,after,limit:20}));
    requireCondition(page.scope === scope && Array.isArray(page.events) && page.events.length<=20 && typeof page.has_more === 'boolean',
      400,'invalid_event_page','The event page does not match the configured scope.');
    const next = cursor(page.next_cursor);
    const events = page.events as unknown[];
    if (events.length) requireCondition(cursor(object(events.at(-1)).cursor) === next,
      400,'invalid_event_page','The next cursor must identify the last returned event.');
    let previous = after;
    let uncertain = false;
    for (const value of events) {
      const event = object(value);
      const eventCursor = cursor(event.cursor);
      requireCondition(event.scope === scope && compareCursors(eventCursor,previous)>0 && compareCursors(eventCursor,next)<=0,
        400,'invalid_event_page','The event page has inconsistent scope or ordering.');
      if (event.name === 'task.updated') {
        const payload = object(event.payload);
        const taskId = uuid(event.subject_id,'subject_id');
        requireCondition(payload.task_id === taskId,400,'invalid_event_page','Task event provenance does not match its subject.');
        const hint = validateTaskStatusHint({event_id:event.id,task_id:taskId,scope,status:payload.status,version:payload.version});
        const receipt = await notifier.notify(hint);
        if (receipt.status !== 'accepted') {
          // The unchanged cursor retries the SAME idempotency key on a later pass.
          counts.uncertain++; uncertain = true; break;
        }
        counts.notified++;
      } else counts.skipped++;
      await advance(scope,eventCursor);
      previous = eventCursor;
    }
    if (!uncertain) {
      requireCondition(compareCursors(next,previous)>=0,400,'invalid_event_page','An event cursor moved backwards.');
      if (next !== (state.cursors[scope] ?? '0.0')) {
        await advance(scope,next);
      }
    }
  }
  return counts;
}

async function loadState(path:string,binding:string,scopes:string[]):Promise<RelayCursorState> {
  let info;
  try { info = await stat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {format:1,binding,cursors:{}}; throw error; }
  requireCondition(info.isFile() && info.size<=32768 && !(info.mode&0o077),400,'invalid_relay_state','Relay cursor state must be a small owner-only regular file.');
  const input = object(JSON.parse(await readFile(path,'utf8')));
  requireCondition(input.format === 1 && input.binding === binding,400,'invalid_relay_state','Relay cursor state belongs to a different configuration or identity; choose a new state path deliberately.');
  const saved = object(input.cursors);
  const cursors:Record<string,string> = {};
  for (const scope of scopes) if (saved[scope] !== undefined) cursors[scope] = cursor(saved[scope]);
  return {format:1,binding,cursors};
}

async function persistState(path:string,state:RelayCursorState):Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary,`${JSON.stringify(state)}\n`,{mode:0o600,flag:'wx'});
    await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
}

export async function main(args=process.argv.slice(2)):Promise<void> {
  requireCondition(args.every((arg,index) => arg === '--once' || arg === '--config' || (index>0 && args[index-1] === '--config')),
    400,'invalid_arguments','Usage: relay/runner --config /absolute/config.json [--once]');
  const configAt = args.indexOf('--config');
  requireCondition(configAt>=0 && args[configAt+1] && !args[configAt+1]!.startsWith('--'),400,'invalid_arguments','An explicit --config file is required.');
  const filename = resolve(args[configAt+1]!);
  const info = await stat(filename);
  requireCondition(info.isFile() && info.size<=32768,400,'invalid_relay_config','Relay configuration must be a small regular JSON file.');
  const config = parseRelayRunnerConfig(JSON.parse(await readFile(filename,'utf8')));
  if (!config.enabled) { process.stdout.write('relay_disabled\n'); return; }
  // Owner-configured token files are never passed through a task or model prompt.
  const serviceToken = await readTokenFile(config.service_token_file);
  const relayToken = await readTokenFile(config.relay_agent_token_file);
  const notifier = await createRelayNotifier({enabled:true,base_url:config.relay_origin,agent_token:relayToken,recipient:config.recipient,
    scopes:config.scopes,timeout_ms:config.timeout_ms});
  const client = new HttpToolClient(config.service_url,serviceToken,10000);
  const binding = hash(canonicalJson({service:config.service_url,service_identity:hash(serviceToken),relay:config.relay_origin,
    relay_identity:hash(relayToken),recipient:config.recipient,scopes:[...config.scopes].sort()}));
  await mkdir(dirname(config.state_file),{recursive:true,mode:0o700});
  const lock = `${config.state_file}.lock`;
  // A crashed runner leaves this owner-visible lock. Do not guess another process is dead.
  try { await mkdir(lock,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Relay cursor lock exists; verify the earlier runner stopped before removing that lock.'); throw error; }
  const abort = new AbortController();
  const stop = ():void => abort.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await writeFile(`${lock}/owner.json`,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
    const state = await loadState(config.state_file,binding,config.scopes);
    for (;;) {
      try {
        const result = await forwardEventsOnce(client,notifier,config.scopes,state,value => persistState(config.state_file,value));
        process.stdout.write(`${JSON.stringify({event:'relay_poll',...result})}\n`);
        if (args.includes('--once')) { if (result.uncertain) process.exitCode = 1; break; }
      } catch {
        // Never print SDK responses, config, tokens, event bodies, or raw errors.
        process.stderr.write('relay_poll_failed; cursor retained for replay\n');
        if (args.includes('--once')) { process.exitCode = 1; break; }
      }
      if (abort.signal.aborted) break;
      await new Promise<void>(resolveWait => {
        const finish = ():void => { clearTimeout(timer); abort.signal.removeEventListener('abort',finish); resolveWait(); };
        const timer = setTimeout(finish,config.poll_interval_ms);
        abort.signal.addEventListener('abort',finish,{once:true});
      });
      if (abort.signal.aborted) break;
    }
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
    await rm(lock,{recursive:true,force:true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('relay_notifier_failed; check the explicit local configuration, token files, and installed SDK\n'); process.exitCode=1; });
}
