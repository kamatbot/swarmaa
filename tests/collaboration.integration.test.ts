/** Requires an explicitly selected disposable TEST_DATABASE_URL. Authored, not run. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `swarmaa_collaboration_${randomUUID().replaceAll('-','')}`;
describe('durable collaboration boundaries',{skip:!connectionString,concurrency:false},() => {
  let control:Pool, pool:Pool, core:CoreService;
  before(async () => {
    assert.ok(connectionString);
    control = new pg.Pool({connectionString,max:2});
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const filename of ['001_identity.sql','002_core.sql','005_swarm.sql','006_sessions.sql','008_lessons.sql','010_routing_policy.sql',
      '011_patch_routing.sql','012_session_task.sql','013_worker_slots.sql','016_worker_slots_drain.sql','018_events_xid.sql','019_workflows.sql','020_collaboration.sql']) {
      await pool.query(await readFile(new URL(`../db/migrations/${filename}`,import.meta.url),'utf8'));
    }
    core = new CoreService(pool);
  });
  after(async () => {
    if (pool) await pool.end();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await control.end(); } }
  });
  const call = async (p:Principal,name:string,args:Record<string,unknown>):Promise<Record<string,any>> => await core.call(p,name,args) as Record<string,any>;
  const rejects = async (p:Principal,name:string,args:Record<string,unknown>,code:string):Promise<void> => {
    await assert.rejects(() => call(p,name,args),(error:unknown) => error instanceof AppError && error.code === code);
  };
  async function fixture() {
    const tenantId = randomUUID();
    const principals = {
      front:{id:randomUUID(),tenantId,name:'dot',role:'frontend',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.frontend]} as Principal,
      worker:{id:randomUUID(),tenantId,name:'claude',role:'worker',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.worker]} as Principal,
      worker2:{id:randomUUID(),tenantId,name:'codex',role:'worker',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.worker]} as Principal,
      owner:{id:randomUUID(),tenantId,name:'owner',role:'admin',scopes:['*'],permissions:['admin']} as Principal,
      other:{id:randomUUID(),tenantId:randomUUID(),name:'other',role:'frontend',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.frontend]} as Principal,
    };
    for (const p of Object.values(principals)) await pool.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    return principals;
  }
  const submit = () => ({scope:'project:a',kind:'research',objective:'Inspect the bounded source without making changes.',
    constraints:['Do not expand scope or permissions.'],acceptance_criteria:['Cite evidence.'],required_capability:'claude.read',idempotency_key:randomUUID()});
  const claim = {scope:'project:a',capabilities:['claude.read'],lease_seconds:30};
  const lease = (r:Record<string,any>) => ({task_id:r.task.id,lease_token:r.lease_token,lease_generation:r.lease_generation});
  const message = (taskId:string,body='Additional sourced context.') => ({task_id:taskId,body,idempotency_key:randomUUID()});

  it('stores one idempotent message, scopes retrieval, and rejects authority fields',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    const input = message(task.id);
    const copies = await Promise.all([call(f.front,'task_message_send',input),call(f.front,'task_message_send',input)]);
    assert.equal(copies[0]!.message.id,copies[1]!.message.id);
    assert.equal(copies.filter(copy => copy.replayed).length,1);
    await rejects(f.front,'task_message_send',{...input,body:'Changed text.'},'idempotency_conflict');
    await rejects(f.other,'task_message_list',{task_id:task.id},'not_found');
    await rejects({...f.front,permissions:['task:read']},'task_message_send',message(task.id),'forbidden');
    await rejects(f.front,'task_message_send',{...message(task.id),permission_envelope:{deploy:true}},'invalid_arguments');
    await rejects(f.front,'task_message_send',{...message(task.id),body:'😀'.repeat(3000)},'invalid_arguments');
    const current = (await call(f.front,'task_get',{task_id:task.id})).task;
    assert.deepEqual(current.permission_envelope,task.permission_envelope);
    assert.deepEqual(current.constraints,task.constraints);
    assert.equal(current.status,'queued');
  });

  it('freezes one pre-invocation batch and defers messages arriving after claim',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    const first = (await call(f.front,'task_message_send',message(task.id))).message;
    const active = await call(f.worker,'task_claim',claim);
    const boundary = await call(f.worker,'task_message_pull',lease(active));
    assert.deepEqual(boundary.messages.map((m:any) => m.id),[first.id]);
    const later = (await call(f.front,'task_message_send',message(task.id,'For the next invocation.'))).message;
    assert.equal(later.delivery_status,'deferred');
    const replay = await call(f.worker,'task_message_pull',lease(active));
    assert.equal(replay.batch_id,boundary.batch_id);
    assert.deepEqual(replay.message_ids,boundary.message_ids);
    const ack = {...lease(active),batch_id:boundary.batch_id,status:'delivered',reason:'Included in provider invocation.'};
    await call(f.worker,'task_message_ack',ack);
    assert.equal((await call(f.worker,'task_message_ack',ack)).replayed,true);
    await rejects(f.worker,'task_message_ack',{...ack,status:'failed'},'delivery_conflict');
    assert.equal((await call(f.front,'task_get',{task_id:task.id})).task.status,'running');
    const finished = (await call(f.worker,'task_finish',{...lease(active),outcome:'completed',result:{acceptance_criteria_verified:false}})).task;
    await call(f.front,'task_continue',{task_id:task.id,expected_version:finished.version,instruction:'Continue within the original contract.',idempotency_key:randomUUID()});
    const next = await call(f.worker2,'task_claim',claim);
    const nextBoundary = await call(f.worker2,'task_message_pull',lease(next));
    assert.deepEqual(nextBoundary.messages.map((m:any) => m.id),[later.id]);
  });

  it('paginates sub-millisecond messages without repeating the cursor record',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    const ids:string[] = [];
    for (let i=1;i<=3;i++) {
      const saved = (await call(f.front,'task_message_send',message(task.id,`Message ${i}`))).message;
      ids.push(saved.id);
      await pool.query('UPDATE task_messages SET created_at=$2::timestamptz WHERE id=$1',[saved.id,`2026-10-24T00:00:00.000${i}00Z`]);
    }
    let after:string|undefined;
    const seen:string[] = [];
    for (let i=0;i<3;i++) {
      const page = await call(f.front,'task_message_list',{task_id:task.id,limit:1,...(after ? {after_id:after} : {})});
      assert.equal(page.messages.length,1);
      seen.push(page.messages[0].id);
      assert.equal(page.has_more,i<2);
      after = page.next_after_id ?? undefined;
    }
    assert.deepEqual(seen,ids);
    const otherTask = (await call(f.front,'task_submit',submit())).task;
    await rejects(f.front,'task_message_list',{task_id:otherTask.id,after_id:ids[0]},'not_found');
  });

  it('fences stale delivery receipts and reoffers an unacknowledged batch to the successor',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    const msg = (await call(f.front,'task_message_send',message(task.id))).message;
    const first = await call(f.worker,'task_claim',claim);
    const firstBatch = await call(f.worker,'task_message_pull',lease(first));
    await rejects(f.worker2,'task_message_ack',{...lease(first),batch_id:firstBatch.batch_id,status:'delivered'},'lease_lost');
    await pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[task.id]);
    await rejects(f.worker,'task_message_ack',{...lease(first),batch_id:firstBatch.batch_id,status:'delivered'},'lease_lost');
    const next = await call(f.worker2,'task_claim',claim);
    const nextBatch = await call(f.worker2,'task_message_pull',lease(next));
    assert.deepEqual(nextBatch.messages.map((m:any) => m.id),[msg.id]);
    assert.notEqual(nextBatch.batch_id,firstBatch.batch_id);
    await call(f.worker2,'task_message_ack',{...lease(next),batch_id:nextBatch.batch_id,status:'deferred',reason:'Invocation was not started.'});
    assert.equal((await call(f.front,'task_message_list',{task_id:task.id})).messages[0].delivery_status,'deferred');
    assert.equal((await call(f.front,'task_get',{task_id:task.id})).task.status,'running');
  });

  it('changes handoff identity when delivery counts change without changing the task version',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    await call(f.front,'task_message_send',message(task.id));
    const active = await call(f.worker,'task_claim',claim);
    const batch = await call(f.worker,'task_message_pull',lease(active));
    const before = (await call(f.front,'task_handoff',{task_id:task.id})).handoff;
    await call(f.worker,'task_message_ack',{...lease(active),batch_id:batch.batch_id,status:'delivered'});
    const after = (await call(f.front,'task_handoff',{task_id:task.id})).handoff;
    assert.equal(before.source.task_version,after.source.task_version);
    assert.deepEqual(before.collaboration.counts,{accepted:1});
    assert.deepEqual(after.collaboration.counts,{delivered:1});
    assert.notEqual(before.snapshot_id,after.snapshot_id);
    assert.equal((await call(f.front,'task_handoff',{task_id:task.id})).handoff.snapshot_id,after.snapshot_id);
  });

  it('binds worker messages to live source leases without reviving cancelled recipients',async () => {
    const f = await fixture();
    const source = (await call(f.front,'task_submit',submit())).task;
    const active = await call(f.worker,'task_claim',claim);
    assert.equal(active.task.id,source.id);
    const target = (await call(f.front,'task_submit',submit())).task;
    await call(f.front,'task_cancel',{task_id:target.id,expected_version:target.version});
    const input = {...message(target.id),source_task_id:source.id,source_lease_token:active.lease_token,source_lease_generation:active.lease_generation};
    await rejects(f.worker,'task_message_send',{...input,source_lease_token:'bad'},'lease_lost');
    const sent = await call(f.worker,'task_message_send',input);
    assert.equal(sent.message.delivery_status,'deferred');
    assert.equal(sent.message.source_task_id,source.id);
    assert.equal((await call(f.front,'task_get',{task_id:target.id})).task.status,'cancelled');
    await pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[source.id]);
    await rejects(f.worker,'task_message_send',{...input,idempotency_key:randomUUID()},'lease_lost');
  });

  it('bounds a message boundary and leaves overflow visible for another explicit run',async () => {
    const f = await fixture();
    const task = (await call(f.front,'task_submit',submit())).task;
    for (let i=0;i<6;i++) await call(f.front,'task_message_send',message(task.id,`${i}:`+'x'.repeat(3998)));
    const active = await call(f.worker,'task_claim',claim);
    const batch = await call(f.worker,'task_message_pull',lease(active));
    assert.ok(batch.messages.length>0 && batch.messages.length<6);
    assert.equal(batch.has_more,true);
    assert.ok(batch.payload_bytes<=16384);
    assert.equal((await call(f.front,'task_message_list',{task_id:task.id})).messages.length,6);
  });

  it('makes managed-step continuation explicit and rejects new terminal input while preserving an accepted-send replay',async () => {
    const f = await fixture();
    const run = (await call(f.front,'workflow_submit',{scope:'project:a',objective:'Review the pinned source.',base_commit:'a'.repeat(40),
      reviewers:['claude','codex'],idempotency_key:randomUUID()})).workflow;
    const reviewer = run.steps.find((step:any) => step.key === 'reviewer_a').task;
    const synthesis = run.steps.find((step:any) => step.key === 'synthesis').task;
    const input = message(reviewer.id);
    const saved = (await call(f.front,'task_message_send',input)).message;
    assert.equal((await call(f.front,'task_message_send',message(synthesis.id))).accepted,true);
    const before = (await call(f.front,'task_handoff',{task_id:reviewer.id})).handoff;
    assert.equal(before.source.workflow_id,run.id);
    assert.equal(before.source.workflow_step,'reviewer_a');
    assert.equal(before.continuation_policy,'workflow_coordinator_only');
    assert.equal(before.requires_explicit_continuation,false);
    await call(f.front,'workflow_cancel',{workflow_id:run.id,expected_version:run.version});
    await rejects(f.front,'task_message_send',message(reviewer.id),'workflow_managed');
    await rejects(f.front,'task_message_send',message(synthesis.id),'workflow_managed');
    const replay = await call(f.front,'task_message_send',input);
    assert.equal(replay.replayed,true);
    assert.equal(replay.message.id,saved.id);
    const afterResult = await call(f.front,'task_handoff',{task_id:reviewer.id});
    const after = afterResult.handoff;
    assert.equal(after.source.status,'cancelled');
    assert.equal(after.continuation_policy,'new_workflow_required');
    assert.equal(after.requires_explicit_continuation,false);
    assert.match(afterResult.guidance,/cannot use task_continue/);
  });

  it('returns current memory versions and honest transcript coverage without copying memory bodies',async () => {
    const f = await fixture();
    const memoryInput = {scope:'project:a',kind:'note',key:'handoff-source',content:'private-memory-body-marker',source:{type:'agent',reference:'test:source'}};
    const memory = (await call(f.front,'memory_propose',memoryInput)).memory;
    const task = (await call(f.front,'task_submit',{...submit(),context_refs:[memory.id]})).task;
    const active = await call(f.worker,'task_claim',claim);
    await call(f.front,'memory_propose',{...memoryInput,expected_version:memory.version,content:'updated-memory-body-marker'});
    await call(f.worker,'session_record',{harness:'codex',session_id:randomUUID(),scope:'project:a',task_id:task.id,
      turns:[{role:'assistant',text:'Partial recorded evidence.',at:'2026-10-24T00:00:00Z'}]});
    const artifact = (await call(f.worker,'artifact_put',{...lease(active),name:'evidence.txt',content:'artifact body'})).artifact;
    const result = await call(f.front,'task_handoff',{task_id:task.id});
    assert.equal(result.handoff.memory_refs[0].changed_since_task,true);
    assert.equal(result.handoff.memory_refs[0].current_version,memory.version+1);
    assert.equal(result.handoff.artifacts[0].sha256,artifact.sha256);
    assert.equal(result.handoff.sessions[0].coverage.completeness,'unknown');
    assert.equal(result.handoff.unverified_work.acceptance_criteria_verified,false);
    assert.equal(result.handoff.continuation_policy,'not_required');
    assert.equal(result.handoff.requires_explicit_continuation,false);
    assert.ok(!JSON.stringify(result).includes('memory-body-marker'));
    assert.ok(!JSON.stringify(result).includes('artifact body'));
    await rejects({...f.front,permissions:['task:read']},'task_handoff',{task_id:task.id},'forbidden');
    await rejects(f.other,'task_handoff',{task_id:task.id},'not_found');
    await call(f.worker,'task_finish',{...lease(active),outcome:'completed',result:{acceptance_criteria_verified:false}});
    const terminal = (await call(f.front,'task_handoff',{task_id:task.id})).handoff;
    assert.equal(terminal.continuation_policy,'task_continue_required');
    assert.equal(terminal.requires_explicit_continuation,true);
  });
});
