/** Authored source; no live Relay account or SDK installation is used by these tests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRelayNotifier, relayOrigin, type RelayNotifier, type TaskStatusHint } from '../src/relay/transport.js';
import { forwardEventsOnce, parseRelayRunnerConfig, type RelayCursorState } from '../src/relay/runner.js';
import { sessionCoverage } from '../src/core/sessions.js';

const config = {enabled:true as const,base_url:'http://127.0.0.1:8788',agent_token:'at_live_test_only_not_a_real_token',recipient:'owner-terminal',scopes:['project:a'],timeout_ms:100};
const hint = ():TaskStatusHint => ({event_id:randomUUID(),task_id:randomUUID(),scope:'project:a',status:'completed',version:3});

test('Relay is disabled unless explicitly enabled and never imports a provider in disabled mode',async () => {
  assert.deepEqual(parseRelayRunnerConfig({}),{enabled:false});
  const notifier = await createRelayNotifier({enabled:false},async () => { throw new Error('must not import'); });
  assert.equal((await notifier.notify(hint())).status,'disabled');
});

test('Relay requires an explicit self-hosted origin and an agent credential',async () => {
  for (const origin of ['https://cast.agentrelay.com','https://agentrelay.com','https://user:secret@example.test',
    'https://relay.example.test/path','http://relay.example.test','https://relay.example.test?token=bad']) {
    assert.throws(() => relayOrigin(origin));
  }
  assert.equal(relayOrigin('https://relay.example.test/'),'https://relay.example.test');
  for (const override of [{agent_token:'rk_live_not_an_agent_token'},{recipient:'*'},{recipient:'#all'},{scopes:[]}]) {
    await assert.rejects(() => createRelayNotifier({...config,...override},async () => { throw new Error('must not import'); }));
  }
});

test('Relay sends only stable, scoped status hints and never asks the SDK to register an agent',async () => {
  const sent:Array<{to:string;body:string;options:Record<string,any>}> = [];
  let options:Record<string,any> = {};
  const notifier = await createRelayNotifier(config,async () => ({createAgentClient:(input:Record<string,any>) => {
    options = input;
    return {dm:async (to:string,body:string,write:Record<string,any>) => { sent.push({to,body,options:write}); return {id:'remote'}; }};
  }}));
  const event = hint();
  assert.equal((await notifier.notify(event)).status,'accepted');
  assert.equal((await notifier.notify(event)).status,'accepted');
  assert.equal(options.baseUrl,config.base_url);
  assert.equal(options.autoHeartbeatMs,false);
  assert.equal(options.sessionRef,'');
  assert.equal(sent[0]!.to,'owner-terminal');
  assert.equal(sent[0]!.options.idempotencyKey,`swarmaa:event:${event.event_id}`);
  assert.equal(sent.length,1,'An accepted identical event reuses the retained receipt.');
  assert.deepEqual(Object.keys(sent[0]!.options.data).sort(),['authority','event_id','schema_version','scope','source','status','task_id','version']);
  assert.ok(!JSON.stringify(sent).includes(config.agent_token));
  await assert.rejects(() => notifier.notify({...hint(),scope:'project:other'}));
  assert.equal(sent.length,1);
});

test('Relay treats rejection and lost responses as unknown rather than delivered or work failure',async () => {
  for (const dm of [async () => { throw new Error('untrusted diagnostic with a token'); },() => new Promise<never>(() => {})]) {
    const notifier = await createRelayNotifier(config,async () => ({createAgentClient:() => ({dm})}));
    const result = await notifier.notify(hint());
    assert.equal(result.status,'unknown');
    assert.equal(result.code,'relay_send_uncertain');
    assert.ok(!JSON.stringify(result).includes('untrusted diagnostic'));
  }
});

test('repeated timed-out polling reuses one unresolved SDK send and holds other events without advancing cursors',async () => {
  const sent:string[] = [], release:Array<() => void> = [];
  const notifier = await createRelayNotifier(config,async () => ({createAgentClient:() => ({
    dm:async (_to:string,_body:string,options:{idempotencyKey:string}) => {
      sent.push(options.idempotencyKey);
      await new Promise<void>(resolveSend => { release.push(resolveSend); });
    },
  })}));
  const first = hint(), second = hint();
  const state:RelayCursorState = {format:1,binding:'test',cursors:{}};
  const page = {scope:first.scope,events:[{id:first.event_id,cursor:'9.1',scope:first.scope,name:'task.updated',subject_id:first.task_id,
    payload:{task_id:first.task_id,status:first.status,version:first.version}}],next_cursor:'9.1',has_more:false};
  const client = {call:async <T=unknown>() => page as T};
  const persisted:string[] = [];
  const save = async (value:RelayCursorState) => { persisted.push(value.cursors[first.scope]!); };
  for (let attempt=0;attempt<3;attempt++) {
    assert.deepEqual(await forwardEventsOnce(client,notifier,[first.scope],state,save),{notified:0,skipped:0,uncertain:1});
    assert.equal(sent.length,1);
    assert.deepEqual(state.cursors,{});
  }
  const busy = await notifier.notify(second);
  assert.equal(busy.status,'unknown');
  assert.equal(busy.code,'relay_busy');
  assert.equal(sent.length,1);
  // Let the retained SDK request settle; the next poll observes its accepted receipt.
  release[0]!();
  await new Promise<void>(resolveTurn => { setImmediate(resolveTurn); });
  assert.deepEqual(await forwardEventsOnce(client,notifier,[first.scope],state,save),{notified:1,skipped:0,uncertain:0});
  assert.deepEqual(persisted,['9.1']);
  assert.deepEqual(sent,[`swarmaa:event:${first.event_id}`]);
  // The single global slot becomes available only after the underlying send settles.
  const next = notifier.notify(second);
  await Promise.resolve();
  assert.equal(sent.length,2);
  release[1]!();
  assert.equal((await next).status,'accepted');
});

test('event forwarding does not advance an uncertain event and retries the same event identity',async () => {
  const first=hint(), second=hint();
  const events = [first,second].map((h,i) => ({id:h.event_id,cursor:`9.${i+1}`,scope:h.scope,name:'task.updated',subject_id:h.task_id,payload:{task_id:h.task_id,status:h.status,version:h.version}}));
  const seen:string[] = [], saved:string[] = [];
  const state:RelayCursorState = {format:1,binding:'test',cursors:{}};
  const client = {call:async <T=unknown>(_name:string,args:Record<string,unknown>) => ({scope:'project:a',events:events.filter(e => e.cursor !== args.after),next_cursor:'9.2',has_more:false}) as T};
  let uncertain = true;
  const notifier:RelayNotifier = {notify:async h => {
    seen.push(h.event_id);
    return {event_id:h.event_id,status:h.event_id === second.event_id && uncertain ? 'unknown' : 'accepted',code:'test'};
  }};
  const save = async (value:RelayCursorState) => { saved.push(value.cursors['project:a']!); };
  assert.deepEqual(await forwardEventsOnce(client,notifier,['project:a'],state,save),{notified:1,skipped:0,uncertain:1});
  assert.equal(state.cursors['project:a'],'9.1');
  uncertain = false;
  await forwardEventsOnce(client,notifier,['project:a'],state,save);
  assert.deepEqual(seen,[first.event_id,second.event_id,second.event_id]);
  assert.deepEqual(saved,['9.1','9.2']);
});

test('a failed cursor write does not move the in-memory checkpoint past an ambiguous persistence',async () => {
  const h = hint();
  const page = {scope:h.scope,events:[{id:h.event_id,cursor:'9.1',scope:h.scope,name:'task.updated',subject_id:h.task_id,
    payload:{task_id:h.task_id,status:h.status,version:h.version}}],next_cursor:'9.1',has_more:false};
  const state:RelayCursorState = {format:1,binding:'test',cursors:{}};
  const notifier:RelayNotifier = {notify:async value => ({event_id:value.event_id,status:'accepted',code:'test'})};
  await assert.rejects(() => forwardEventsOnce({call:async <T=unknown>() => page as T},notifier,[h.scope],state,async () => { throw new Error('disk unavailable'); }));
  assert.deepEqual(state.cursors,{});
});

test('session coverage never infers full history from a short, empty, or full-sized window',() => {
  for (const count of [0,2,40]) {
    const coverage = sessionCoverage({turn_count:count,updated_at:new Date('2026-10-24T00:00:00Z')});
    assert.equal(coverage.completeness,'unknown');
    assert.equal(coverage.full_history_available,false);
    assert.equal(coverage.omitted_turns,null);
    assert.equal(coverage.stored_turns,count);
  }
});
