/** Authored for a disposable PostgreSQL database. Not executed during source-only delivery. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `collective_test_${randomUUID().replaceAll('-','')}`;
// Never use DATABASE_URL as a fallback. Only this randomly named test schema is removed.
describe('core transactional invariants', {skip:!connectionString,concurrency:false}, () => {
  let control:Pool;
  let pool:Pool;
  let core:CoreService;

  before(async () => {
    assert.ok(connectionString,'Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
    control = new pg.Pool({connectionString,max:2});
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of ['001_identity.sql','002_core.sql','005_swarm.sql','006_sessions.sql','008_lessons.sql','010_routing_policy.sql','011_patch_routing.sql','012_session_task.sql','013_worker_slots.sql']) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    core = new CoreService(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await control.end(); }
    }
  });

  // JSON results deliberately remain flexible here so tests focus on cross-call guarantees.
  async function call(p:Principal,name:string,args:Record<string,unknown>):Promise<Record<string,any>> {
    return await core.call(p,name,args) as Record<string,any>;
  }
  async function rejects(p:Principal,name:string,args:Record<string,unknown>,code:string):Promise<void> {
    await assert.rejects(() => call(p,name,args),(error:unknown) => error instanceof AppError && error.code === code);
  }
  async function fixture():Promise<{front:Principal;worker:Principal;worker2:Principal;owner:Principal;otherScope:Principal;otherTenant:Principal}> {
    const tenantId = randomUUID();
    const principals:Record<string,Principal> = {
      front:{id:randomUUID(),tenantId,name:'dot',role:'frontend',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.frontend]},
      worker:{id:randomUUID(),tenantId,name:'claude',role:'worker',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.worker]},
      worker2:{id:randomUUID(),tenantId,name:'codex',role:'worker',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.worker]},
      owner:{id:randomUUID(),tenantId,name:'owner',role:'admin',scopes:['*'],permissions:['admin']},
      otherScope:{id:randomUUID(),tenantId,name:'grok-b',role:'frontend',scopes:['project:b'],permissions:[...ROLE_PERMISSIONS.frontend]},
      otherTenant:{id:randomUUID(),tenantId:randomUUID(),name:'external',role:'frontend',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.frontend]},
    };
    for (const principal of Object.values(principals)) {
      await pool.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[principal.id,principal.tenantId,principal.name,principal.role,principal.scopes,principal.permissions,randomUUID()]);
    }
    return {front:principals.front!,worker:principals.worker!,worker2:principals.worker2!,owner:principals.owner!,
      otherScope:principals.otherScope!,otherTenant:principals.otherTenant!};
  }
  const note = (key:string,content='A reported observation') => ({scope:'project:a',kind:'note',key,content,source:{type:'agent',reference:'test-agent://observation'}});
  const submission = (key = randomUUID()) => ({scope:'project:a',kind:'research',objective:'Review the bounded project context.',
    constraints:['Read only. Do not publish or deploy.'],acceptance_criteria:['Return source references.'],
    idempotency_key:key,required_capability:'claude.read'});
  const claimArgs = {scope:'project:a',capabilities:['claude.read'],lease_seconds:30};
  const lease = (claim:Record<string,any>) => ({task_id:claim.task.id,lease_token:claim.lease_token,lease_generation:claim.lease_generation});
  const expire = (id:string) => pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);

  it('rejects a required_capability no worker can advertise',async () => {
    const f = await fixture();
    await rejects(f.front,'task_submit',{...submission(),required_capability:'gemini.read'},'unknown_capability');
    await rejects(f.front,'task_submit',{...submission(),kind:'patch',resource_key:'repo:x',required_capability:'gemini.patch'},'unknown_capability');
    await call(f.front,'task_submit',{...submission(),idempotency_key:'agy-patch',kind:'patch',required_capability:'antigravity.patch'});
    await call(f.front,'task_submit',{...submission(),kind:'review',required_capability:'antigravity.read'});
    await rejects(f.front,'task_submit',{...submission(),idempotency_key:'agy-research',required_capability:'antigravity.read'},'kind_not_allowed');
  });

  it('enforces permissions, roles, tenant and exact scope inside CoreService',async () => {
    const f = await fixture();
    assert.ok(!core.listTools(f.front).some(t => t.name === 'task_claim' || t.name === 'memory_promote'));
    await rejects(f.front,'task_claim',claimArgs,'forbidden');
    await rejects({...f.front,permissions:[...f.front.permissions,'task:claim']},'task_claim',claimArgs,'worker_required');
    const created = await call(f.front,'memory_propose',note('scope-guard','Private to project A'));
    await rejects(f.otherScope,'memory_get',{memory_id:created.memory.id},'not_found');
    await rejects(f.otherTenant,'memory_get',{memory_id:created.memory.id},'not_found');
    await rejects(f.front,'memory_search',{scope:'project:b'},'scope_forbidden');
    await rejects({...f.worker,permissions:[...f.worker.permissions,'memory:moderate']},'memory_promote',{
      memory_id:created.memory.id,expected_version:1},'owner_required');
    await rejects(f.front,'memory_search',{scope:'project:a',tenant_id:f.otherTenant.tenantId},'invalid_arguments');
    await rejects(f.front,'__proto__',{},'unknown_tool');
    const writeOnly:Principal = {...f.front,permissions:['memory:write','task:submit','task:cancel']};
    assert.ok(!core.listTools(writeOnly).some(t => ['memory_propose','task_submit','task_cancel'].includes(t.name)));
    await rejects(writeOnly,'memory_propose',note('scope-guard','Try to expose the previous value'),'forbidden');
    await rejects(writeOnly,'task_submit',submission(),'forbidden');
    const all = await call(f.owner,'memory_search',{scope:'project:a'});
    assert.equal(all.memories.length,1);
  });

  it('keeps directives proposed, protects promoted heads, and persists competing evidence',async () => {
    const f = await fixture();
    const directive = {...note('preferred-language','Use TypeScript for this project.'),kind:'preference'};
    const proposed = await call(f.worker,'memory_propose',directive);
    assert.equal(proposed.memory.status,'proposed');
    assert.equal(proposed.memory.source.assurance,'reported');
    assert.equal((await call(f.front,'memory_search',{scope:'project:a'})).memories.length,0);
    const approved = await call(f.owner,'memory_promote',{memory_id:proposed.memory.id,expected_version:1});
    assert.equal(approved.memory.version,2);
    assert.equal(approved.memory.authority,'owner_reviewed');
    const competing = await call(f.worker2,'memory_propose',{...directive,content:'Use Rust instead.',expected_version:2});
    assert.equal(competing.conflict,false);
    assert.equal(competing.proposal.status,'proposed');
    assert.equal(competing.memory.content,directive.content);
    const stale = await call(f.front,'memory_propose',{...directive,content:'Use Python instead.',expected_version:1});
    assert.equal(stale.conflict,true);
    assert.equal(stale.proposal.status,'conflict');
    const persisted = await pool.query('SELECT status FROM memory_proposals WHERE id=$1',[stale.proposal.id]);
    assert.equal(persisted.rows[0].status,'conflict');
    const accepted = await call(f.owner,'memory_promote',{memory_id:approved.memory.id,expected_version:2,proposal_id:competing.proposal.id});
    assert.equal(accepted.memory.content,'Use Rust instead.');
    assert.equal(accepted.memory.version,3);
    const history = await call(f.front,'memory_get',{memory_id:approved.memory.id,include_history:true});
    assert.equal(history.revisions.length,3);
    assert.ok(history.proposals.some((p:Record<string,unknown>) => p.id === stale.proposal.id && p.status === 'conflict'));
    await rejects(f.owner,'memory_promote',{memory_id:approved.memory.id,expected_version:2},'version_conflict');
  });

  it('serializes concurrent optimistic updates and commits exactly one competing proposal',async () => {
    const f = await fixture();
    const initial = await call(f.front,'memory_propose',note('concurrency'));
    const results = await Promise.all([
      call(f.front,'memory_propose',{...note('concurrency','First update'),expected_version:1}),
      call(f.worker,'memory_propose',{...note('concurrency','Second update'),expected_version:1}),
    ]);
    assert.equal(results.filter(r => r.conflict).length,1);
    assert.equal(results.filter(r => !r.conflict).length,1);
    const final = await call(f.front,'memory_get',{memory_id:initial.memory.id,include_history:true});
    assert.equal(final.memory.version,2);
    assert.equal(final.revisions.length,2);
    assert.equal(final.proposals.length,1);
  });

  it('bounds memory history and proposal subsets with truthful has-more flags',async () => {
    const f = await fixture();
    const initial = await call(f.front,'memory_propose',note('bounded-history','Revision 1'));
    for (let version=2;version<=12;version++) {
      await call(f.front,'memory_propose',{...note('bounded-history',`Revision ${version}`),expected_version:version-1});
    }
    for (let index=0;index<11;index++) {
      await call(f.worker,'memory_propose',{...note('bounded-history',`Conflicting proposal ${index}`),expected_version:1});
    }
    const defaults = await call(f.front,'memory_get',{memory_id:initial.memory.id,include_history:true});
    assert.equal(defaults.proposal_limit,10);
    assert.equal(defaults.history_limit,10);
    assert.equal(defaults.proposals.length,10);
    assert.equal(defaults.revisions.length,10);
    assert.equal(defaults.proposals_has_more,true);
    assert.equal(defaults.history_has_more,true);
    assert.deepEqual(defaults.revisions.map((r:Record<string,unknown>) => r.version),[12,11,10,9,8,7,6,5,4,3]);
    const zero = await call(f.front,'memory_get',{memory_id:initial.memory.id,include_history:true,proposal_limit:0,history_limit:0});
    assert.deepEqual(zero.proposals,[]);
    assert.deepEqual(zero.revisions,[]);
    assert.equal(zero.proposals_has_more,true);
    assert.equal(zero.history_has_more,true);
    assert.equal(zero.memory.version,12);
    const all = await call(f.front,'memory_get',{memory_id:initial.memory.id,include_history:true,proposal_limit:50,history_limit:100});
    assert.equal(all.proposals.length,11);
    assert.equal(all.revisions.length,12);
    assert.equal(all.proposals_has_more,false);
    assert.equal(all.history_has_more,false);
    const headOnly = await call(f.front,'memory_get',{memory_id:initial.memory.id,proposal_limit:0});
    assert.equal(headOnly.revisions,undefined);
    assert.equal(headOnly.history_has_more,undefined);
    await rejects(f.front,'memory_get',{memory_id:initial.memory.id,proposal_limit:51},'invalid_arguments');
    await rejects(f.front,'memory_get',{memory_id:initial.memory.id,history_limit:-1},'invalid_arguments');
  });

  it('retraction scrubs all memory bodies and structured task references',async () => {
    const f = await fixture();
    const secret = 'unique-content-that-must-disappear-from-memory';
    const initial = await call(f.front,'memory_propose',note('retraction',secret));
    const updated = await call(f.front,'memory_propose',{...note('retraction',`${secret}-revised`),expected_version:1});
    await call(f.worker,'memory_propose',{...note('retraction',`${secret}-conflict`),expected_version:1});
    const task = await call(f.front,'task_submit',{...submission(),context_refs:[initial.memory.id]});
    const beforePacket = await call(f.front,'context_get',{scope:'project:a',task_id:task.task.id});
    assert.equal(beforePacket.memories[0].input_version,2);
    const removed = await call(f.owner,'memory_retract',{memory_id:initial.memory.id,expected_version:updated.memory.version});
    assert.equal(removed.cleared_task_references,1);
    const tombstone = await call(f.front,'memory_get',{memory_id:initial.memory.id,include_history:true});
    assert.equal(tombstone.memory.status,'retracted');
    assert.equal(tombstone.memory.content,null);
    assert.equal(tombstone.memory.key,undefined);
    assert.deepEqual(tombstone.revisions,[]);
    assert.deepEqual(tombstone.proposals,[]);
    assert.equal(tombstone.proposals_has_more,false);
    assert.equal(tombstone.history_has_more,false);
    const revisions = await pool.query('SELECT content,source FROM memory_revisions WHERE memory_id=$1',[initial.memory.id]);
    assert.ok(revisions.rows.every(r => r.content === '' && JSON.stringify(r.source) === '{}'));
    const proposals = await pool.query('SELECT proposed_content,proposed_source FROM memory_proposals WHERE memory_id=$1',[initial.memory.id]);
    assert.ok(proposals.rows.every(r => r.proposed_content === '' && JSON.stringify(r.proposed_source) === '{}'));
    const packet = await call(f.front,'context_get',{scope:'project:a',task_id:task.task.id});
    assert.deepEqual(packet.task.context_refs,[]);
    assert.equal(packet.memories.length,0);
    assert.ok(!JSON.stringify(packet).includes(secret));
    const events = await call(f.front,'events_poll',{scope:'project:a'});
    assert.ok(!JSON.stringify(events).includes(secret));
    await rejects(f.front,'memory_propose',note('retraction','revive it'),'memory_retracted');
  });

  it('checks context scope, expiry, versions and content bounds',async () => {
    const f = await fixture();
    const first = await call(f.front,'memory_propose',note('long-body','x'.repeat(3000)));
    const task = await call(f.front,'task_submit',{...submission(),context_refs:[first.memory.id]});
    await call(f.worker,'memory_propose',{...note('long-body','y'.repeat(3000)),expected_version:1});
    await call(f.front,'memory_propose',{...note('expired','Do not retrieve this stale item'),expires_at:'2001-01-01T00:00:00Z'});
    const packet = await call(f.front,'context_get',{scope:'project:a',task_id:task.task.id});
    assert.equal(packet.memories.length,1);
    assert.equal(packet.memories[0].content.length,2000);
    assert.equal(packet.memories[0].content_truncated,true);
    assert.equal(packet.memories[0].changed_since_task,true);
    await rejects({...f.front,permissions:['memory:read']},'context_get',{scope:'project:a',task_id:task.task.id},'forbidden');
    await rejects(f.otherScope,'context_get',{scope:'project:b',task_id:task.task.id},'not_found');
  });

  it('deduplicates concurrent submissions and rejects changed inputs under a reused key',async () => {
    const f = await fixture();
    const args = submission();
    const [a,b] = await Promise.all([call(f.front,'task_submit',args),call(f.front,'task_submit',args)]);
    assert.equal(a.task.id,b.task.id);
    assert.equal([a,b].filter(r => r.replayed).length,1);
    const count = await pool.query('SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1',[f.front.tenantId]);
    assert.equal(count.rows[0].n,1);
    await rejects(f.front,'task_submit',{...args,objective:'A different task'},'idempotency_conflict');
    const privateMemory = await call(f.otherScope,'memory_propose',{...note('foreign-ref'),scope:'project:b'});
    await rejects(f.front,'task_submit',{...submission(),context_refs:[privateMemory.memory.id]},'invalid_context_refs');
    await rejects(f.otherTenant,'task_get',{task_id:a.task.id},'not_found');
    const events = await call(f.front,'events_poll',{scope:'project:a'});
    assert.equal(events.events.filter((e:Record<string,any>) => e.payload.action === 'submitted').length,1);
  });

  it('gives concurrent workers one lease, resumes checkpoints and fences every stale mutation',async () => {
    const f = await fixture();
    const submitted = await call(f.front,'task_submit',{...submission(),max_attempts:2});
    const claims = await Promise.all([call(f.worker,'task_claim',claimArgs),call(f.worker2,'task_claim',claimArgs)]);
    assert.equal(claims.filter(c => c.task).length,1);
    const initial = claims.find(c => c.task)!;
    const owner = initial.task.lease_owner === f.worker.id ? f.worker : f.worker2;
    const successor = owner.id === f.worker.id ? f.worker2 : f.worker;
    await rejects(successor,'task_checkpoint',{...lease(initial),checkpoint:{attempt:'stolen'}},'lease_lost');
    await rejects(owner,'task_heartbeat',{...lease(initial),lease_token:'wrong-token'},'lease_lost');
    await rejects(owner,'task_checkpoint',{...lease(initial),checkpoint:{invalid:'\u0000'}},'invalid_arguments');
    await rejects(owner,'task_checkpoint',{...lease(initial),checkpoint:{invalid:Number.POSITIVE_INFINITY}},'invalid_arguments');
    await call(owner,'task_checkpoint',{...lease(initial),checkpoint:{phase:'read-source',next_file:'README.md'}});
    const beforeRenewal = await call(f.front,'task_get',{task_id:submitted.task.id});
    const renewed = await call(owner,'task_heartbeat',{...lease(initial),lease_seconds:30});
    assert.equal(renewed.task.version,beforeRenewal.task.version);
    assert.equal(renewed.task.lease_hash,undefined);
    assert.equal(renewed.task.lease_token,undefined);
    await expire(submitted.task.id);
    await rejects(owner,'task_finish',{...lease(initial),outcome:'completed',result:{bad:true}},'lease_lost');
    const next = await call(successor,'task_claim',claimArgs);
    assert.equal(next.task.id,submitted.task.id);
    assert.ok(next.lease_generation>initial.lease_generation);
    assert.equal(next.task.checkpoint.phase,'read-source');
    assert.equal(next.task.attempt_count,2);
    await rejects(owner,'task_checkpoint',{...lease(initial),checkpoint:{stale:true}},'lease_lost');
    await rejects(owner,'artifact_put',{...lease(initial),name:'stale.txt',content:'bad'},'lease_lost');
    await expire(submitted.task.id);
    assert.equal((await call(f.worker,'task_claim',claimArgs)).task,null);
    const terminal = await call(f.front,'task_get',{task_id:submitted.task.id});
    assert.equal(terminal.task.status,'failed');
    assert.equal(terminal.task.result.error,'attempts_exhausted');
    assert.ok(terminal.task.runs.every((r:Record<string,unknown>) => r.status === 'abandoned'));
  });

  it('requires explicit patch permission and excludes simultaneous mutation of one resource',async () => {
    const f = await fixture();
    const patcher = {...f.worker,permissions:[...f.worker.permissions,'task:patch' as const]};
    const secondPatcher = {...f.worker2,permissions:[...f.worker2.permissions,'task:patch' as const]};
    await call(f.front,'task_submit',{...submission(),kind:'patch',resource_key:'repo:demo',required_capability:'claude.patch'});
    await call(f.front,'task_submit',{...submission(),kind:'patch',resource_key:'repo:demo',required_capability:'claude.patch'});
    const args = {scope:'project:a',capabilities:['claude.patch'],kinds:['patch'],lease_seconds:30};
    await rejects(f.worker,'task_claim',args,'forbidden');
    assert.equal((await call(patcher,'task_claim',{scope:'project:a',capabilities:['claude.patch']})).task,null);
    const [a,b] = await Promise.all([call(patcher,'task_claim',args),call(secondPatcher,'task_claim',args)]);
    assert.equal([a,b].filter(c => c.task).length,1);
    const active = a.task ? a : b;
    const owner = active.task.lease_owner === patcher.id ? patcher : secondPatcher;
    assert.equal(active.task.permission_envelope.local_patch,true);
    assert.equal(active.task.permission_envelope.deploy,false);
    await call(owner,'task_finish',{...lease(active),outcome:'completed',result:{review_required:true}});
    const next = await call(patcher,'task_claim',args);
    assert.ok(next.task && next.task.id !== active.task.id);
    await rejects({...patcher,permissions:patcher.permissions.filter(p => p !== 'task:patch')},'task_heartbeat',{...lease(next)},'forbidden');
  });

  it('hashes artifacts, validates provenance, and makes terminal delivery idempotent across continuation',async () => {
    const f = await fixture();
    await call(f.front,'task_submit',submission());
    const active = await call(f.worker,'task_claim',claimArgs);
    const put = {...lease(active),name:'report.md',content:'# Evidence\nSource: README.md',media_type:'text/markdown'};
    const a = await call(f.worker,'artifact_put',put);
    const replay = await call(f.worker,'artifact_put',put);
    assert.equal(a.artifact.id,replay.artifact.id);
    assert.equal(replay.replayed,true);
    assert.equal(a.artifact.sha256,createHash('sha256').update(put.content).digest('hex'));
    await rejects(f.worker,'artifact_put',{...put,content:'changed'},'artifact_conflict');
    await rejects(f.worker,'artifact_put',{...put,name:'../escape'},'invalid_arguments');
    await rejects(f.worker,'artifact_put',{...put,name:'large.txt',content:'é'.repeat(140000)},'artifact_too_large');
    await rejects(f.otherScope,'artifact_get',{artifact_id:a.artifact.id},'not_found');
    assert.equal((await call(f.front,'artifact_get',{artifact_id:a.artifact.id})).artifact.content,put.content);
    await rejects(f.worker,'task_finish',{...lease(active),outcome:'completed',result:{},artifact_ids:[randomUUID()]},'invalid_artifacts');
    const finish = {...lease(active),outcome:'completed',result:{evidence:['README.md'],review_required:true},artifact_ids:[a.artifact.id]};
    const [one,two] = await Promise.all([call(f.worker,'task_finish',finish),call(f.worker,'task_finish',finish)]);
    assert.equal([one,two].filter(r => r.replayed).length,1);
    await rejects(f.worker,'task_finish',{...finish,result:{changed:true}},'completion_conflict');
    const task = one.task;
    const continuation = {task_id:task.id,expected_version:task.version,instruction:'Explain the remaining unknowns.',idempotency_key:randomUUID()};
    const continued = await call(f.front,'task_continue',continuation);
    assert.equal(continued.task.status,'queued');
    assert.deepEqual(continued.task.constraints,task.constraints);
    assert.deepEqual(continued.task.permission_envelope,task.permission_envelope);
    assert.equal(continued.task.instructions.length,1);
    assert.equal((await call(f.front,'task_continue',continuation)).replayed,true);
    const late = await call(f.worker,'task_finish',finish);
    assert.equal(late.replayed,true);
    assert.equal(late.task.status,'queued');
    assert.equal(late.task.version,continued.task.version);
    const resumed = await call(f.worker2,'task_claim',claimArgs);
    assert.equal(resumed.task.instructions[0].instruction,continuation.instruction);
    assert.equal(resumed.task.runs[0].artifact_ids[0],a.artifact.id);
  });

  it('retains a resource cooldown after cancelling a running patch',async () => {
    const f = await fixture();
    const patcher = {...f.worker,permissions:[...f.worker.permissions,'task:patch' as const]};
    await call(f.front,'task_submit',{...submission(),kind:'patch',resource_key:'repo:cancelled',required_capability:'claude.patch'});
    const args = {scope:'project:a',capabilities:['claude.patch'],kinds:['patch']};
    const active = await call(patcher,'task_claim',args);
    const cancelled = await call(f.front,'task_cancel',{task_id:active.task.id,expected_version:active.task.version});
    await call(f.front,'task_continue',{task_id:active.task.id,expected_version:cancelled.task.version,instruction:'Resume within the same constraints.',idempotency_key:randomUUID()});
    assert.equal((await call(patcher,'task_claim',args)).task,null);
    const held = await pool.query<{generation:number;live:boolean}>(`SELECT generation,expires_at>clock_timestamp() AS live
      FROM task_resource_leases WHERE tenant_id=$1 AND scope='project:a' AND resource_key='repo:cancelled'`,[f.front.tenantId]);
    assert.equal(held.rows[0].generation,active.lease_generation);
    assert.equal(held.rows[0].live,true);
    await pool.query("UPDATE task_resource_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",[f.front.tenantId]);
    const next = await call(patcher,'task_claim',args);
    assert.equal(next.task.id,active.task.id);
    assert.ok(next.lease_generation>active.lease_generation);
  });

  it('requires versioned cancellation, rejects active continuation, and invalidates worker authority',async () => {
    const f = await fixture();
    const submitted = await call(f.front,'task_submit',submission());
    const active = await call(f.worker,'task_claim',claimArgs);
    await rejects(f.front,'task_cancel',{task_id:active.task.id,expected_version:submitted.task.version},'version_conflict');
    await rejects(f.front,'task_continue',{task_id:active.task.id,expected_version:active.task.version,instruction:'Change course.',idempotency_key:randomUUID()},'task_running');
    const cancelled = await call(f.front,'task_cancel',{task_id:active.task.id,expected_version:active.task.version});
    assert.equal(cancelled.task.status,'cancelled');
    await rejects(f.worker,'task_heartbeat',lease(active),'lease_lost');
    await rejects(f.worker,'task_finish',{...lease(active),outcome:'completed',result:{late:true}},'lease_lost');
    assert.equal((await call(f.worker2,'task_claim',claimArgs)).task,null);
    const continued = await call(f.front,'task_continue',{task_id:active.task.id,expected_version:cancelled.task.version,instruction:'Resume the original bounded task.',idempotency_key:randomUUID()});
    assert.equal(continued.task.status,'queued');
    assert.equal(continued.task.attempt_count,0);
  });

  it('polls scope-filtered metadata without skipping out-of-order sequence commits',{timeout:12000},async () => {
    const f = await fixture();
    const held = await pool.connect();
    const oldId = randomUUID();
    const newerId = randomUUID();
    try {
      await held.query('BEGIN');
      await held.query(`INSERT INTO events(id,tenant_id,scope,name,subject_id,payload)
        VALUES($1,$2,'project:a','task.updated',$3,'{"action":"early-allocation"}')`,[oldId,f.front.tenantId,randomUUID()]);
      await pool.query(`INSERT INTO events(id,tenant_id,scope,name,subject_id,payload)
        VALUES($1,$2,'project:a','task.updated',$3,'{"action":"earlier-commit"}')`,[newerId,f.front.tenantId,randomUUID()]);
      // The lower sequence is uncommitted: the poll must not advance over it.
      await rejects(f.front,'events_poll',{scope:'project:a',after:'0'},'events_busy');
      await held.query('COMMIT');
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    await call(f.otherScope,'memory_propose',{...note('other-scope'),scope:'project:b'});
    await call(f.otherTenant,'memory_propose',note('other-tenant'));
    const first = await call(f.front,'events_poll',{scope:'project:a',after:'0',limit:1});
    assert.equal(first.events[0].id,oldId);
    assert.equal(first.has_more,true);
    assert.equal(typeof first.next_cursor,'string');
    const second = await call(f.front,'events_poll',{scope:'project:a',after:first.next_cursor,limit:10});
    assert.equal(second.events.length,1);
    assert.equal(second.events[0].id,newerId);
    assert.ok(BigInt(second.next_cursor)>BigInt(first.next_cursor));
    const empty = await call(f.front,'events_poll',{scope:'project:a',after:second.next_cursor});
    assert.equal(empty.events.length,0);
    assert.equal(empty.next_cursor,second.next_cursor);
    await rejects(f.front,'events_poll',{scope:'project:a',after:'9223372036854775808'},'invalid_arguments');
  });

  it('filters event types by the underlying resource read permissions',async () => {
    const f = await fixture();
    await call(f.front,'memory_propose',note('event-read-filter'));
    await call(f.front,'task_submit',submission());
    const memoryOnly:Principal = {...f.front,permissions:['events:read','memory:read']};
    const taskOnly:Principal = {...f.front,permissions:['events:read','task:read']};
    const memories = await call(memoryOnly,'events_poll',{scope:'project:a'});
    const tasks = await call(taskOnly,'events_poll',{scope:'project:a'});
    assert.equal(memories.events.length,1);
    assert.equal(memories.events[0].name,'memory.changed');
    assert.equal(tasks.events.length,1);
    assert.equal(tasks.events[0].name,'task.updated');
    const neither = await call({...f.front,permissions:['events:read']},'events_poll',{scope:'project:a'});
    assert.equal(neither.events.length,0);
    assert.equal(neither.next_cursor,'0');
  });
});
