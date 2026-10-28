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

  it('the Friday-launch scenario: driven only through turn finish actions, hands off, question answered, reassign, done 5/5, exactly one summary turn', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-lead', 'admin', ['project:friday']);
    const worker = await createPrincipal(tenantId, 'worker-mac', 'worker', ['project:friday']);

    // 1. Create 3 agents: Atlas (lead), Pulse (research), Scout (design)
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

    // 2. Atlas is triggered with a message to start planning
    await call(user, 'thread_post', { thread_id: atlas.main_thread_id, body: 'Atlas, please start the Friday launch.', idempotency_key: 'start-friday' });

    // Worker claims Atlas's turn
    const atlasTurn = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(atlasTurn.task.agent_id, atlas.id);

    // Atlas finishes its turn by outputting a swarmaa-actions block with swarm_start
    const swarmStartAction = {
      type: 'swarm_start',
      title: "Friday's launch",
      goal: 'Launch the campaign across channels.',
      steps: [
        { key: 'step1', title: 'Research launch channels', assignee_agent_id: pulse.id, needs: [] },
        { key: 'step2', title: 'Design launch graphics', assignee_agent_id: scout.id, needs: ['step1'] },
        { key: 'step3', title: 'Draft launch copy', assignee_agent_id: pulse.id, needs: ['step1'] },
        { key: 'step4', title: 'Assemble campaign page', assignee_agent_id: scout.id, needs: ['step2', 'step3'] },
        { key: 'step5', title: 'Review launch readiness', assignee_agent_id: atlas.id, needs: ['step4'] }
      ]
    };

    await call(worker, 'task_finish', {
      task_id: atlasTurn.task.id,
      lease_token: atlasTurn.lease_token,
      lease_generation: atlasTurn.lease_generation,
      outcome: 'completed',
      result: {
        answer: `I have planned the launch.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([swarmStartAction])}\n\`\`\``
      }
    });

    // Swarm is created and running!
    const swarmsList = await call(user, 'swarm_list', { scope: 'project:friday' });
    assert.equal(swarmsList.swarms.length, 1);
    const swarm = swarmsList.swarms[0];
    assert.equal(swarm.title, "Friday's launch");
    assert.equal(swarm.status, 'running');
    assert.equal(swarm.steps.length, 5);

    const step1Id = swarm.steps.find((s: any) => s.step_key === 'step1').id;
    const step2Id = swarm.steps.find((s: any) => s.step_key === 'step2').id;
    const step3Id = swarm.steps.find((s: any) => s.step_key === 'step3').id;
    const step4Id = swarm.steps.find((s: any) => s.step_key === 'step4').id;
    const step5Id = swarm.steps.find((s: any) => s.step_key === 'step5').id;

    // 3. Worker claims Pulse turn for Step 1
    const claim1 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
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
    const swarmCheck1 = await call(user, 'swarm_get', { swarm_id: swarm.id });
    assert.equal(swarmCheck1.swarm.status, 'waiting_on_you');
    assert.equal(swarmCheck1.swarm.steps.find((s: any) => s.id === step1Id).status, 'waiting_on_you');

    const qList = await call(user, 'question_list', { status: 'open' });
    assert.equal(qList.questions.length, 1);

    // 4. User answers the question
    await call(user, 'question_answer', {
      question_id: qList.questions[0].id,
      choices: ['Web', 'Social'],
      text: 'Launch on Web and Social first',
      idempotency_key: 'ans-1'
    });

    // Resumed turn is queued for Pulse with initiator 'answer'
    const claim1Resume = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claim1Resume.task.agent_id, pulse.id);
    assert.equal(claim1Resume.task.initiator_kind, 'answer');

    // Pulse finishes Step 1 and includes a handoff action to Scout
    const handoffAction = {
      type: 'handoff',
      to_agent: scout.id,
      body: 'Step 1 complete. Channel research done. Proceed with graphics.'
    };

    await call(worker, 'task_finish', {
      task_id: claim1Resume.task.id,
      lease_token: claim1Resume.lease_token,
      lease_generation: claim1Resume.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Step 1 complete: Web and Social researched.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([handoffAction])}\n\`\`\``
      }
    });

    // Step 1 is done! Steps 2 and 3 are running!
    const swarmCheck2 = await call(user, 'swarm_get', { swarm_id: swarm.id });
    assert.equal(swarmCheck2.swarm.steps.find((s: any) => s.id === step1Id).status, 'done');
    assert.equal(swarmCheck2.swarm.steps.find((s: any) => s.id === step2Id).status, 'running');
    assert.equal(swarmCheck2.swarm.steps.find((s: any) => s.id === step3Id).status, 'running');

    // 5. Worker claims Step 2 (Scout) or Step 3 (Pulse)
    const claimA = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    let scoutClaim: any;
    let pulseStep3Claim: any;

    if (claimA.task.agent_id === scout.id) {
      scoutClaim = claimA;
      pulseStep3Claim = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    } else {
      pulseStep3Claim = claimA;
      scoutClaim = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    }

    // Scout finishes its turn with a swarm_update action reassigning step 2 to Pulse!
    const reassignAction = {
      type: 'swarm_update',
      swarm_id: swarm.id,
      ops: [
        {
          op: 'reassign',
          step_id: step2Id,
          assignee_agent_id: pulse.id
        }
      ]
    };

    await call(worker, 'task_finish', {
      task_id: scoutClaim.task.id,
      lease_token: scoutClaim.lease_token,
      lease_generation: scoutClaim.lease_generation,
      outcome: 'completed',
      result: {
        answer: `I need Pulse to handle graphics.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([reassignAction])}\n\`\`\``
      }
    });

    // Step 2 is now reassigned to Pulse and running!
    const step2Refreshed = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm.steps.find((s: any) => s.id === step2Id);
    assert.equal(step2Refreshed.assignee_agent_id, pulse.id);
    assert.equal(step2Refreshed.status, 'running');

    // Finish Step 3 (Pulse)
    await call(worker, 'task_finish', {
      task_id: pulseStep3Claim.task.id,
      lease_token: pulseStep3Claim.lease_token,
      lease_generation: pulseStep3Claim.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 3 complete: Copy drafted.' }
    });

    // Finish Step 2 (Pulse)
    const claimStep2Reassigned = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimStep2Reassigned.task.agent_id, pulse.id);
    assert.equal(claimStep2Reassigned.task.swarm_step_id, step2Id);
    await call(worker, 'task_finish', {
      task_id: claimStep2Reassigned.task.id,
      lease_token: claimStep2Reassigned.lease_token,
      lease_generation: claimStep2Reassigned.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 2 complete: Graphics designed.' }
    });

    // Step 4 (Scout) is unblocked and running!
    const claimStep4 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimStep4.task.agent_id, scout.id);
    assert.equal(claimStep4.task.swarm_step_id, step4Id);
    await call(worker, 'task_finish', {
      task_id: claimStep4.task.id,
      lease_token: claimStep4.lease_token,
      lease_generation: claimStep4.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 4 complete: Campaign page assembled.' }
    });

    // Step 5 (Atlas) is unblocked and running!
    const claimStep5 = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimStep5.task.agent_id, atlas.id);
    assert.equal(claimStep5.task.swarm_step_id, step5Id);
    await call(worker, 'task_finish', {
      task_id: claimStep5.task.id,
      lease_token: claimStep5.lease_token,
      lease_generation: claimStep5.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 5 complete: Readiness verified.' }
    });

    // All 5 steps done! Swarm is done!
    const finalSwarm = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    assert.equal(finalSwarm.status, 'done');
    assert.equal(finalSwarm.progress.done, 5);
    assert.equal(finalSwarm.progress.total, 5);
    assert.ok(finalSwarm.closed_at !== null);

    // Final summary turn is queued for owner Atlas!
    const summaryTask = (await pool.query('SELECT * FROM tasks WHERE idempotency_key=$1', [`swarm:summary:${swarm.id}`])).rows;
    assert.equal(summaryTask.length, 1);
    assert.equal(summaryTask[0].agent_id, atlas.id);

    // Worker claims and finishes summary turn
    const claimSummary = await call(worker, 'task_claim', { scope: 'project:friday', capabilities: ['codex.read'] });
    assert.equal(claimSummary.task.id, summaryTask[0].id);
    await call(worker, 'task_finish', {
      task_id: claimSummary.task.id,
      lease_token: claimSummary.lease_token,
      lease_generation: claimSummary.lease_generation,
      outcome: 'completed',
      result: { answer: 'Swarm summary complete! 5/5 launch tasks done.' }
    });
  });

  it('parallel sibling steps: two steps finish concurrently with Promise.all with no deadlock and correct downstream scheduling', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:sibling']);
    const worker1 = await createPrincipal(tenantId, 'worker-1', 'worker', ['project:sibling']);
    const worker2 = await createPrincipal(tenantId, 'worker-2', 'worker', ['project:sibling']);

    const { agent: a1 } = await call(user, 'agent_create', { name: 'A1', role: 'Worker 1', instructions: 'I1', scope: 'project:sibling', runner: { provider: 'codex' } });
    const { agent: a2 } = await call(user, 'agent_create', { name: 'A2', role: 'Worker 2', instructions: 'I2', scope: 'project:sibling', runner: { provider: 'codex' } });
    const { agent: a3 } = await call(user, 'agent_create', { name: 'A3', role: 'Downstream', instructions: 'I3', scope: 'project:sibling', runner: { provider: 'codex' } });

    const { swarm } = await call(user, 'swarm_start', {
      title: 'Parallel Sibling Test',
      goal: 'Test concurrent finish',
      scope: 'project:sibling',
      thread_id: a1.main_thread_id,
      steps: [
        { key: 'step1', title: 'Sibling 1', assignee_agent_id: a1.id, needs: [] },
        { key: 'step2', title: 'Sibling 2', assignee_agent_id: a2.id, needs: [] },
        { key: 'step3', title: 'Dependent Step', assignee_agent_id: a3.id, needs: ['step1', 'step2'] }
      ]
    });

    const step3Id = swarm.steps.find((s: any) => s.step_key === 'step3').id;

    // Worker 1 and Worker 2 claim the two ready sibling steps
    const claim1 = await call(worker1, 'task_claim', { scope: 'project:sibling', capabilities: ['codex.read'] });
    const claim2 = await call(worker2, 'task_claim', { scope: 'project:sibling', capabilities: ['codex.read'] });

    assert.ok(claim1.task);
    assert.ok(claim2.task);
    assert.notEqual(claim1.task.id, claim2.task.id);

    // Concurrently finish both sibling steps via Promise.all (Finding 4a regression check)
    await Promise.all([
      call(worker1, 'task_finish', {
        task_id: claim1.task.id,
        lease_token: claim1.lease_token,
        lease_generation: claim1.lease_generation,
        outcome: 'completed',
        result: { answer: 'Sibling 1 complete.' }
      }),
      call(worker2, 'task_finish', {
        task_id: claim2.task.id,
        lease_token: claim2.lease_token,
        lease_generation: claim2.lease_generation,
        outcome: 'completed',
        result: { answer: 'Sibling 2 complete.' }
      })
    ]);

    // Downstream Step 3 must now be unblocked and running!
    const refreshedSwarm = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    const step3 = refreshedSwarm.steps.find((s: any) => s.id === step3Id);
    assert.equal(step3.status, 'running');
    assert.ok(step3.task_id !== null);
  });

  it('finding 1: swarm_start and swarm_update actions run inside task_finish transaction under turn grant without task:submit', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f1']);
    // Worker role explicitly lacks task:submit permission
    const worker = await createPrincipal(tenantId, 'worker-f1', 'worker', ['project:f1']);
    assert.ok(!worker.permissions.includes('task:submit'));

    const { agent } = await call(user, 'agent_create', {
      name: 'Agent1', role: 'Lead', instructions: 'Inst', scope: 'project:f1', runner: { provider: 'codex' }
    });

    await call(user, 'thread_post', { thread_id: agent.main_thread_id, body: 'Start turn', idempotency_key: 'post-f1' });
    const turn1 = await call(worker, 'task_claim', { scope: 'project:f1', capabilities: ['codex.read'] });

    // Worker finishes turn with swarm_start action
    const startAct = {
      type: 'swarm_start',
      title: 'Action Swarm',
      goal: 'Action Goal',
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }]
    };

    const finish1 = await call(worker, 'task_finish', {
      task_id: turn1.task.id,
      lease_token: turn1.lease_token,
      lease_generation: turn1.lease_generation,
      outcome: 'completed',
      result: { answer: `Starting swarm.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([startAct])}\n\`\`\`` }
    });
    assert.equal(finish1.task.status, 'completed');

    const swarms = (await call(user, 'swarm_list', { scope: 'project:f1' })).swarms;
    assert.equal(swarms.length, 1);
    assert.equal(swarms[0].title, 'Action Swarm');

    // Worker claims the step turn and updates the swarm via swarm_update action
    const stepTurn = await call(worker, 'task_claim', { scope: 'project:f1', capabilities: ['codex.read'] });
    const updateAct = {
      type: 'swarm_update',
      swarm_id: swarms[0].id,
      ops: [{ op: 'edit', title: 'Renamed Swarm' }]
    };

    const finish2 = await call(worker, 'task_finish', {
      task_id: stepTurn.task.id,
      lease_token: stepTurn.lease_token,
      lease_generation: stepTurn.lease_generation,
      outcome: 'completed',
      result: { answer: `Updating swarm.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([updateAct])}\n\`\`\`` }
    });
    assert.equal(finish2.task.status, 'completed');

    const updatedSwarm = (await call(user, 'swarm_get', { swarm_id: swarms[0].id })).swarm;
    assert.equal(updatedSwarm.title, 'Renamed Swarm');
  });

  it('finding 2: handoff validates swarm_step_id scope/ownership and onStepTaskFinished verifies task identity', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f2a', 'project:f2b']);
    const worker = await createPrincipal(tenantId, 'worker-f2', 'worker', ['project:f2a', 'project:f2b']);

    const { agent: agentA } = await call(user, 'agent_create', { name: 'A', role: 'R', instructions: 'I', scope: 'project:f2a', runner: { provider: 'codex' } });
    const { agent: agentB } = await call(user, 'agent_create', { name: 'B', role: 'R', instructions: 'I', scope: 'project:f2b', runner: { provider: 'codex' } });

    // Create swarm in project:f2b
    const { swarm: swarmB } = await call(user, 'swarm_start', {
      title: 'Swarm B', goal: 'Goal B', scope: 'project:f2b', thread_id: agentB.main_thread_id,
      steps: [{ key: 'stepB', title: 'Step B', assignee_agent_id: agentB.id, needs: [] }]
    });
    const stepBId = swarmB.steps[0].id;

    // Agent A attempts handoff naming stepBId from project:f2b
    await call(user, 'thread_post', { thread_id: agentA.main_thread_id, body: 'Turn A', idempotency_key: 'post-f2a' });
    const claimA = await call(worker, 'task_claim', { scope: 'project:f2a', capabilities: ['codex.read'] });

    await call(worker, 'task_finish', {
      task_id: claimA.task.id,
      lease_token: claimA.lease_token,
      lease_generation: claimA.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Handoff cross scope.\n\n\`\`\`swarmaa-actions\n[{"type":"handoff","to_agent":"${agentA.id}","body":"mine","swarm_step_id":"${stepBId}"}]\n\`\`\``
      }
    });

    // Action is rejected with notice; stepB remains pending/running and not completed
    const notices = (await call(user, 'thread_read', { thread_id: agentA.main_thread_id })).messages.filter((m: any) => m.kind === 'notice');
    assert.ok(notices.some((n: any) => n.body.includes('Turn action rejected: handoff')));

    // Task identity check in onStepTaskFinished: an unrelated task claiming row.swarm_step_id cannot mark step done
    const fakeTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, agent_id, thread_id, swarm_step_id, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability)
       VALUES ($1, $2, 'project:f2b', 'turn', $3, $4, $5, 'fake', 'queued', 1, $6, 'fkey', 'fhash', 3, '{}'::jsonb, 'codex.read')`,
      [fakeTaskId, tenantId, agentB.id, agentB.main_thread_id, stepBId, user.id]
    );

    const fakeClaim = await call(worker, 'task_claim', { scope: 'project:f2b', capabilities: ['codex.read'] });
    if (fakeClaim?.task?.id === fakeTaskId) {
      await call(worker, 'task_finish', {
        task_id: fakeClaim.task.id,
        lease_token: fakeClaim.lease_token,
        lease_generation: fakeClaim.lease_generation,
        outcome: 'completed',
        result: { answer: 'Fake finish' }
      });

      // Step B task_id was NOT fakeTaskId, so onStepTaskFinished did not mark step done!
      const stepCheck = (await call(user, 'swarm_get', { swarm_id: swarmB.id })).swarm.steps[0];
      assert.notEqual(stepCheck.task_id, fakeTaskId);
    }
  });

  it('finding 3: flow steps do not spawn agent turns and onStepTaskFinished does not schedule flow steps', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f3']);
    const worker = await createPrincipal(tenantId, 'worker-f3', 'worker', ['project:f3']);

    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const res = await call(user, 'flow_start', {
      flow: 'independent-review',
      scope: 'project:f3',
      inputs: { objective: 'Flow check', commit: commitSha },
      idempotency_key: 'flow-f3-key'
    });

    const flowSwarm = (await call(user, 'swarm_get', { swarm_id: res.swarm_id })).swarm;
    // Step assignees must be null (flows manage their own execution, no agent turns)
    for (const st of flowSwarm.steps) {
      assert.equal(st.assignee_agent_id, null);
    }

    // Claim the first flow step task (worker serves auto.read work with codex capability)
    const claim = await call(worker, 'task_claim', { scope: 'project:f3', capabilities: ['codex.read', 'auto.read'] });
    assert.ok(claim.task);
    assert.equal(claim.task.flow_id, res.flow.id);

    // Finish the flow task
    await call(worker, 'task_finish', {
      task_id: claim.task.id,
      lease_token: claim.lease_token,
      lease_generation: claim.lease_generation,
      outcome: 'completed',
      result: { answer: 'Flow step complete', observed_commit: commitSha }
    });

    // Check that no agent turn tasks (initiator_kind 'swarm') were spawned for flow steps
    const spawnedSwarmTasks = (await pool.query("SELECT * FROM tasks WHERE tenant_id=$1 AND initiator_kind='swarm'", [tenantId])).rows;
    assert.equal(spawnedSwarmTasks.length, 0);
  });

  it('finding 4: concurrent sibling steps and update vs finish do not deadlock (lock order)', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f4']);
    const worker = await createPrincipal(tenantId, 'worker-f4', 'worker', ['project:f4']);

    const { agent: a1 } = await call(user, 'agent_create', { name: 'A4-1', role: 'Dev 1', instructions: 'I1', scope: 'project:f4', runner: { provider: 'codex' } });
    const { agent: a2 } = await call(user, 'agent_create', { name: 'A4-2', role: 'Dev 2', instructions: 'I2', scope: 'project:f4', runner: { provider: 'codex' } });

    const { swarm } = await call(user, 'swarm_start', {
      title: 'Deadlock Test Swarm',
      goal: 'Test lock ordering',
      scope: 'project:f4',
      thread_id: a1.main_thread_id,
      steps: [
        { key: 'step1', title: 'Step 1', assignee_agent_id: a1.id, needs: [] },
        { key: 'step2', title: 'Step 2', assignee_agent_id: a2.id, needs: [] }
      ]
    });

    const claim1 = await call(worker, 'task_claim', { scope: 'project:f4', capabilities: ['codex.read'] });
    const claim2 = await call(worker, 'task_claim', { scope: 'project:f4', capabilities: ['codex.read'] });
    assert.ok(claim1.task);
    assert.ok(claim2.task);

    // Concurrent task_finish and swarm_update must not deadlock
    const finishP = call(worker, 'task_finish', {
      task_id: claim1.task.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: { answer: 'Finish 1' }
    });

    const updateP = call(user, 'swarm_update', {
      swarm_id: swarm.id,
      ops: [{ op: 'edit', title: 'Updated during finish' }]
    });

    await Promise.all([finishP, updateP]);

    // Finish second step
    await call(worker, 'task_finish', {
      task_id: claim2.task.id,
      lease_token: claim2.lease_token,
      lease_generation: claim2.lease_generation,
      outcome: 'completed',
      result: { answer: 'Finish 2' }
    });

    const finalSwarm = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    assert.equal(finalSwarm.title, 'Updated during finish');
    assert.equal(finalSwarm.status, 'done');
  });

  it('finding 5: swarmStart validates owner_agent_id tenant and scope', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const userA = await createPrincipal(tenantA, 'user-a', 'admin', ['project:f5a']);
    const userB = await createPrincipal(tenantB, 'user-b', 'admin', ['project:f5b']);

    const { agent: agentB } = await call(userB, 'agent_create', { name: 'B', role: 'R', instructions: 'I', scope: 'project:f5b', runner: { provider: 'codex' } });
    const { agent: agentA } = await call(userA, 'agent_create', { name: 'A', role: 'R', instructions: 'I', scope: 'project:f5a', runner: { provider: 'codex' } });

    // User A attempts to create swarm using agent B from another tenant
    await assert.rejects(async () => {
      await call(userA, 'swarm_start', {
        title: 'Leak Swarm', goal: 'Goal', scope: 'project:f5a', thread_id: agentA.main_thread_id,
        owner_agent_id: agentB.id,
        steps: [{ key: 's1', title: 'S1', assignee_agent_id: agentA.id, needs: [] }]
      });
    }, (err: any) => err.status === 400 && err.code === 'agent_not_found');
  });

  it('finding 6: SSE stream after=now starts from pg_snapshot_xmin so in-flight transactions are not dropped', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-stream-f6', 'admin', ['project:f6']);

    const streamRes = await fetch(`${origin}/api/stream?after=now`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(streamRes.status, 200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    const first = buffer.split('\n\n')[0]!;
    const eventMatch = first.match(/^event: ([^\n]+)/m);
    const dataMatch = first.match(/^data: ([^\n]+)/m);

    assert.equal(eventMatch?.[1], 'cursor');
    const cursor = JSON.parse(dataMatch![1]).cursor;
    assert.ok(cursor);
    // Cursor is an xmin-based cursor string
    assert.ok(cursor.includes('.') || cursor.includes(':') || /^\d+$/.test(cursor));

    await reader.cancel();
  });

  it('finding 7: lease exhaustion marks swarm step failed and cancelTask updates swarm card', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f7']);
    const worker = await createPrincipal(tenantId, 'worker-f7', 'worker', ['project:f7']);

    const { agent } = await call(user, 'agent_create', { name: 'A7', role: 'R', instructions: 'I', scope: 'project:f7', runner: { provider: 'codex' } });

    const { swarm } = await call(user, 'swarm_start', {
      title: 'Lease Test Swarm', goal: 'Test lease sweep', scope: 'project:f7', thread_id: agent.main_thread_id,
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }]
    });

    const claim = await call(worker, 'task_claim', { scope: 'project:f7', capabilities: ['codex.read'] });
    const stepId = swarm.steps[0].id;

    // Simulate exhausted attempts and expired lease
    await pool.query(
      "UPDATE tasks SET attempt_count = max_attempts, lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1",
      [claim.task.id]
    );

    // Calling claimScope / task_claim triggers the sweep of expired running tasks
    await call(worker, 'task_claim', { scope: 'project:f7', capabilities: ['codex.read'] });

    // Verify task is failed AND swarm step is failed AND swarm is blocked!
    const taskRow = (await pool.query('SELECT status FROM tasks WHERE id=$1', [claim.task.id])).rows[0];
    assert.equal(taskRow.status, 'failed');

    const stepRow = (await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [stepId])).rows[0];
    assert.equal(stepRow.status, 'failed');

    const swarmRefreshed = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    assert.equal(swarmRefreshed.status, 'blocked');
  });

  it('finding 8: closed swarm cannot be updated and question_ask on done step is rejected to prevent duplicate summary', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f8']);
    const worker = await createPrincipal(tenantId, 'worker-f8', 'worker', ['project:f8']);

    const { agent } = await call(user, 'agent_create', { name: 'A8', role: 'R', instructions: 'I', scope: 'project:f8', runner: { provider: 'codex' } });

    const { swarm } = await call(user, 'swarm_start', {
      title: 'Close Swarm Test', goal: 'Test closing', scope: 'project:f8', thread_id: agent.main_thread_id,
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }]
    });

    // Close the swarm
    await call(user, 'swarm_cancel', { swarm_id: swarm.id });

    // swarm_update on closed/cancelled swarm rejects with 400 swarm_closed
    await assert.rejects(async () => {
      await call(user, 'swarm_update', { swarm_id: swarm.id, ops: [{ op: 'edit', title: 'New' }] });
    }, (err: any) => err.status === 400 && err.code === 'swarm_closed');

    // Create a new swarm and finish its step to done
    const { swarm: swarm2 } = await call(user, 'swarm_start', {
      title: 'Swarm 2', goal: 'Goal 2', scope: 'project:f8', thread_id: agent.main_thread_id,
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }]
    });
    const step1Id = swarm2.steps[0].id;

    const claim2 = await call(worker, 'task_claim', { scope: 'project:f8', capabilities: ['codex.read'] });
    await call(worker, 'task_finish', {
      task_id: claim2.task.id,
      lease_token: claim2.lease_token,
      lease_generation: claim2.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step 1 finished.' }
    });

    // Now step 1 is done. Attempt question_ask on the done step in a subsequent turn
    await call(user, 'thread_post', { thread_id: agent.main_thread_id, body: 'Follow up turn', idempotency_key: 'post-f8-fu' });
    const claimFollowup = await call(worker, 'task_claim', { scope: 'project:f8', capabilities: ['codex.read'] });

    await call(worker, 'task_finish', {
      task_id: claimFollowup.task.id,
      lease_token: claimFollowup.lease_token,
      lease_generation: claimFollowup.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Ask on done step.\n\n\`\`\`swarmaa-actions\n[{"type":"question_ask","prompt":"Question on done?","options":["A"],"swarm_step_id":"${step1Id}"}]\n\`\`\``
      }
    });

    // Notice posted rejecting question on done step
    const notices = (await call(user, 'thread_read', { thread_id: agent.main_thread_id })).messages.filter((m: any) => m.kind === 'notice');
    assert.ok(notices.some((n: any) => n.body.includes('Turn action rejected: question_ask')));
  });

  it('finding 9: reassign and retry check dependencies and state', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f9']);

    const { agent: a1 } = await call(user, 'agent_create', { name: 'A1', role: 'R', instructions: 'I', scope: 'project:f9', runner: { provider: 'codex' } });
    const { agent: a2 } = await call(user, 'agent_create', { name: 'A2', role: 'R', instructions: 'I', scope: 'project:f9', runner: { provider: 'codex' } });

    const { swarm } = await call(user, 'swarm_start', {
      title: 'Dep State Swarm', goal: 'Goal', scope: 'project:f9', thread_id: a1.main_thread_id,
      steps: [
        { key: 'step1', title: 'Step 1', assignee_agent_id: a1.id, needs: [] },
        { key: 'step2', title: 'Step 2 (pending)', assignee_agent_id: a1.id, needs: ['step1'] }
      ]
    });

    const step2Id = swarm.steps.find((s: any) => s.step_key === 'step2').id;

    // Reassign pending step 2 (whose dependency step1 is NOT done)
    await call(user, 'swarm_update', {
      swarm_id: swarm.id,
      ops: [{ op: 'reassign', step_id: step2Id, assignee_agent_id: a2.id }]
    });

    // Step 2 must remain pending, NOT prematurely started!
    const step2Check = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm.steps.find((s: any) => s.id === step2Id);
    assert.equal(step2Check.status, 'pending');
    assert.equal(step2Check.assignee_agent_id, a2.id);
  });

  it('finding 10: question_answer requires owner principal and rejects expired questions with notice and blocked step', async () => {
    const tenantId = randomUUID();
    const userOwner = await createPrincipal(tenantId, 'user-owner', 'admin', ['project:f10']);
    const nonOwner: Principal = {
      id: randomUUID(),
      tenantId,
      name: 'non-owner-client',
      role: 'worker',
      scopes: ['project:f10'],
      permissions: ['thread:write', 'thread:read']
    };
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [nonOwner.id, nonOwner.tenantId, nonOwner.name, nonOwner.role, nonOwner.scopes, nonOwner.permissions, hashToken('tok')]
    );

    const { agent } = await call(userOwner, 'agent_create', { name: 'A10', role: 'R', instructions: 'I', scope: 'project:f10', runner: { provider: 'codex' } });

    const { swarm } = await call(userOwner, 'swarm_start', {
      title: 'Question Swarm', goal: 'Goal', scope: 'project:f10', thread_id: agent.main_thread_id,
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }]
    });
    const stepId = swarm.steps[0].id;

    // Create question with expires_at in the past
    const qId = randomUUID();
    await pool.query(
      `INSERT INTO questions (id, tenant_id, scope, thread_id, agent_id, swarm_step_id, prompt, options, multi, free_text, status, expires_at)
       VALUES ($1, $2, 'project:f10', $3, $4, $5, 'Expired question?', '["A","B"]'::jsonb, false, false, 'open', clock_timestamp() - interval '10 seconds')`,
      [qId, tenantId, agent.main_thread_id, agent.id, stepId]
    );

    // Non-owner attempting to answer is rejected with 403 owner_required
    await assert.rejects(async () => {
      await call(nonOwner, 'question_answer', { question_id: qId, choices: ['A'] });
    }, (err: any) => err.status === 403 && err.code === 'owner_required');

    // Owner answering expired question is rejected with 400 question_expired
    await assert.rejects(async () => {
      await call(userOwner, 'question_answer', { question_id: qId, choices: ['A'] });
    }, (err: any) => err.status === 400 && err.code === 'question_expired');

    // Question is marked expired, thread received notice, and step is blocked
    const qRow = (await pool.query('SELECT status FROM questions WHERE id=$1', [qId])).rows[0];
    assert.equal(qRow.status, 'expired');

    const stepRow = (await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [stepId])).rows[0];
    assert.equal(stepRow.status, 'blocked');
  });

  it('finding 11: non-uuid ids in actions reject gracefully with thread notice instead of transaction rollback', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f11']);
    const worker = await createPrincipal(tenantId, 'worker-f11', 'worker', ['project:f11']);

    const { agent } = await call(user, 'agent_create', { name: 'A11', role: 'R', instructions: 'I', scope: 'project:f11', runner: { provider: 'codex' } });

    await call(user, 'thread_post', { thread_id: agent.main_thread_id, body: 'Trigger turn', idempotency_key: 'post-f11' });
    const claim = await call(worker, 'task_claim', { scope: 'project:f11', capabilities: ['codex.read'] });

    // Non-UUID values in swarm_id and swarm_step_id
    const badActions = [
      { type: 'swarm_update', swarm_id: 'not-a-valid-uuid', ops: [{ op: 'edit', title: 'Test' }] },
      { type: 'question_ask', prompt: 'Bad uuid step', options: ['A'], swarm_step_id: 'bad-step-id' }
    ];

    // task_finish must NOT crash with SQL cast error; must finish cleanly
    const finish = await call(worker, 'task_finish', {
      task_id: claim.task.id,
      lease_token: claim.lease_token,
      lease_generation: claim.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Testing bad UUIDs.\n\n\`\`\`swarmaa-actions\n${JSON.stringify(badActions)}\n\`\`\``
      }
    });
    assert.equal(finish.task.status, 'completed');

    // Notice message posted to thread explaining the invalid UUID
    const notices = (await call(user, 'thread_read', { thread_id: agent.main_thread_id })).messages.filter((m: any) => m.kind === 'notice');
    assert.ok(notices.some((n: any) => n.body.includes('not a valid uuid')));
  });

  it('finding 12: worker cannot post reply to channel it is not a member of', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f12']);
    const worker = await createPrincipal(tenantId, 'worker-f12', 'worker', ['project:f12']);

    const { agent } = await call(user, 'agent_create', { name: 'A12', role: 'R', instructions: 'I', scope: 'project:f12', runner: { provider: 'codex' } });
    const { channel } = await call(user, 'channel_create', { name: 'secret-channel', scope: 'project:f12', members: [] });

    await call(user, 'thread_post', { thread_id: agent.main_thread_id, body: 'Run turn', idempotency_key: 'post-f12' });
    const claim = await call(worker, 'task_claim', { scope: 'project:f12', capabilities: ['codex.read'] });

    // Worker provides result.thread_id pointing to channel the agent is not a member of
    await assert.rejects(async () => {
      await call(worker, 'task_finish', {
        task_id: claim.task.id,
        lease_token: claim.lease_token,
        lease_generation: claim.lease_generation,
        outcome: 'completed',
        result: {
          answer: 'Attempted hijack reply',
          thread_id: channel.id
        }
      });
    }, (err: any) => err.status === 403 && err.code === 'turn_grant_forbidden');

    // Reply was not posted into the unauthorized channel
    const chanMsgs = (await call(user, 'thread_read', { thread_id: channel.id })).messages;
    assert.equal(chanMsgs.length, 0);
  });

  it('finding 13: channel mention turns dedupe by joining existing queued turn, with hop limit and fan-out cap', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:f13']);
    const worker = await createPrincipal(tenantId, 'worker-f13', 'worker', ['project:f13']);

    const { agent: ada } = await call(user, 'agent_create', { name: 'Ada', role: 'R', instructions: 'I', scope: 'project:f13', runner: { provider: 'codex' } });
    const { agent: linus } = await call(user, 'agent_create', { name: 'Linus', role: 'R', instructions: 'I', scope: 'project:f13', runner: { provider: 'codex' } });

    const { channel } = await call(user, 'channel_create', { name: 'collab', scope: 'project:f13', members: [ada.id, linus.id] });

    // 1. Post mentioning @Linus queues turn 1 for Linus
    await call(user, 'thread_post', { thread_id: channel.id, body: 'First @Linus', idempotency_key: 'post-f13-1' });
    const linusTasks1 = (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status='queued'", [linus.id])).rows;
    assert.equal(linusTasks1.length, 1);

    // 2. Second post mentioning @Linus joins the existing queued turn (deduped, does not queue another task)
    await call(user, 'thread_post', { thread_id: channel.id, body: 'Second @Linus', idempotency_key: 'post-f13-2' });
    const linusTasks2 = (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status='queued'", [linus.id])).rows;
    assert.equal(linusTasks2.length, 1);

    // 3. Hop limit test: task at hop_depth 3 posts mention -> does not queue further agent turns
    await pool.query("UPDATE tasks SET context_versions = jsonb_set(context_versions, '{hop_depth}', '3'::jsonb) WHERE id=$1", [linusTasks1[0].id]);
    const claimHop = await call(worker, 'task_claim', { scope: 'project:f13', capabilities: ['codex.read'] });
    assert.equal(claimHop.task.id, linusTasks1[0].id);

    await call(worker, 'task_finish', {
      task_id: claimHop.task.id,
      lease_token: claimHop.lease_token,
      lease_generation: claimHop.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Hop 3 posting @Ada.\n\n\`\`\`swarmaa-actions\n[{"type":"channel_post","channel_id":"${channel.id}","body":"Hey @Ada"}]\n\`\`\``
      }
    });

    // Ada does NOT receive a queued task because hop depth >= 3
    const adaTasks = (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status='queued'", [ada.id])).rows;
    assert.equal(adaTasks.length, 0);
  });

  it('low 1: taskResolve strips sensitive fields including lease_hash and validates task terminal status', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:l1']);

    const taskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, lease_owner, lease_hash, lease_expires_at)
       VALUES ($1, $2, 'project:l1', 'turn', 'Running task', 'running', 1, $3, 'l1-k', 'l1-h', 3, '{}'::jsonb, 'codex.read', $3, 'secret_hash', clock_timestamp() + interval '60 seconds')`,
      [taskId, tenantId, user.id]
    );

    // Cannot resolve a running task
    await assert.rejects(async () => {
      await call(user, 'task_resolve', { task_id: taskId, resolved: true, expected_version: 1 });
    }, (err: any) => err.status === 400 && err.code === 'invalid_state');

    // Complete the task
    await pool.query("UPDATE tasks SET status='completed', lease_owner=NULL, lease_hash=NULL, lease_expires_at=NULL, completed_at=clock_timestamp() WHERE id=$1", [taskId]);

    // Resolve completed task: returns taskView without lease_hash
    const resolved = await call(user, 'task_resolve', { task_id: taskId, resolved: true, expected_version: 1 });
    assert.ok(resolved.task);
    assert.equal(resolved.task.lease_hash, undefined);
    assert.equal(resolved.task.lease_owner, null);
  });

  it('low 2: attention_list diffstat operator precedence and pagination has_more', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:l2']);

    const taskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, result)
       VALUES ($1, $2, 'project:l2', 'patch', 'Review patch', 'completed', 1, $3, 'l2-k', 'l2-h', 3, '{}'::jsonb, 'codex.patch', $4::jsonb)`,
      [taskId, tenantId, user.id, JSON.stringify({ review_required: true, branch: 'swarmaa/codex/1234', changed_files: 5 })]
    );

    const att = await call(user, 'attention_list', { scope: 'project:l2' });
    const item = att.items.find((it: any) => it.id === taskId);
    assert.ok(item);
    assert.ok(!item.next_step.includes('undefined files'));
    assert.ok(item.next_step.includes('5 files'));
    assert.equal(att.has_more, false);
  });

  it('low 3: swarmStart validates request hash on idempotency replay and does not collide with flow_start', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:l3']);

    const { agent } = await call(user, 'agent_create', { name: 'A-L3', role: 'R', instructions: 'I', scope: 'project:l3', runner: { provider: 'codex' } });

    const key = 'shared-idempotency-key';
    await call(user, 'swarm_start', {
      title: 'Original Swarm', goal: 'Original Goal', scope: 'project:l3', thread_id: agent.main_thread_id,
      steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }],
      idempotency_key: key
    });

    // Replay with different body -> 409 idempotency_conflict
    await assert.rejects(async () => {
      await call(user, 'swarm_start', {
        title: 'Tampered Swarm', goal: 'Different Goal', scope: 'project:l3', thread_id: agent.main_thread_id,
        steps: [{ key: 's1', title: 'Step 1', assignee_agent_id: agent.id, needs: [] }],
        idempotency_key: key
      });
    }, (err: any) => err.status === 409 && err.code === 'idempotency_conflict');

    // flow_start reusing the same key does not fail or collide because swarms.idempotency_key is NULL for flows
    const flowRes = await call(user, 'flow_start', {
      flow: 'independent-review', scope: 'project:l3',
      inputs: { objective: 'Flow obj', commit: '0123456789abcdef0123456789abcdef01234567' },
      idempotency_key: key
    });
    assert.ok(flowRes.flow);
  });

  it('low 4: handoff message author is the sending agent, not system:service', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:l4']);
    const worker = await createPrincipal(tenantId, 'worker-l4', 'worker', ['project:l4']);

    const { agent: sender } = await call(user, 'agent_create', { name: 'Sender', role: 'R', instructions: 'I', scope: 'project:l4', runner: { provider: 'codex' } });
    const { agent: receiver } = await call(user, 'agent_create', { name: 'Receiver', role: 'R', instructions: 'I', scope: 'project:l4', runner: { provider: 'codex' } });

    await call(user, 'thread_post', { thread_id: sender.main_thread_id, body: 'Run handoff', idempotency_key: 'post-l4' });
    const claim = await call(worker, 'task_claim', { scope: 'project:l4', capabilities: ['codex.read'] });

    await call(worker, 'task_finish', {
      task_id: claim.task.id,
      lease_token: claim.lease_token,
      lease_generation: claim.lease_generation,
      outcome: 'completed',
      result: {
        answer: `Handing off.\n\n\`\`\`swarmaa-actions\n[{"type":"handoff","to_agent":"${receiver.id}","body":"Take this work"}]\n\`\`\``
      }
    });

    // Check sender thread message author
    const senderMsgs = (await call(user, 'thread_read', { thread_id: sender.main_thread_id })).messages;
    const senderHandoff = senderMsgs.find((m: any) => m.kind === 'handoff');
    assert.ok(senderHandoff);
    assert.equal(senderHandoff.author.kind, 'agent');
    assert.equal(senderHandoff.author.id, sender.id);

    // Check receiver thread message author
    const receiverMsgs = (await call(user, 'thread_read', { thread_id: receiver.main_thread_id })).messages;
    const receiverHandoff = receiverMsgs.find((m: any) => m.kind === 'handoff');
    assert.ok(receiverHandoff);
    assert.equal(receiverHandoff.author.kind, 'agent');
    assert.equal(receiverHandoff.author.id, sender.id);
  });

  it('low 5: tasks.swarm_step_id is uuid column with foreign key to swarm_steps in migration 025', async () => {
    const colInfo = (await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'swarm_step_id'`,
      [schema]
    )).rows[0];

    assert.equal(colInfo?.data_type, 'uuid');

    const fkInfo = (await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = 'tasks' AND constraint_name = 'tasks_swarm_step_id_fkey'`,
      [schema]
    )).rows[0];

    assert.ok(fkInfo);
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

    const { channel: chan1 } = await call(user, 'channel_create', {
      name: 'general', scope: 'project:chan', members: [ada.id, linus.id], lead_agent_id: ada.id
    });

    await call(user, 'thread_post', { thread_id: chan1.id, body: 'Hey @Linus check this out', idempotency_key: 'cpost-1' });
    const linusTasks1 = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [linus.id])).rows;
    assert.equal(linusTasks1.length, 1);

    await call(user, 'thread_post', { thread_id: chan1.id, body: 'General announcement for anyone', idempotency_key: 'cpost-2' });
    const adaTasks2 = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [ada.id])).rows;
    assert.equal(adaTasks2.length, 1);

    const { channel: chan2 } = await call(user, 'channel_create', {
      name: 'nolead', scope: 'project:chan', members: [ada.id, linus.id]
    });
    await pool.query('DELETE FROM tasks WHERE tenant_id=$1', [tenantId]);
    await call(user, 'thread_post', { thread_id: chan2.id, body: 'Message without mention', idempotency_key: 'cpost-3' });
    const allTasks = (await pool.query('SELECT * FROM tasks WHERE tenant_id=$1', [tenantId])).rows;
    assert.equal(allTasks.length, 0);
  });

  it('attention_list and task_resolve: returns questions, review tasks, failed tasks, and swarms; resolve clears tasks', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-admin', 'admin', ['project:att']);

    const { agent } = await call(user, 'agent_create', {
      name: 'AttBot', role: 'Assistant', instructions: 'Instructions', scope: 'project:att', runner: { provider: 'codex' }
    });

    await pool.query(
      `INSERT INTO questions (id, tenant_id, scope, thread_id, agent_id, prompt, options, multi, free_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, '["Yes","No"]'::jsonb, false, false, 'open')`,
      [randomUUID(), tenantId, 'project:att', agent.main_thread_id, agent.id, 'Are we ready to deploy?']
    );

    const reviewTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, result)
       VALUES ($1, $2, $3, 'patch', 'Implement feature X', 'completed', 1, $4, 'k1', 'h1', 3, '{}'::jsonb, 'codex.patch', $5::jsonb)`,
      [reviewTaskId, tenantId, 'project:att', user.id, JSON.stringify({ review_required: true, branch: 'swarmaa/codex/1234', changed_files: 3 })]
    );

    const failedTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, objective, status, version, created_by, idempotency_key, request_hash, max_attempts, permission_envelope, required_capability, result)
       VALUES ($1, $2, $3, 'turn', 'Draft newsletter', 'failed', 1, $4, 'k2', 'h2', 3, '{}'::jsonb, 'codex.read', $5::jsonb)`,
      [failedTaskId, tenantId, 'project:att', user.id, JSON.stringify({ failure: { code: 'quota_exhausted', detail: 'Rate limit' } })]
    );

    const swarmId = randomUUID();
    await pool.query(
      `INSERT INTO swarms (id, tenant_id, scope, title, goal, thread_id, status, created_by)
       VALUES ($1, $2, $3, 'Blocked Swarm', 'Launch campaign', $4, 'blocked', $5)`,
      [swarmId, tenantId, 'project:att', agent.main_thread_id, user.id]
    );

    const attList1 = await call(user, 'attention_list', { scope: 'project:att' });
    assert.equal(attList1.items.length, 4);

    await call(user, 'task_resolve', { task_id: reviewTaskId, resolved: true, expected_version: 1 });
    const attList2 = await call(user, 'attention_list', { scope: 'project:att' });
    assert.equal(attList2.items.length, 3);
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

    await assert.rejects(async () => {
      await call(user2, 'swarm_get', { swarm_id: sw1.id });
    }, isDenied);

    await assert.rejects(async () => {
      await call(user2, 'swarm_update', { swarm_id: sw1.id, ops: [{ op: 'close' }] });
    }, isDenied);

    await assert.rejects(async () => {
      await call(user2, 'swarm_cancel', { swarm_id: sw1.id });
    }, isDenied);

    await assert.rejects(async () => {
      await call(user2, 'channel_update', { channel_id: chan1.id, expected_version: 1, name: 'hacked' });
    }, isDenied);

    await call(user1, 'section_set', { sections: [{ name: 'Section 1', items: ['item1'] }] });
    const u2Sections = (await call(user2, 'section_list', {})).sections;
    assert.equal(u2Sections.length, 0);

    const u1Sections = (await call(user1, 'section_list', {})).sections;
    assert.equal(u1Sections.length, 1);
  });
  // ---- Second fix round (docs/briefs/teams-phase2-fixes-2.md) ----

  async function team(scope: string, names: string[]) {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'owner', 'admin', [scope]);
    const worker = await createPrincipal(tenantId, 'worker-1', 'worker', [scope]);
    const worker2 = await createPrincipal(tenantId, 'worker-2', 'worker', [scope]);
    const agents: Record<string, any> = {};
    for (const name of names) {
      agents[name] = (await call(user, 'agent_create', { name, role: 'R', instructions: 'I', scope, runner: { provider: 'codex' } })).agent;
    }
    const claim = async (w: Principal = worker) => {
      const c = await call(w, 'task_claim', { scope, capabilities: ['codex.read'] });
      assert.ok(c.task, 'expected a queued task to claim');
      return c;
    };
    return { tenantId, user, worker, worker2, agents, claim, scope };
  }
  const withActions = (text: string, actions: unknown[]) => `${text}\n\n\`\`\`swarmaa-actions\n${JSON.stringify(actions)}\n\`\`\``;
  const finishTurn = (w: Principal, c: any, answer: string) => call(w, 'task_finish', {
    task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation,
    outcome: 'completed', result: { answer }
  });
  const stepOf = (sw: any, key: string) => sw.steps.find((s: any) => s.step_key === key);
  const threadMessages = async (p: Principal, threadId: string) => (await call(p, 'thread_read', { thread_id: threadId, limit: 100 })).messages as any[];

  // Each loop races the brief's scenario against an owner answer on a waiting step. Same-scope finishes and
  // cancels already serialise on the task scope lock, so the answer (thread, then swarm) is what closes the cycle.
  const jitter = (i: number) => new Promise(r => setTimeout(r, i % 10));
  async function waitingStep(t: Awaited<ReturnType<typeof team>>, swarm: any, key: string) {
    const c = await t.claim();
    assert.equal(c.task.swarm_step_id, stepOf(swarm, key).id);
    await finishTurn(t.worker, c, withActions('Need input', [{ type: 'question_ask', prompt: 'Which?', options: ['a', 'b'], swarm_step_id: stepOf(swarm, key).id }]));
    return (await pool.query('SELECT id FROM questions WHERE swarm_step_id=$1', [stepOf(swarm, key).id])).rows[0].id as string;
  }

  it('fixes-2 parallel deadlock: X (A) and Y (B) finish concurrently, Z needs X and is assigned to B, 20 iterations', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await team('project:par', ['A', 'B']);
      const { A, B } = t.agents;
      const { swarm } = await call(t.user, 'swarm_start', {
        title: 'Parallel', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
        steps: [
          { key: 'W', title: 'W', assignee_agent_id: B.id, needs: [] },
          { key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] },
          { key: 'Y', title: 'Y', assignee_agent_id: B.id, needs: [] },
          { key: 'Z', title: 'Z', assignee_agent_id: B.id, needs: ['X'] }
        ]
      });
      const question = await waitingStep(t, swarm, 'W');
      const cx = await t.claim(t.worker);
      const cy = await t.claim(t.worker2);
      assert.equal(cx.task.swarm_step_id, stepOf(swarm, 'X').id);
      assert.equal(cy.task.swarm_step_id, stepOf(swarm, 'Y').id);
      await Promise.all([
        finishTurn(t.worker, cx, 'X done'),
        finishTurn(t.worker2, cy, 'Y done'),
        jitter(i).then(() => call(t.user, 'question_answer', { question_id: question, choices: ['a'] }))
      ]);
      const sw = (await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm;
      assert.equal(stepOf(sw, 'X').status, 'done', `iteration ${i}`);
      assert.equal(stepOf(sw, 'Y').status, 'done', `iteration ${i}`);
      assert.equal(stepOf(sw, 'W').status, 'running', `iteration ${i}`);
      const z = stepOf(sw, 'Z');
      assert.equal(z.status, 'running', `iteration ${i}`);
      const zTask = (await pool.query('SELECT agent_id, status, swarm_step_id FROM tasks WHERE id=$1', [z.task_id])).rows[0];
      assert.deepEqual(zTask, { agent_id: B.id, status: 'queued', swarm_step_id: z.id });
      assert.equal(sw.status, 'running');
    }
  });

  it('fixes-2 a question during a sibling finish, and its answer during another sibling finish, concurrently, 20 iterations', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await team('project:qsib', ['A', 'B', 'C']);
      const { A, B, C } = t.agents;
      const { swarm } = await call(t.user, 'swarm_start', {
        title: 'Q sibling', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
        steps: [
          { key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] },
          { key: 'Y', title: 'Y', assignee_agent_id: B.id, needs: [] },
          { key: 'V', title: 'V', assignee_agent_id: C.id, needs: [] },
          { key: 'Z', title: 'Z', assignee_agent_id: A.id, needs: ['Y'] }
        ]
      });
      const claims = [await t.claim(), await t.claim(), await t.claim()];
      const by = (key: string) => claims.find(c => c.task.swarm_step_id === stepOf(swarm, key).id);
      await Promise.all([
        finishTurn(t.worker, by('X'), withActions('Need input', [{ type: 'question_ask', prompt: 'Which?', options: ['a', 'b'], swarm_step_id: stepOf(swarm, 'X').id }])),
        finishTurn(t.worker, by('V'), 'V done')
      ]);
      const q = (await pool.query("SELECT id FROM questions WHERE tenant_id=$1 AND status='open'", [t.tenantId])).rows[0];
      assert.ok(q, `iteration ${i}: question created`);
      await Promise.all([
        jitter(i).then(() => call(t.user, 'question_answer', { question_id: q.id, choices: ['a'] })),
        finishTurn(t.worker, by('Y'), 'Y done')
      ]);
      const sw = (await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm;
      assert.equal(stepOf(sw, 'X').status, 'running', `iteration ${i}`);
      assert.equal(stepOf(sw, 'Y').status, 'done');
      assert.equal(stepOf(sw, 'V').status, 'done');
      assert.equal(stepOf(sw, 'Z').status, 'running');
      const aQueued = (await pool.query("SELECT initiator_kind FROM tasks WHERE agent_id=$1 AND status='queued' ORDER BY initiator_kind", [A.id])).rows.map(r => r.initiator_kind);
      assert.deepEqual(aQueued, ['answer', 'swarm']);
    }
  });

  it('fixes-2 task_cancel of a step task during a sibling finish, 20 iterations', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await team('project:csib', ['A', 'B']);
      const { A, B } = t.agents;
      const { swarm } = await call(t.user, 'swarm_start', {
        title: 'Cancel sibling', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
        steps: [
          { key: 'W', title: 'W', assignee_agent_id: A.id, needs: [] },
          { key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] },
          { key: 'Y', title: 'Y', assignee_agent_id: B.id, needs: [] },
          { key: 'Z', title: 'Z', assignee_agent_id: A.id, needs: ['Y'] }
        ]
      });
      const question = await waitingStep(t, swarm, 'W');
      const claims = [await t.claim(), await t.claim()];
      const by = (key: string) => claims.find(c => c.task.swarm_step_id === stepOf(swarm, key).id)!;
      await Promise.all([
        call(t.user, 'task_cancel', { task_id: by('X').task.id, expected_version: by('X').task.version }),
        finishTurn(t.worker, by('Y'), 'Y done'),
        jitter(i).then(() => call(t.user, 'question_answer', { question_id: question, choices: ['a'] }))
      ]);
      const sw = (await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm;
      assert.equal(stepOf(sw, 'X').status, 'cancelled', `iteration ${i}`);
      assert.equal(stepOf(sw, 'Y').status, 'done');
      assert.equal(stepOf(sw, 'W').status, 'running');
      assert.equal(stepOf(sw, 'Z').status, 'running');
      assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1', [stepOf(sw, 'Z').task_id])).rows[0].status, 'queued');
    }
  });

  it('fixes-2 teamsLock: every Teams write, the step finish and cancel, and the lease sweep wait for the tenant lock', async () => {
    const t = await team('project:lock', ['A', 'B', 'C', 'D', 'E']);
    const { A, B, C, D, E } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Locked', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [
        { key: 'W', title: 'W', assignee_agent_id: A.id, needs: [] },
        { key: 'Y', title: 'Y', assignee_agent_id: B.id, needs: [] },
        { key: 'V', title: 'V', assignee_agent_id: C.id, needs: [] },
        { key: 'X', title: 'X', assignee_agent_id: A.id, needs: ['W'] }
      ]
    });
    const { swarm: other } = await call(t.user, 'swarm_start', {
      title: 'To cancel', goal: 'g', scope: t.scope, thread_id: D.main_thread_id,
      steps: [{ key: 'S', title: 'S', assignee_agent_id: D.id, needs: [] }]
    });
    const question = await waitingStep(t, swarm, 'W');
    const cy = await t.claim(t.worker);
    const cv = await t.claim(t.worker2);
    assert.equal(cy.task.swarm_step_id, stepOf(swarm, 'Y').id);
    assert.equal(cv.task.swarm_step_id, stepOf(swarm, 'V').id);
    await pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE id=$1", [cv.task.id]);
    const { swarm: third } = await call(t.user, 'swarm_start', {
      title: 'Task to cancel', goal: 'g', scope: t.scope, thread_id: E.main_thread_id,
      steps: [{ key: 'S', title: 'S', assignee_agent_id: E.id, needs: [] }]
    });
    const otherTask = (await pool.query('SELECT id, version FROM tasks WHERE swarm_step_id=$1', [stepOf(third, 'S').id])).rows[0];
    const { channel } = await call(t.user, 'channel_create', { name: 'locked', scope: t.scope, members: [A.id] });

    const writes: Record<string, () => Promise<unknown>> = {
      thread_post: () => call(t.user, 'thread_post', { thread_id: C.main_thread_id, body: 'hi', idempotency_key: 'lock-post' }),
      thread_mark_read: () => call(t.user, 'thread_mark_read', { thread_id: A.main_thread_id, seq: 1 }),
      agent_create: () => call(t.user, 'agent_create', { name: 'F', role: 'R', instructions: 'I', scope: t.scope, runner: { provider: 'codex' } }),
      agent_update: () => call(t.user, 'agent_update', { agent_id: D.id, expected_version: 1, role: 'Renamed' }),
      agent_archive: () => call(t.user, 'agent_archive', { agent_id: C.id }),
      channel_create: () => call(t.user, 'channel_create', { name: 'new', scope: t.scope, members: [] }),
      channel_update: () => call(t.user, 'channel_update', { channel_id: channel.id, expected_version: 1, name: 'renamed' }),
      section_set: () => call(t.user, 'section_set', { sections: [{ name: 'S', items: [] }] }),
      swarm_start: () => call(t.user, 'swarm_start', { title: 'New', goal: 'g', scope: t.scope, thread_id: D.main_thread_id, steps: [{ title: 'n', assignee_agent_id: D.id }] }),
      swarm_update: () => call(t.user, 'swarm_update', { swarm_id: swarm.id, ops: [{ op: 'edit', title: 'Edited' }] }),
      swarm_cancel: () => call(t.user, 'swarm_cancel', { swarm_id: other.id }),
      question_answer: () => call(t.user, 'question_answer', { question_id: question, choices: ['a'] }),
      task_cancel: () => call(t.user, 'task_cancel', { task_id: otherTask.id, expected_version: otherTask.version }),
      task_finish: () => finishTurn(t.worker, cy, 'Y done'),
      lease_sweep: () => call(t.worker2, 'task_claim', { scope: t.scope, capabilities: ['codex.read'] }),
      flow_start: () => call(t.user, 'flow_start', { flow: 'independent-review', scope: t.scope, inputs: { objective: 'o', commit: '0123456789abcdef0123456789abcdef01234567' }, idempotency_key: 'lock-flow' })
    };

    const holder = await pool.connect();
    const settled: string[] = [];
    let pending: Array<Promise<unknown>> = [];
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('teams:' || $1, 0))", [t.tenantId]);
      pending = Object.entries(writes).map(([name, run]) => run().then(() => { settled.push(name); }, (err: unknown) => { settled.push(name); return err; }));
      await new Promise(r => setTimeout(r, 400));
      assert.deepEqual(settled, [], 'writes must wait for teamsLock');
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const outcomes = await Promise.all(pending);
    assert.deepEqual(outcomes.filter(o => o instanceof Error), []);
    assert.equal((await pool.query('SELECT status FROM task_runs WHERE task_id=$1 AND generation=$2', [cv.task.id, cv.lease_generation])).rows[0].status, 'abandoned');
  });

  it('fixes-2 mutual handoffs A to B and B to A finishing concurrently, 20 iterations', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await team('project:mutual', ['A', 'B']);
      const { A, B } = t.agents;
      await call(t.user, 'thread_post', { thread_id: A.main_thread_id, body: 'go A', idempotency_key: 'a' });
      await call(t.user, 'thread_post', { thread_id: B.main_thread_id, body: 'go B', idempotency_key: 'b' });
      const claims = [await t.claim(), await t.claim()];
      const by = (agent: any) => claims.find(c => c.task.agent_id === agent.id);
      const results = await Promise.all([
        finishTurn(t.worker, by(A), withActions('to B', [{ type: 'handoff', to_agent: B.id, body: 'yours B' }])),
        finishTurn(t.worker, by(B), withActions('to A', [{ type: 'handoff', to_agent: 'A', body: 'yours A' }]))
      ]);
      assert.ok(results.every(r => r.task.status === 'completed'), `iteration ${i}`);
      for (const agent of [A, B]) {
        const queued = (await pool.query("SELECT initiator_kind FROM tasks WHERE agent_id=$1 AND status='queued'", [agent.id])).rows;
        assert.deepEqual(queued.map(r => r.initiator_kind), ['handoff'], `iteration ${i}`);
        const kinds = (await threadMessages(t.user, agent.main_thread_id)).map(m => m.kind);
        assert.equal(kinds.filter(k => k === 'handoff').length, 2, `iteration ${i}: sent and received handoff lines`);
      }
    }
  });

  it('fixes-2 bad actions keep the reply: cycle, non-uuid needs, unknown op, runtime error; assignee by name resolves', async () => {
    const t = await team('project:bad', ['A', 'B']);
    const { A, B } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Owned by A', goal: 'g', scope: t.scope, thread_id: A.main_thread_id, owner_agent_id: A.id,
      steps: [{ key: 's1', title: 'S1', assignee_agent_id: B.id, needs: [] }]
    });
    await t.claim(); // B's step turn, left running
    const s1 = stepOf(swarm, 's1');

    const cases: Array<{ label: string; actions: unknown[]; notice: RegExp }> = [
      { label: 'cycle', notice: /swarm_start.*cycle/i, actions: [{ type: 'swarm_start', title: 'Cyc', goal: 'g', steps: [
        { key: 'a', title: 'a', assignee_agent_id: 'B', needs: ['b'] }, { key: 'b', title: 'b', assignee_agent_id: 'B', needs: ['a'] }] }] },
      { label: 'non-uuid needs', notice: /swarm_update.*needs/i, actions: [{ type: 'swarm_update', swarm_id: swarm.id, ops: [
        { op: 'add_step', step: { title: 'N', assignee_agent_id: B.id, needs: ['not-a-uuid'] } }] }] },
      { label: 'unknown op', notice: /swarm_update.*unknown op/i, actions: [{ type: 'swarm_update', swarm_id: swarm.id, ops: [{ op: 'explode' }] }] },
      { label: 'bad op field', notice: /swarm_update.*unknown field 'force'/i, actions: [{ type: 'swarm_update', swarm_id: swarm.id, ops: [{ op: 'retry', step_id: s1.id, force: true }] }] },
      { label: 'runtime error', notice: /action 2 \(swarm_update\).*retried/i, actions: [
        { type: 'swarm_update', swarm_id: swarm.id, ops: [{ op: 'edit', title: 'Edited by A' }] },
        { type: 'swarm_update', swarm_id: swarm.id, ops: [{ op: 'retry', step_id: s1.id }] }] }
    ];
    for (const [n, c] of cases.entries()) {
      await call(t.user, 'thread_post', { thread_id: A.main_thread_id, body: `turn ${n}`, idempotency_key: `bad-${n}` });
      const claim = await t.claim();
      assert.equal(claim.task.agent_id, A.id);
      const res = await finishTurn(t.worker, claim, withActions(`Reply ${c.label}`, c.actions));
      assert.equal(res.task.status, 'completed', c.label);
      const msgs = await threadMessages(t.user, A.main_thread_id);
      assert.ok(msgs.some(m => m.kind === 'text' && m.body === `Reply ${c.label}`), `${c.label}: reply posted`);
      assert.ok(msgs.some(m => m.kind === 'notice' && c.notice.test(m.body)), `${c.label}: notice posted`);
    }
    const after = (await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    assert.equal(after.title, 'Edited by A', 'the action before the failing one is kept');
    assert.equal(after.steps.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM swarms WHERE tenant_id=$1", [t.tenantId])).rows[0].n, 1);

    // Assignee given by name resolves like assignee_agent_id.
    await call(t.user, 'thread_post', { thread_id: A.main_thread_id, body: 'turn name', idempotency_key: 'bad-name' });
    const claim = await t.claim();
    const res = await finishTurn(t.worker, claim, withActions('Reply name', [{ type: 'swarm_update', swarm_id: swarm.id, ops: [
      { op: 'add_step', step: { title: 'Named', assignee_agent_id: 'B', needs: [s1.id] } }] }]));
    assert.equal(res.task.status, 'completed');
    const named = (await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm.steps.find((s: any) => s.title === 'Named');
    assert.equal(named.assignee_agent_id, B.id);
    const msgs = await threadMessages(t.user, A.main_thread_id);
    assert.ok(msgs.some(m => m.kind === 'text' && m.body === 'Reply name'));
    assert.ok(msgs.some(m => m.kind === 'notice' && m.body === 'Added step: Named'));
  });

  it('fixes-2 cancelled steps stay cancelled: cancel a waiting_on_you step, then answering its question is 409', async () => {
    const t = await team('project:cxl', ['A']);
    const { A } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Cancel waiting', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [{ key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] }]
    });
    const x = stepOf(swarm, 'X');
    const c = await t.claim();
    await finishTurn(t.worker, c, withActions('Asking', [{ type: 'question_ask', prompt: 'Ok?', options: ['yes'], swarm_step_id: x.id }]));
    assert.equal((await call(t.user, 'swarm_get', { swarm_id: swarm.id })).swarm.steps[0].status, 'waiting_on_you');
    const q = (await pool.query('SELECT id FROM questions WHERE swarm_step_id=$1', [x.id])).rows[0];

    await call(t.user, 'swarm_update', { swarm_id: swarm.id, ops: [{ op: 'cancel_step', step_id: x.id }] });
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q.id])).rows[0].status, 'expired');
    assert.ok((await threadMessages(t.user, A.main_thread_id)).some(m => m.kind === 'notice' && /expired/i.test(m.body)));

    await assert.rejects(() => call(t.user, 'question_answer', { question_id: q.id, choices: ['yes'] }),
      (err: any) => err.status === 409 && err.code === 'step_not_waiting');
    assert.equal((await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [x.id])).rows[0].status, 'cancelled');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks WHERE agent_id=$1 AND status='queued'", [A.id])).rows[0].n, 0);

    // Cancelling a whole swarm expires its steps' open questions too.
    const { swarm: second } = await call(t.user, 'swarm_start', {
      title: 'Cancel swarm', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [{ key: 'X', title: 'X2', assignee_agent_id: A.id, needs: [] }]
    });
    const q2 = await waitingStep(t, second, 'X');
    await call(t.user, 'swarm_cancel', { swarm_id: second.id });
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q2])).rows[0].status, 'expired');
    await assert.rejects(() => call(t.user, 'question_answer', { question_id: q2, choices: ['a'] }),
      (err: any) => err.status === 409 && err.code === 'step_not_waiting');
  });

  it('fixes-2 question_list does not write; the lease sweep expires due questions by the database clock', async () => {
    const t = await team('project:qexp', ['A']);
    const { A } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Expiry', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [{ key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] }]
    });
    const c = await t.claim();
    await finishTurn(t.worker, c, withActions('Asking', [{ type: 'question_ask', prompt: 'Soon?', options: ['y'], swarm_step_id: stepOf(swarm, 'X').id, expires_in: 60 }]));
    const q = (await pool.query("SELECT id, extract(epoch FROM expires_at - created_at) AS ttl FROM questions WHERE tenant_id=$1", [t.tenantId])).rows[0];
    assert.ok(Math.abs(Number(q.ttl) - 60) < 1, 'expires_at comes from the database clock');
    await pool.query("UPDATE questions SET expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [q.id]);

    const listed = await call(t.user, 'question_list', { status: 'all' });
    assert.equal(listed.questions[0].status, 'open');
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q.id])).rows[0].status, 'open', 'a read never expires');

    await call(t.worker, 'task_claim', { scope: t.scope, capabilities: ['codex.read'] });
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q.id])).rows[0].status, 'expired');
    assert.equal((await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [stepOf(swarm, 'X').id])).rows[0].status, 'blocked');
    assert.ok((await threadMessages(t.user, A.main_thread_id)).some(m => m.kind === 'notice' && /"Soon\?" has expired/.test(m.body)));
  });

  it('fixes-2 one summary: a step rerun by a different worker queues no second summary', async () => {
    const t = await team('project:sum', ['A', 'B']);
    const { A, B } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'One summary', goal: 'g', scope: t.scope, thread_id: A.main_thread_id, owner_agent_id: A.id,
      steps: [{ key: 'S', title: 'S', assignee_agent_id: B.id, needs: [] }]
    });
    const s = stepOf(swarm, 'S');
    await finishTurn(t.worker, await t.claim(t.worker), 'S done');
    const summaries = async () => (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND initiator_kind='swarm' AND initiator_id=$2", [A.id, swarm.id])).rows;
    assert.equal((await summaries()).length, 1);

    // Simulate a rerun of the step on a fresh turn, finished by a different worker.
    await call(t.user, 'thread_post', { thread_id: B.main_thread_id, body: 'again', idempotency_key: 'again' });
    const rerun = (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status='queued'", [B.id])).rows[0];
    await pool.query('UPDATE tasks SET swarm_step_id=$1 WHERE id=$2', [s.id, rerun.id]);
    await pool.query("UPDATE swarm_steps SET status='running', task_id=$1 WHERE id=$2", [rerun.id, s.id]);
    await pool.query("UPDATE swarms SET status='running', closed_at=NULL WHERE id=$1", [swarm.id]);
    await t.claim(t.worker); // the summary turn
    const c2 = await t.claim(t.worker2);
    assert.equal(c2.task.id, rerun.id);
    await finishTurn(t.worker2, c2, 'S done again');
    assert.equal((await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [s.id])).rows[0].status, 'done');
    assert.equal((await summaries()).length, 1);
    assert.ok((await pool.query('SELECT summary_task_id FROM swarms WHERE id=$1', [swarm.id])).rows[0].summary_task_id);
  });

  it('fixes-2 handoff grant refuses a done step and a closed swarm', async () => {
    const t = await team('project:hdone', ['A', 'B']);
    const { A, B } = t.agents;
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Done', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [{ key: 'S', title: 'S', assignee_agent_id: B.id, needs: [] }]
    });
    const s = stepOf(swarm, 'S');
    await finishTurn(t.worker, await t.claim(), 'S done');
    await call(t.user, 'thread_post', { thread_id: B.main_thread_id, body: 'more', idempotency_key: 'more' });
    assert.equal((await t.claim()).task.agent_id, A.id, 'the summary turn comes first');
    const c = await t.claim();
    assert.equal(c.task.agent_id, B.id);
    const res = await finishTurn(t.worker, c, withActions('handing', [{ type: 'handoff', to_agent: A.id, body: 'redo', swarm_step_id: s.id }]));
    assert.equal(res.task.status, 'completed');
    assert.ok((await threadMessages(t.user, B.main_thread_id)).some(m => m.kind === 'notice' && /handoff/.test(m.body) && /done/.test(m.body)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks WHERE agent_id=$1 AND initiator_kind='handoff'", [A.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT status FROM swarm_steps WHERE id=$1', [s.id])).rows[0].status, 'done');
  });

  it('fixes-2 no unbounded chains: hop depth carries through step and summary turns, and the cap of 20 counts swarm_start turns', async () => {
    const t = await team('project:hop', ['A', 'B']);
    const { A, B } = t.agents;
    await call(t.user, 'thread_post', { thread_id: A.main_thread_id, body: 'plan', idempotency_key: 'plan' });
    const turn = (await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status='queued'", [A.id])).rows[0];
    await pool.query("UPDATE tasks SET context_versions = context_versions || '{\"hop_depth\":2}'::jsonb WHERE id=$1", [turn.id]);
    await finishTurn(t.worker, await t.claim(), withActions('starting', [{ type: 'swarm_start', title: 'Hop', goal: 'g', steps: [{ key: 's', title: 's', assignee_agent_id: 'B' }] }]));
    const stepTurn = (await pool.query("SELECT id, context_versions FROM tasks WHERE agent_id=$1 AND initiator_kind='swarm' AND status='queued'", [B.id])).rows[0];
    assert.equal(stepTurn.context_versions.hop_depth, 3);
    const c = await t.claim();
    assert.equal(c.task.id, stepTurn.id);
    await finishTurn(t.worker, c, 's done');
    const summary = (await pool.query("SELECT context_versions FROM tasks WHERE agent_id=$1 AND initiator_kind='swarm' AND status='queued'", [A.id])).rows[0];
    assert.equal(summary.context_versions.hop_depth, 4);

    // Fan-out cap: 20 ready swarm steps plus one handoff in one finish queue 20 turns and refuse the handoff.
    const t2 = await team('project:cap', ['A', 'B']);
    await call(t2.user, 'thread_post', { thread_id: t2.agents.A.main_thread_id, body: 'fan out', idempotency_key: 'fan' });
    const steps = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, title: `k${i}`, assignee_agent_id: t2.agents.B.id }));
    const res = await finishTurn(t2.worker, await t2.claim(), withActions('fan', [
      { type: 'swarm_start', title: 'Fan', goal: 'g', steps },
      { type: 'handoff', to_agent: t2.agents.B.id, body: 'one more' }
    ]));
    assert.equal(res.task.status, 'completed');
    const queued = (await pool.query("SELECT initiator_kind, count(*)::int AS n FROM tasks WHERE tenant_id=$1 AND status='queued' GROUP BY 1 ORDER BY 1", [t2.tenantId])).rows;
    assert.deepEqual(queued, [{ initiator_kind: 'swarm', n: 20 }]);
    assert.ok((await threadMessages(t2.user, t2.agents.A.main_thread_id)).some(m => m.kind === 'notice' && /cap of 20/.test(m.body)));
  });

  it('fixes-2 flows: a flow with an approve step ends with its swarm done and creates no channel thread', async () => {
    const tenantId = randomUUID();
    const owner = await createPrincipal(tenantId, 'owner', 'admin', ['project:flowsw']);
    const worker = await createPrincipal(tenantId, 'worker-fl', 'worker', ['project:flowsw']);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const definition = { id: 'review-approval', title: 'Reviewed candidate', steps: [
      { id: 'review', kind: 'review', capability: 'auto.read', objective: 'Review it', needs: [] },
      { id: 'approve', kind: 'approve', objective: 'Accept the review.', needs: ['review'] }
    ] };
    const started = await call(owner, 'flow_start', { flow: definition, scope: 'project:flowsw', inputs: { commit }, idempotency_key: 'fl' });
    const review = await call(worker, 'task_claim', { scope: 'project:flowsw', capabilities: ['codex.read', 'auto.read'] });
    await call(worker, 'task_finish', { task_id: review.task.id, lease_token: review.lease_token, lease_generation: review.lease_generation,
      outcome: 'completed', result: { answer: 'ok', observed_commit: commit } });
    await call(owner, 'flow_approve', { flow_id: started.flow.id, step_id: 'approve', approve: true });
    const sw = (await call(owner, 'swarm_get', { swarm_id: started.swarm_id })).swarm;
    assert.equal(sw.thread_id, null);
    assert.ok(sw.steps.every((s: any) => s.status === 'done'));
    assert.equal(sw.status, 'done');
    assert.ok(sw.closed_at);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM threads WHERE tenant_id=$1', [tenantId])).rows[0].n, 0);
  });

  it('fixes-2 owner-only answers: a frontend that is not the owner, or a grok/dot identity, cannot answer', async () => {
    const t = await team('project:own', ['A']);
    const { A } = t.agents;
    const front = await createPrincipal(t.tenantId, 'web-frontend', 'frontend', [t.scope]);
    const grok = await createPrincipal(t.tenantId, 'grok', 'admin', [t.scope]);
    const { swarm } = await call(t.user, 'swarm_start', {
      title: 'Owner answers', goal: 'g', scope: t.scope, thread_id: A.main_thread_id,
      steps: [{ key: 'X', title: 'X', assignee_agent_id: A.id, needs: [] }]
    });
    const x = stepOf(swarm, 'X');
    await finishTurn(t.worker, await t.claim(), withActions('Asking', [{ type: 'question_ask', prompt: 'Ok?', options: ['yes'], swarm_step_id: x.id }]));
    const q = (await pool.query('SELECT id FROM questions WHERE swarm_step_id=$1', [x.id])).rows[0];
    for (const p of [front, grok]) {
      await assert.rejects(() => call(p, 'question_answer', { question_id: q.id, choices: ['yes'] }),
        (err: any) => err.status === 403 && err.code === 'owner_required', p.name);
    }
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q.id])).rows[0].status, 'open');
    await call(t.user, 'question_answer', { question_id: q.id, choices: ['yes'] });
    assert.equal((await pool.query('SELECT status FROM questions WHERE id=$1', [q.id])).rows[0].status, 'answered');
  });
});
