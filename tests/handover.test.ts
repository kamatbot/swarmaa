import test from 'node:test';
import assert from 'node:assert/strict';
import { extractActionsBlock, type TurnActionQuestionAsk, type TurnActionSwarmStart } from '../src/core/actions.js';
import { handoffBody, stepCheck } from '../src/core/swarms.js';
import { buildTurnPrompt } from '../src/bridge/adapters.js';
import type { Task } from '../src/bridge/types.js';

const parse = (action: unknown) => extractActionsBlock(`Done\n\n\`\`\`swarmaa-actions\n${JSON.stringify([action])}\n\`\`\``);
const start = (step: Record<string, unknown>) => parse({ type: 'swarm_start', title: 'T', goal: 'g', steps: [{ key: 'a', title: 'A', assignee_agent_id: 'B', ...step }] });
const REQUIRED = 'check is required: say what done means and how to check it.';
const SECRET = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

test('swarm step check is required, non-blank and at most 512 chars in the parser and the service', () => {
  for (const check of [undefined, '', '   ', 7]) {
    assert.equal(start(check === undefined ? {} : { check }).error, REQUIRED);
    assert.throws(() => stepCheck(check), (e: any) => e.status === 400 && e.code === 'invalid_steps' && e.message === REQUIRED);
  }
  assert.match(start({ check: 'x'.repeat(513) }).error ?? '', /512/);
  assert.throws(() => stepCheck('x'.repeat(513)), (e: any) => e.code === 'invalid_steps');
  const ok = start({ check: `  tests pass, token ${SECRET}  ` });
  assert.equal(ok.error, undefined);
  const check = (ok.actions![0] as TurnActionSwarmStart).steps[0]!.check;
  assert.ok(check.startsWith('tests pass') && !check.includes(SECRET));
  assert.equal(stepCheck(' x'.repeat(256)), ' x'.repeat(256).trim());
});

test('handoff message carries Done when only when the step has a check', () => {
  assert.equal(handoffBody('Atlas', 'Ship it', 'the site loads'), 'Atlas gave you: Ship it\nDone when: the site loads');
  assert.equal(handoffBody('Atlas', 'Ship it', null), 'Atlas gave you: Ship it');
});

test('question_ask action is parsed, redacted, strict, and an approval defaults to Approve/Deny', () => {
  const action = { kind: 'command', summary: 'Push the branch', detail: `git push https://${SECRET}@github.com/o/r`, where: 'repo r' };
  const res = parse({ type: 'question_ask', prompt: 'May I push?', options: [], action });
  assert.equal(res.error, undefined);
  const q = res.actions![0] as TurnActionQuestionAsk;
  assert.deepEqual(q.options, ['Approve', 'Deny']);
  assert.equal(q.action!.kind, 'command');
  assert.equal(q.action!.where, 'repo r');
  assert.ok(q.action!.detail.startsWith('git push') && !q.action!.detail.includes(SECRET));
  // Explicit options stay; a plain question has no action.
  assert.deepEqual((parse({ type: 'question_ask', prompt: 'Go?', options: ['Yes'], action }).actions![0] as TurnActionQuestionAsk).options, ['Yes']);
  assert.equal((parse({ type: 'question_ask', prompt: 'Go?', options: [] }).actions![0] as TurnActionQuestionAsk).action, undefined);
  for (const bad of [{ ...action, extra: 1 }, { ...action, kind: 'delete' }, { kind: 'send', detail: 'd' },
    { ...action, summary: 'x'.repeat(201) }, { ...action, detail: '' }, { ...action, where: 'x'.repeat(301) }, 'push']) {
    assert.ok(parse({ type: 'question_ask', prompt: 'Go?', options: [], action: bad }).error, JSON.stringify(bad));
  }
  assert.match(parse({ type: 'question_ask', prompt: 'Go?', options: [], action: { ...action, extra: 1 } }).error!, /unknown field 'extra'/);
});

test('only swarm step turns are told to end with the four-part report; every turn learns approvals', () => {
  const task = { kind: 'turn', objective: 'Help', swarm_step_id: 'step-id' } as unknown as Task;
  const prompt = buildTurnPrompt(task, {});
  for (const label of ['**Result:**', '**Checks:**', '**Not checked:**', '**Files:**']) assert.ok(prompt.includes(`\n${label}`), label);
  assert.doesNotMatch(buildTurnPrompt({ ...task, swarm_step_id: null } as unknown as Task, {}), /Not checked/);
  assert.match(buildTurnPrompt({ instructions: '', messages: [] }), /question_ask including action/);
});
