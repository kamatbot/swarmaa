/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('teams phase 2 swarms and coordination', { skip: !connectionString, concurrency: false }, () => {
  const schema = `swarms_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool;
  let pool: Pool;
  let core: CoreService;
  let server: Server;
  let origin: string;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });

    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }

    core = new CoreService(pool);
    const config: ServerConfig = {
      host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', allowedOrigins: [], allowInsecureLocalhost: true,
      maxBodyBytes: 131072, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '0'.repeat(64)
    };
    server = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config, streamHeartbeatMs: 50 }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    config.port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${config.port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(r => server.close(() => r()));
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.end();
    }
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown> = {}) =>
    await core.call(p, name, args) as Record<string, any>;

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'] = 'frontend', scopes = ['project:friday']) {
    const p: Principal = {
      id: randomUUID(),
      tenantId,
      name,
      role,
      scopes,
      permissions: [...ROLE_PERMISSIONS[role]]
    };
    const token = newToken();
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(token)]
    );
    return { ...p, token };
  }

  it('the Friday-launch scenario: 5 steps, 3 agents, dependency order, question, reassign, restart, final summary, done 5/5', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-lead', 'admin', ['project:friday']);
    const worker = await createPrincipal(tenantId, 'worker-mac', 'worker', ['project:friday']);

    // 1. Create 3 agents: Atlas, Pulse, Scout
    const { agent: atlas } = await call(user, 'agent_create', {
      name: 'Atlas', role: 'Team lead', instructions: 'Coordinate the launch.', scope: 'project:friday',
      runner: { provider: 'codex' }
    });
    const { agent: pulse } = await call(user, 'agent_create', {
      name: 'Pulse', role: 'Research lead', instructions: 'Research channels and copy.', scope: 'project:friday',
      runner: { provider: 'codex' }
    });
    const { agent: scout } = await call(user, 'agent_create', {
      name: 'Scout', role: 'Design lead', instructions: 'Design assets and page.', scope: 'project:friday',
      runner: { provider: 'codex' }
    });

    // 2. Atlas starts a 5-step swarm
    // Steps:
    // - step1: Pulse (needs: [])
    // - step2: Scout (needs: [step1])
    // - step3: Pulse (needs: [step1])
    // - step4: Scout (needs: [step2, step3])
    // - step5: Atlas (needs: [step4])
    const { swarm: startedSwarm } = await call(user, 'swarm_start', {
      title: "Friday's launch",
      goal: 'Launch the campaign across channels.',
      scope: 'project:friday',
      thread_id: atlas.main_thread_id,
      steps: [
        { key: 'step1', title: 'Research launch channels', assignee_agent_id: pulse.id, needs: [] },
        { key: 'step2', title: 'Design launch graphics', assignee_agent_id: scout.id, needs: ['step1'] },
        { key: 'step3', title: 'Draft launch copy', assignee_agent_id: pulse.id, needs: ['step1'] },
        { key: 'step4', title: 'Assemble campaign page', assignee_agent_id: scout.id, needs: ['step2', 'step3'] },
        { key: 'step5', title: 'Review launch readiness', assignee_agent_id: atlas.id, needs: ['step4'] }
      ]
    });

    assert.equal(startedSwarm.title, "Friday's launch");
    assert.equal(startedSwarm.status, 'running');
    assert.equal(startedSwarm.steps.length, 5);

    // Initial state: Step 1 is running; others are pending
    const step1Id = startedSwarm.steps.find((s: any) => s.step_key === 'step1').id;
    const step2Id = startedSwarm.steps.find((s: any) => s.step_key === 'step2').id;
    const step3Id = startedSwarm.steps.find((s: any) => s.step_key === 'step3').id;
    const step4Id = startedSwarm.steps.find((s: any) => s.step_key === 'step4').id;
    const step5Id = startedSwarm.steps.find((s: any) => s.step_key === 'step5').id;

    // Pulse receives handoff message in Pulse's thread
    const pulseMessages = await call(user, 'thread_read', { thread_id: pulse.main_thread_id });
    assert.ok(pulseMessages.messages.some((m: any) => m.kind === 'handoff' && m.body.includes('Research launch channels')));

    // 3. Worker claims turn for Pulse (Step 1)
    const claim1 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.ok(claim1.task);
    assert.equal(claim1.task.agent_id, pulse.id);
    assert.equal(claim1.task.swarm_step_id, step1Id);

    // Pulse asks a question during step 1 via turn actions
    const questionAction = {
      type: 'question_ask',
      prompt: 'Which channels should we launch on?',
      options: ['Web', 'Email', 'Social'],
      multi: true,
      free_text: true,
      swarm_step_id: step1Id
    };

    await call(worker, 'task_finish', {
      task_id: claim1.task.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: {
        answer: `I need confirmation before finishing.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([questionAction])}\n\`\`\``
      }
    });

    // Check swarm and step status: both read waiting_on_you!
    const swarmCheck1 = await call(user, 'swarm_get', { swarm_id: startedSwarm.id });
    assert.equal(swarmCheck1.swarm.status, 'waiting_on_you');
    const step1AfterQ = swarmCheck1.swarm.steps.find((s: any) => s.id === step1Id);
    assert.equal(step1AfterQ.status, 'waiting_on_you');

    // Questions list shows the open question
    const qList = await call(user, 'question_list', { status: 'open' });
    assert.equal(qList.questions.length, 1);
    assert.equal(qList.questions[0].prompt, 'Which channels should we launch on?');

    // 4. User answers the question
    await call(user, 'question_answer', {
      question_id: qList.questions[0].id,
      choices: ['Web', 'Social'],
      text: 'Launch on Web and Social first',
      idempotency_key: 'ans-1'
    });

    // Swarm and step status return to running!
    const swarmCheck2 = await call(user, 'swarm_get', { swarm_id: startedSwarm.id });
    assert.equal(swarmCheck2.swarm.status, 'running');
    const step1Resumed = swarmCheck2.swarm.steps.find((s: any) => s.id === step1Id);
    assert.equal(step1Resumed.status, 'running');

    // 5. Worker claims the resumed turn for Pulse and completes Step 1
    const claim1Resume = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claim1Resume.task.agent_id, pulse.id);
    assert.equal(claim1Resume.task.initiator_kind, 'answer');

    await call(worker, 'task_finish', {
      task_id: claim1Resume.task.id,
      lease_token: claim1Resume.lease_token,
      lease_generation: claim1Resume.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 1 complete: Web and Social researched.' }
    });

    // Step 1 is done! Now step 2 and step 3 are unblocked and running!
    const swarmCheck3 = await call(user, 'swarm_get', { swarm_id: startedSwarm.id });
    assert.equal(swarmCheck3.swarm.steps.find((s: any) => s.id === step1Id).status, 'done');
    assert.equal(swarmCheck3.swarm.steps.find((s: any) => s.id === step2Id).status, 'running');
    assert.equal(swarmCheck3.swarm.steps.find((s: any) => s.id === step3Id).status, 'running');

    // 6. Step 2 is claimed by worker for Scout
    const claim2 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    // May claim step 2 or step 3 depending on order
    const firstClaimedStep = claim2.task.swarm_step_id;
    assert.ok([step2Id, step3Id].includes(firstClaimedStep));

    // While step 2 is running, reassign step 2 to Pulse!
    // If claim2 claimed step 2, it's currently running. If it claimed step 3, claim step 2 next.
    let runningStep2TaskId: string;
    let step2Claim: any;
    if (firstClaimedStep === step2Id) {
      step2Claim = claim2;
      runningStep2TaskId = claim2.task.id;
    } else {
      step2Claim = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
      assert.equal(step2Claim.task.swarm_step_id, step2Id);
      runningStep2TaskId = step2Claim.task.id;
    }

    // Reassign step 2 while running
    await call(user, 'swarm_update', {
      swarm_id: startedSwarm.id,
      ops: [{ op: 'reassign', step_id: step2Id, assignee_agent_id: pulse.id }]
    });

    // Old task for step 2 was cancelled!
    const oldTask = (await pool.query('SELECT status FROM tasks WHERE id=$1', [runningStep2TaskId])).rows[0];
    assert.equal(oldTask.status, 'cancelled');

    // Step 2 assignee is now Pulse!
    const step2AfterReassign = (await call(user, 'swarm_get', { swarm_id: startedSwarm.id })).swarm.steps.find((s: any) => s.id === step2Id);
    assert.equal(step2AfterReassign.assignee_agent_id, pulse.id);
    assert.equal(step2AfterReassign.status, 'running');

    // 7. Simulated restart in the middle
    core = new CoreService(pool);
    // Expire any running leases to simulate restart
    await pool.query("UPDATE tasks SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'running'");

    // 8. Work continues after restart:
    // Finish step 3 if not finished yet
    const claimStep3 = firstClaimedStep === step3Id ? claim2 : await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    if (claimStep3?.task?.swarm_step_id === step3Id) {
      await call(worker, 'task_finish', {
        task_id: claimStep3.task.id,
        lease_token: claimStep3.lease_token,
        lease_generation: claimStep3.lease_generation,
        outcome: 'completed',
        result: { answer: 'Step 3 complete: Copy drafted.' }
      });
    }

    // Finish step 2 (reassigned to Pulse)
    const claimReassigned2 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimReassigned2.task.agent_id, pulse.id);
    assert.equal(claimReassigned2.task.swarm_step_id, step2Id);
    await call(worker, 'task_finish', {
      task_id: claimReassigned2.task.id,
      lease_token: claimReassigned2.lease_token,
      lease_generation: claimReassigned2.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 2 complete: Graphics designed.' }
    });

    // Now steps 1, 2, 3 are done. Step 4 (Scout) is unblocked!
    const swarmCheck4 = await call(user, 'swarm_get', { swarm_id: startedSwarm.id });
    assert.equal(swarmCheck4.swarm.steps.find((s: any) => s.id === step4Id).status, 'running');

    const claim4 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claim4.task.agent_id, scout.id);
    assert.equal(claim4.task.swarm_step_id, step4Id);
    await call(worker, 'task_finish', {
      task_id: claim4.task.id,
      lease_token: claim4.lease_token,
      lease_generation: claim4.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 4 complete: Campaign page assembled.' }
    });

    // Step 4 done! Step 5 (Atlas) is unblocked!
    const claim5 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claim5.task.agent_id, atlas.id);
    assert.equal(claim5.task.swarm_step_id, step5Id);
    await call(worker, 'task_finish', {
      task_id: claim5.task.id,
      lease_token: claim5.lease_token,
      lease_generation: claim5.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 5 complete: Readiness verified.' }
    });

    // All 5 steps are now done!
    // Final summarising turn is queued for owner Atlas!
    const claimSummary = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimSummary.task.agent_id, atlas.id);
    assert.equal(claimSummary.task.initiator_kind, 'swarm');
    assert.ok(claimSummary.task.objective.includes('Summarise swarm'));

    await call(worker, 'task_finish', {
      task_id: claimSummary.task.id,
      lease_token: claimSummary.lease_token,
      lease_generation: claimSummary.lease_generation,
      outcome: 'completed',
      result: { answer: 'Friday launch ready! 5/5 steps finished.' }
    });

    // Swarm ends done 5/5!
    const finalSwarm = (await call(user, 'swarm_get', { swarm_id: startedSwarm.id })).swarm;
    assert.equal(finalSwarm.status, 'done');
    assert.equal(finalSwarm.progress.done, 5);
    assert.equal(finalSwarm.progress.total, 5);
    assert.ok(finalSwarm.closed_at !== null);
  });

  it('turn-grant refusals: cross-scope handoff, updating another agent swarm, and posting to channel agent is not in', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:a', 'project:b']);
    const worker = await createPrincipal(tenantId, 'worker-1', 'worker', ['project:a', 'project:b']);

    const { agent: agentA } = await call(user, 'agent_create', {
      name: 'AgentA', role: 'Worker A', instructions: 'Inst A', scope: 'project:a', runner: { provider: 'codex' }
    });
    const { agent: agentB } = await call(user, 'agent_create', {
      name: 'AgentB', role: 'Worker B', instructions: 'Inst B', scope: 'project:b', runner: { provider: 'codex' }
    });

    // Post to AgentA thread -> queues Turn 1
    await call(user, 'thread_post', { thread_id: agentA.main_thread_id, body: 'Hello AgentA', idempotency_key: 'post-1' });
    const claim1 = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'] });

    // 1. Refuse cross-scope handoff (Agent A attempting to hand off to Agent B in project:b)
    await call(worker, 'task_finish', {
      task_id: claim1.task.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: {
        answer: `I am trying to hand off.\n\n\`\`\`swarmaa-actions\n[{"type":"handoff","to_agent":"${agentB.id}","body":"cross-scope"}]\n\`\`\``
      }
    });

    // Check thread: text was posted, plus a notice naming the rejection
    const msgs1 = (await call(user, 'thread_read', { thread_id: agentA.main_thread_id })).messages;
    const lastNotice1 = msgs1.find((m: any) => m.kind === 'notice');
    assert.ok(lastNotice1);
    assert.ok(lastNotice1.body.includes('Turn action rejected: handoff: handoff target agent'));

    // Agent B did NOT receive any task
    const bTasks = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [agentB.id])).rows;
    assert.equal(bTasks.length, 0);

    // 2. Refuse updating someone else's swarm
    // User creates swarm in project:b owned by AgentB
    const { swarm: swarmB } = await call(user, 'swarm_start', {
      title: 'Swarm B', goal: 'Goal B', scope: 'project:b', thread_id: agentB.main_thread_id,
      steps: [{ key: 'step1', title: 'Step 1', assignee_agent_id: agentB.id, needs: [] }]
    });

    // Queue Turn 2 for AgentA
    await call(user, 'thread_post', { thread_id: agentA.main_thread_id, body: 'Second turn', idempotency_key: 'post-2' });
    const claim2 = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'] });

    // Agent A attempts to update Swarm B
    await call(worker, 'task_finish', {
      task_id: claim2.task.id,
      lease_token: claim2.lease_token,
      lease_generation: claim2.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Updating swarm.\n\n\`\`\`swarmaa-actions\n[{"type":"swarm_update","swarm_id":"${swarmB.id}","ops":[{"op":"close"}]}]\n\`\`\``
      }
    });

    const msgs2 = (await call(user, 'thread_read', { thread_id: agentA.main_thread_id })).messages;
    const lastNotice2 = msgs2.find((m: any) => m.kind === 'notice' && m.body.includes('swarm_update'));
    assert.ok(lastNotice2);

    // Swarm B was NOT closed
    const swarmBCheck = (await call(user, 'swarm_get', { swarm_id: swarmB.id })).swarm;
    assert.equal(swarmBCheck.status, 'running');

    // 3. Refuse posting to a channel the agent is not a member of
    const { channel: chanA } = await call(user, 'channel_create', {
      name: 'private-chan', scope: 'project:a', members: [] // Agent A is not in members
    });

    await call(user, 'thread_post', { thread_id: agentA.main_thread_id, body: 'Third turn', idempotency_key: 'post-3' });
    const claim3 = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'] });

    await call(worker, 'task_finish', {
      task_id: claim3.task.id,
      lease_token: claim3.lease_token,
      lease_generation: claim3.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Posting to channel.\n\n\`\`\`swarmaa-actions\n[{"type":"channel_post","channel_id":"${chanA.id}","body":"Unauthorized post"}]\n\`\`\``
      }
    });

    const msgs3 = (await call(user, 'thread_read', { thread_id: agentA.main_thread_id })).messages;
    const lastNotice3 = msgs3.find((m: any) => m.kind === 'notice' && m.body.includes('channel_post'));
    assert.ok(lastNotice3);
    assert.ok(lastNotice3.body.includes('not a member'));

    // Channel has no messages
    const chanMsgs = (await call(user, 'thread_read', { thread_id: chanA.id })).messages;
    assert.equal(chanMsgs.length, 0);
  });

  it('channel mention routing: mentioned agent gets turn, unmentioned goes to lead, no lead queues nothing', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:chan']);

    const { agent: ada } = await call(user, 'agent_create', {
      name: 'Ada', role: 'Dev', instructions: 'Ada instructions', scope: 'project:chan', runner: { provider: 'codex' }
    });
    const { agent: linus } = await call(user, 'agent_create', {
      name: 'Linus', role: 'Kernel', instructions: 'Linus instructions', scope: 'project:chan', runner: { provider: 'codex' }
    });

    // Channel 1: Ada and Linus are members, Ada is lead
    const { channel: chan1 } = await call(user, 'channel_create', {
      name: 'general', scope: 'project:chan', members: [ada.id, linus.id], lead_agent_id: ada.id
    });

    // Post 1: mentions @Linus -> queues turn for Linus
    await call(user, 'thread_post', {
      thread_id: chan1.id, body: 'Hey @Linus check this out', idempotency_key: 'cpost-1'
    });

    const linusTasks1 = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [linus.id])).rows;
    assert.equal(linusTasks1.length, 1);
    assert.equal(linusTasks1[0].thread_id, chan1.id);

    const adaTasks1 = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [ada.id])).rows;
    assert.equal(adaTasks1.length, 0);

    // Post 2: mentions nobody -> queues turn for lead (Ada)
    await call(user, 'thread_post', {
      thread_id: chan1.id, body: 'General announcement for anyone', idempotency_key: 'cpost-2'
    });

    const adaTasks2 = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [ada.id])).rows;
    assert.equal(adaTasks2.length, 1);
    assert.equal(adaTasks2[0].thread_id, chan1.id);

    // Channel 2: Ada and Linus are members, NO lead
    const { channel: chan2 } = await call(user, 'channel_create', {
      name: 'nolead', scope: 'project:chan', members: [ada.id, linus.id]
    });

    // Clean task count
    await pool.query('DELETE FROM tasks WHERE tenant_id=$1', [tenantId]);

    // Post to chan2 without mention -> queues NOTHING
    await call(user, 'thread_post', {
      thread_id: chan2.id, body: 'Message into leaderless channel without mention', idempotency_key: 'cpost-3'
    });

    const allTasks = (await pool.query('SELECT * FROM tasks WHERE tenant_id=$1', [tenantId])).rows;
    assert.equal(allTasks.length, 0);
  });

  it('attention_list and task_resolve: returns questions, review tasks, failed tasks, and swarms; resolve clears tasks', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:att']);

    const { agent } = await call(user, 'agent_create', {
      name: 'AttBot', role: 'Assistant', instructions: 'Instructions', scope: 'project:att', runner: { provider: 'codex' }
    });

    // 1. Create an open question
    await pool.query(
      `INSERT INTO questions (id, tenant_id, scope, thread_id, agent_id, prompt, options, multi, free_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, '["Yes","No"]'::jsonb, false, false, 'open')`,
      [randomUUID(), tenantId, 'project:att', agent.main_thread_id, agent.id, 'Are we ready to deploy?']
    );

    // 2. Create a completed review_required patch task
    const reviewTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, result)
       VALUES ($1, $2, $3, 'patch', 'Implement feature X', 'completed', 1, $4, 'k1', 'h1', 3, '{}'::jsonb, 'codex.patch', $5::jsonb)`,
      [reviewTaskId, tenantId, 'project:att', user.id, JSON.stringify({ review_required: true, branch: 'swarmaa/codex/1234', changed_files: 3 })]
    );

    // 3. Create a failed task
    const failedTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, result)
       VALUES ($1, $2, $3, 'turn', 'Draft newsletter', 'failed', 1, $4, 'k2', 'h2', 3, '{}'::jsonb, 'codex.read', $5::jsonb)`,
      [failedTaskId, tenantId, 'project:att', user.id, JSON.stringify({ failure: { code: 'quota_exhausted', detail: 'Rate limit' } })]
    );

    // 4. Create a blocked swarm
    const swarmId = randomUUID();
    await pool.query(
      `INSERT INTO swarms (id, tenant_id, scope, title, goal, thread_id, status, created_by)
       VALUES ($1, $2, $3, 'Blocked Swarm', 'Launch campaign', $4, 'blocked', $5)`,
      [swarmId, tenantId, 'project:att', agent.main_thread_id, user.id]
    );

    // Attention list returns all 4 items
    const attList1 = await call(user, 'attention_list', { scope: 'project:att' });
    assert.equal(attList1.items.length, 4);

    const qItem = attList1.items.find((it: any) => it.kind === 'question');
    assert.ok(qItem);
    assert.equal(qItem.next_step, 'Needs input · answer the question');

    const revItem = attList1.items.find((it: any) => it.id === reviewTaskId);
    assert.ok(revItem);
    assert.ok(revItem.next_step.includes('Ready for review'));
    assert.ok(revItem.next_step.includes('branch swarmaa/codex/1234'));

    const failItem = attList1.items.find((it: any) => it.id === failedTaskId);
    assert.ok(failItem);
    assert.ok(failItem.next_step.includes('Failed · quota_exhausted · retry'));

    const swarmItem = attList1.items.find((it: any) => it.kind === 'swarm');
    assert.ok(swarmItem);
    assert.ok(swarmItem.next_step.includes('Blocked · inspect step failures'));

    // Resolve the review task
    await call(user, 'task_resolve', { task_id: reviewTaskId, resolved: true, expected_version: 1 });

    // Now attention_list has 3 items (reviewTask is gone)
    const attList2 = await call(user, 'attention_list', { scope: 'project:att' });
    assert.equal(attList2.items.length, 3);
    assert.ok(!attList2.items.some((it: any) => it.id === reviewTaskId));

    // task_list filter by resolved works
    const resolvedList = await call(user, 'task_list', { scope: 'project:att', resolved: true });
    assert.equal(resolvedList.tasks.length, 1);
    assert.equal(resolvedList.tasks[0].id, reviewTaskId);

    const unresolvedList = await call(user, 'task_list', { scope: 'project:att', resolved: false });
    assert.ok(unresolvedList.tasks.some((t: any) => t.id === failedTaskId));
  });

  it('flow_start returns swarm_id and creates corresponding swarm and steps', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:flow']);

    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const res = await call(user, 'flow_start', {
      flow: 'independent-review',
      scope: 'project:flow',
      inputs: {
        objective: 'Review auth security',
        commit: commitSha
      },
      idempotency_key: 'flow-key-1'
    });

    assert.ok(res.flow);
    assert.ok(res.swarm_id);
    assert.equal(res.replayed, false);

    // swarm_get returns the swarm created from the flow
    const swarmRes = await call(user, 'swarm_get', { swarm_id: res.swarm_id });
    assert.equal(swarmRes.swarm.id, res.swarm_id);
    assert.equal(swarmRes.swarm.title, 'Independent review');
    assert.ok(swarmRes.swarm.steps.length > 0);

    // Replay returns same swarm_id and replayed: true
    const replayRes = await call(user, 'flow_start', {
      flow: 'independent-review',
      scope: 'project:flow',
      inputs: {
        objective: 'Review auth security',
        commit: commitSha
      },
      idempotency_key: 'flow-key-1'
    });
    assert.equal(replayRes.replayed, true);
    assert.equal(replayRes.swarm_id, res.swarm_id);
  });

  it('stream after=now: receives event: cursor first and delivers subsequent events', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-stream', 'admin', ['project:stream']);

    const { agent } = await call(user, 'agent_create', {
      name: 'StreamBot', role: 'Tester', instructions: 'Inst', scope: 'project:stream', runner: { provider: 'codex' }
    });

    const streamRes = await fetch(`${origin}/api/stream?after=now`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(streamRes.status, 200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    const readNextBlock = async (timeoutMs = 1500): Promise<{ event: string; id?: string; data: Record<string, any> }> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('\n\n')) {
          const parts = buffer.split('\n\n');
          const first = parts.shift()!;
          buffer = parts.join('\n\n');
          const eventMatch = first.match(/^event: ([^\n]+)/m);
          const idMatch = first.match(/^id: ([^\n]+)/m);
          const dataMatch = first.match(/^data: ([^\n]+)/m);
          if (eventMatch && dataMatch) {
            return {
              event: eventMatch[1]!,
              id: idMatch ? idMatch[1] : undefined,
              data: JSON.parse(dataMatch[1]!)
            };
          }
        }
      }
      throw new Error(`Did not receive event within ${timeoutMs}ms`);
    };

    // First event MUST be event: cursor
    const firstEvent = await readNextBlock(2000);
    assert.equal(firstEvent.event, 'cursor');
    assert.ok(firstEvent.data.cursor);

    // Post a message to generate a new event
    await call(user, 'thread_post', {
      thread_id: agent.main_thread_id,
      body: 'Message after stream connected',
      idempotency_key: 'stream-now-1'
    });

    // Stream delivers the message.created event!
    const secondEvent = await readNextBlock(2000);
    assert.equal(secondEvent.event, 'message.created');
    assert.ok(secondEvent.data.payload.message_id);
    assert.equal(secondEvent.data.payload.thread_id, agent.main_thread_id);

    await reader.cancel();
  });

  it('tenant and scope isolation for all new tools', async () => {
    const tenant1 = randomUUID();
    const tenant2 = randomUUID();
    const user1 = await createPrincipal(tenant1, 'user-1', 'admin', ['project:t1']);
    const user2 = await createPrincipal(tenant2, 'user-2', 'admin', ['project:t2']);

    const { agent: a1 } = await call(user1, 'agent_create', {
      name: 'Agent1', role: 'Role1', instructions: 'Inst', scope: 'project:t1', runner: { provider: 'codex' }
    });

    const { swarm: sw1 } = await call(user1, 'swarm_start', {
      title: 'Swarm 1', goal: 'Goal 1', scope: 'project:t1', thread_id: a1.main_thread_id,
      steps: [{ key: 'step1', title: 'Step 1', assignee_agent_id: a1.id, needs: [] }]
    });

    const { channel: chan1 } = await call(user1, 'channel_create', {
      name: 'chan1', scope: 'project:t1', members: [a1.id]
    });

    const isDenied = (err: any) => err.status === 404 || err.status === 403 || err.code === 'not_found' || err.code === 'scope_forbidden';

    // user2 from tenant2 cannot access user1's swarm
    await assert.rejects(async () => {
      await call(user2, 'swarm_get', { swarm_id: sw1.id });
    }, isDenied);

    // user2 cannot update user1's swarm
    await assert.rejects(async () => {
      await call(user2, 'swarm_update', { swarm_id: sw1.id, ops: [{ op: 'close' }] });
    }, isDenied);

    // user2 cannot cancel user1's swarm
    await assert.rejects(async () => {
      await call(user2, 'swarm_cancel', { swarm_id: sw1.id });
    }, isDenied);

    // user2 cannot update user1's channel
    await assert.rejects(async () => {
      await call(user2, 'channel_update', { channel_id: chan1.id, expected_version: 1, name: 'hacked' });
    }, isDenied);

    // Sections are principal-isolated
    await call(user1, 'section_set', { sections: [{ name: 'Section 1', items: ['item1'] }] });
    const u2Sections = (await call(user2, 'section_list', {})).sections;
    assert.equal(u2Sections.length, 0);

    const u1Sections = (await call(user1, 'section_list', {})).sections;
    assert.equal(u1Sections.length, 1);
    assert.equal(u1Sections[0].name, 'Section 1');
  });
});
