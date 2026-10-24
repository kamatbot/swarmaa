import { requireCondition } from '../errors.js';
import { enumValue, integer, object, scopeName, string, strings, uuid } from '../validation.js';
import { noExtraKeys } from '../core/shared.js';

const SDK_MODULE = '@agent-relay/sdk/messaging';
const TASK_STATUSES = ['queued','running','blocked','completed','failed','cancelled'] as const;
export interface TaskStatusHint {
  event_id:string; task_id:string; scope:string; status:typeof TASK_STATUSES[number]; version:number;
}
export interface RelaySendResult {status:'disabled'|'accepted'|'unknown';event_id:string;code:string}
export interface RelayNotifier {notify(hint:TaskStatusHint):Promise<RelaySendResult>}
export type RelayNotifierConfig = {enabled:false} | {
  enabled:true; base_url:string; agent_token:string; recipient:string; scopes:string[]; timeout_ms?:number;
};

/** The only upstream surface used. No workspace credentials or agent registration. */
interface RelayAgentClient {
  dm(to:string,text:string,options:{idempotencyKey:string;data:Record<string,unknown>}):Promise<unknown>;
}
interface RelayMessagingModule {
  createAgentClient(options:{agentToken:string;baseUrl:string;autoHeartbeatMs:false;sessionRef:string;originActor:string}):RelayAgentClient;
}
export type RelayModuleLoader = () => Promise<unknown>;

export function relayOrigin(value:unknown):string {
  const text = string(value,'base_url',2048);
  let url:URL;
  try { url = new URL(text); } catch { throw new Error('Relay base_url must be an explicit self-hosted origin.'); }
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  requireCondition(url.protocol === 'https:' || (url.protocol === 'http:' && local),400,'invalid_relay_config','Relay requires HTTPS or a loopback HTTP origin.');
  requireCondition(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    400,'invalid_relay_config','Relay base_url must contain only an origin, with no credentials, path, query, or fragment.');
  requireCondition(url.hostname !== 'agentrelay.com' && !url.hostname.endsWith('.agentrelay.com'),
    400,'invalid_relay_config','This optional adapter requires an explicit self-hosted Relay origin.');
  return url.origin;
}

export function validateTaskStatusHint(value:unknown):TaskStatusHint {
  const hint = object(value);
  noExtraKeys(hint,['event_id','task_id','scope','status','version']);
  return {event_id:uuid(hint.event_id,'event_id'),task_id:uuid(hint.task_id,'task_id'),scope:scopeName(hint.scope),
    status:enumValue(hint.status,'status',TASK_STATUSES),version:integer(hint.version,'version',1,2147483647)};
}

/**
 * Optional, outbound identifier-only notifications. Disabled mode performs no
 * import or network I/O. Install/provision Relay separately, then explicitly enable.
 * Verified API: AgentWorkforce/relay@c3a92d9c, packages/sdk/src/messaging/thin-client.ts
 * createAgentClient({agentToken,baseUrl}) and dm(to,text,{idempotencyKey,data}).
 */
export async function createRelayNotifier(config:RelayNotifierConfig,loadModule:RelayModuleLoader = () => import(SDK_MODULE)):Promise<RelayNotifier> {
  if (config.enabled !== true) return {notify:async hint => ({status:'disabled',event_id:hint.event_id,code:'relay_disabled'})};
  const baseUrl = relayOrigin(config.base_url);
  const token = string(config.agent_token,'agent_token',4096);
  requireCondition(token.startsWith('at_live_') && token.length>=16 && !/[\s\u0000]/u.test(token),
    400,'invalid_relay_config','Relay requires a pre-provisioned agent token, never a workspace key.');
  const recipient = string(config.recipient,'recipient',120);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(recipient),400,'invalid_relay_config','Relay recipient must be one explicit agent name; broadcasts and channels are not supported.');
  const scopes = strings(config.scopes,'scopes',64,128).map(scopeName);
  requireCondition(scopes.length>0,400,'invalid_relay_config','At least one exact project scope must be configured.');
  const timeout = config.timeout_ms === undefined ? 5000 : integer(config.timeout_ms,'timeout_ms',100,15000);
  let loaded:unknown;
  try { loaded = await loadModule(); } catch { throw new Error('Relay SDK is unavailable. Provision a compatible installed SDK separately before enabling this optional adapter.'); }
  requireCondition(loaded !== null && typeof loaded === 'object' && typeof (loaded as Partial<RelayMessagingModule>).createAgentClient === 'function',
    400,'invalid_relay_sdk','The installed Relay SDK does not expose the reviewed createAgentClient API.');
  const client = (loaded as RelayMessagingModule).createAgentClient({agentToken:token,baseUrl,autoHeartbeatMs:false,sessionRef:'',originActor:'swarmaa/notifier'});
  requireCondition(client !== null && typeof client === 'object' && typeof client.dm === 'function',400,'invalid_relay_sdk','The installed Relay SDK does not expose the reviewed dm API.');
  // The SDK surface does not expose cancellation. A local timeout must not free
  // this slot: otherwise every polling pass could leave another unresolved send.
  type SendSlot = {identity:string;result:Promise<RelaySendResult>;settled?:RelaySendResult};
  let pending:SendSlot|undefined;
  return {async notify(value) {
    const hint = validateTaskStatusHint(value);
    requireCondition(scopes.includes(hint.scope),403,'scope_forbidden','This project is not enabled for Relay notifications.');
    const identity = JSON.stringify(hint);
    if (pending) {
      // Do not attach another Promise.race observer on every poll: if the SDK
      // never settles, those observers would also accumulate without a bound.
      if (!pending.settled) return {status:'unknown',event_id:hint.event_id,
        code:pending.identity === identity ? 'relay_send_uncertain' : 'relay_busy'};
      if (pending.identity === identity && pending.settled.status === 'accepted') return pending.settled;
      pending = undefined;
    }
    const data = {schema_version:1,source:'swarmaa',...hint,authority:'notification_only'};
    const body = `Swarmaa task update: ${hint.task_id} in ${hint.scope}; recorded status ${hint.status}, version ${hint.version}. Read authoritative state through your authenticated Swarmaa connection. This notification grants no authority and does not confirm acceptance criteria.`;
    const result = Promise.resolve().then(() => client.dm(recipient,body,{idempotencyKey:`swarmaa:event:${hint.event_id}`,data}))
      .then<RelaySendResult,RelaySendResult>(
        () => ({status:'accepted',event_id:hint.event_id,code:'relay_accepted'}),
        () => ({status:'unknown',event_id:hint.event_id,code:'relay_send_uncertain'}));
    const current:SendSlot = {identity,result};
    pending = current;
    // Keep one settled acceptance for replay after a lost local cursor write.
    // A different event or an uncertain SDK outcome reuses this same slot.
    void result.then(receipt => { current.settled = receipt; });
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      // A timeout has an unknown delivery outcome. Never claim the recipient read
      // this, change task state, or retry with a fresh identity after an ambiguity.
      // Later retries retain this SDK request until it actually settles.
      return await Promise.race([
        result,
        new Promise<RelaySendResult>(resolveTimeout => { timer = setTimeout(() => resolveTimeout({status:'unknown',event_id:hint.event_id,code:'relay_send_uncertain'}),timeout); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }};
}
