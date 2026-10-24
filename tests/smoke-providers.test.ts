import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkHeadroom,
  createSkippedProviderResult,
  getCliVersion,
  getHelpText,
  isTerminal,
  judgeAnswer,
  judgeCancel,
  judgeContinue,
  judgeNotify,
  judgePatch,
  judgeServed,
  renderMatrix,
  renderTable,
  TaskTracker,
  type ProviderResult,
  type TaskView,
} from '../scripts/smoke-providers.js';

test('a substituted provider is FAIL', () => {
  // Task served by codex when claude was requested
  const substitutedTask: TaskView = {
    id: 'task-1',
    status: 'completed',
    version: 2,
    result: {
      provider: 'codex',
      answer: 'swarmaa-ok-nonce123',
    },
  };

  const failResult = judgeServed(substitutedTask, 'claude');
  assert.equal(failResult.verdict, 'FAIL');
  assert.equal(failResult.scenario, 'served');
  assert.match(failResult.reason ?? '', /served by "codex" instead of "claude"/u);
  assert.match(failResult.reason ?? '', /HarnessRouter rule 1/u);

  // Task with nested served.provider taking precedence
  const nestedSubstitutedTask: TaskView = {
    id: 'task-2',
    status: 'completed',
    version: 2,
    result: {
      provider: 'claude',
      served: { provider: 'antigravity' },
      answer: 'swarmaa-ok-nonce123',
    },
  };
  const nestedFail = judgeServed(nestedSubstitutedTask, 'claude');
  assert.equal(nestedFail.verdict, 'FAIL');
  assert.match(nestedFail.reason ?? '', /served by "antigravity" instead of "claude"/u);

  // Missing provider in result
  const missingProviderTask: TaskView = {
    id: 'task-3',
    status: 'completed',
    version: 2,
    result: {},
  };
  const missingFail = judgeServed(missingProviderTask, 'claude');
  assert.equal(missingFail.verdict, 'FAIL');
  assert.match(missingFail.reason ?? '', /no served provider recorded/u);

  // Null task or result
  assert.equal(judgeServed(null, 'claude').verdict, 'FAIL');

  // Exact provider match is PASS
  const matchingTask: TaskView = {
    id: 'task-4',
    status: 'completed',
    version: 2,
    result: {
      provider: 'claude',
      answer: 'swarmaa-ok-nonce123',
    },
  };
  const passResult = judgeServed(matchingTask, 'claude');
  assert.equal(passResult.verdict, 'PASS');
  assert.equal(passResult.reason, undefined);
});

test('a missing nonce is FAIL', () => {
  const nonce = 'abc12345';

  // 1. judgeAnswer: missing nonce in answer
  const answerMissingTask: TaskView = {
    id: 'task-ans-1',
    status: 'completed',
    version: 2,
    result: {
      provider: 'claude',
      answer: 'Completed successfully without repeating the expected token.',
    },
  };
  const answerFail = judgeAnswer(answerMissingTask, nonce);
  assert.equal(answerFail.verdict, 'FAIL');
  assert.equal(answerFail.scenario, 'answer');
  assert.match(answerFail.reason ?? '', /missing nonce in answer/u);
  assert.match(answerFail.reason ?? '', new RegExp(nonce, 'u'));

  // judgeAnswer: status not completed
  const answerFailedStatusTask: TaskView = {
    id: 'task-ans-2',
    status: 'failed',
    version: 2,
    result: {
      provider: 'claude',
      exit_code: 1,
      stop_reason: 'error',
    },
  };
  const answerStatusFail = judgeAnswer(answerFailedStatusTask, nonce);
  assert.equal(answerStatusFail.verdict, 'FAIL');
  assert.match(answerStatusFail.reason ?? '', /task ended with status "failed"/u);

  // judgeAnswer: nonce present is PASS
  const answerPassTask: TaskView = {
    id: 'task-ans-3',
    status: 'completed',
    version: 2,
    result: {
      provider: 'claude',
      answer: `Here is the response: swarmaa-ok-${nonce}`,
    },
  };
  const answerPass = judgeAnswer(answerPassTask, nonce, false, 300, 1500);
  assert.equal(answerPass.verdict, 'PASS');
  assert.equal(answerPass.duration_ms, 1500);

  // 2. judgeContinue: missing nonce in continuation answer
  const continueMissingTask: TaskView = {
    id: 'task-cont-1',
    status: 'completed',
    version: 3,
    result: {
      provider: 'claude',
      answer: 'I do not recall what you said previously.',
    },
  };
  const continueFail = judgeContinue(continueMissingTask, nonce);
  assert.equal(continueFail.verdict, 'FAIL');
  assert.equal(continueFail.scenario, 'continue');
  assert.match(continueFail.reason ?? '', /missing nonce in continuation answer/u);

  // judgeContinue: nonce present is PASS
  const continuePassTask: TaskView = {
    id: 'task-cont-2',
    status: 'completed',
    version: 3,
    result: {
      provider: 'claude',
      answer: `The nonce was ${nonce}.`,
    },
  };
  const continuePass = judgeContinue(continuePassTask, nonce, false, 300, 2100);
  assert.equal(continuePass.verdict, 'PASS');
  assert.equal(continuePass.duration_ms, 2100);
});

test('a provider under 5% headroom is SKIP', () => {
  // Below 5% boundary
  assert.deepEqual(checkHeadroom(4.9), {
    skip: true,
    reason: 'provider usage headroom is under 5% (4.9% remaining)',
  });
  assert.deepEqual(checkHeadroom(0), {
    skip: true,
    reason: 'provider usage headroom is under 5% (0.0% remaining)',
  });
  assert.deepEqual(checkHeadroom(3.25), {
    skip: true,
    reason: 'provider usage headroom is under 5% (3.3% remaining)',
  });

  // At or above 5% boundary
  assert.deepEqual(checkHeadroom(5.0), { skip: false });
  assert.deepEqual(checkHeadroom(5.1), { skip: false });
  assert.deepEqual(checkHeadroom(42.5), { skip: false });
  assert.deepEqual(checkHeadroom(100), { skip: false });

  // createSkippedProviderResult sets all scenarios to SKIP with the headroom reason
  const skipped = createSkippedProviderResult('codex', 'provider usage headroom is under 5% (2.1% remaining)', 2.1, '0.160.1');
  assert.equal(skipped.provider, 'codex');
  assert.equal(skipped.version, '0.160.1');
  assert.equal(skipped.headroom, 2.1);

  const expectedScenarios = ['answer', 'served', 'continue', 'patch', 'cancel', 'notify'] as const;
  for (const sc of expectedScenarios) {
    const r = skipped.scenarios[sc];
    assert.ok(r, `scenario ${sc} must exist`);
    assert.equal(r.scenario, sc);
    assert.equal(r.verdict, 'SKIP');
    assert.equal(r.duration_ms, 0);
    assert.match(r.reason ?? '', /headroom is under 5%/u);
  }
});

test('a timeout is FAIL with its reason', () => {
  // 1. judgeAnswer timeout
  const ansTimeout = judgeAnswer(null, 'test-nonce', true, 300, 300000);
  assert.equal(ansTimeout.verdict, 'FAIL');
  assert.equal(ansTimeout.scenario, 'answer');
  assert.equal(ansTimeout.duration_ms, 300000);
  assert.match(ansTimeout.reason ?? '', /timed out after 300s waiting for answer/u);

  // 2. judgeContinue timeout
  const contTimeout = judgeContinue(null, 'test-nonce', true, 180, 180000);
  assert.equal(contTimeout.verdict, 'FAIL');
  assert.equal(contTimeout.scenario, 'continue');
  assert.equal(contTimeout.duration_ms, 180000);
  assert.match(contTimeout.reason ?? '', /timed out after 180s waiting for continuation/u);

  // 3. judgePatch timeout
  const patchTimeout = judgePatch({
    patchScope: 'project:swarma',
    timedOut: true,
    timeoutSec: 240,
    durationMs: 240000,
  });
  assert.equal(patchTimeout.verdict, 'FAIL');
  assert.equal(patchTimeout.scenario, 'patch');
  assert.match(patchTimeout.reason ?? '', /timed out after 240s waiting for patch task/u);

  // 4. judgeCancel timeout
  const cancelTimeout = judgeCancel({
    cancelledWithin30s: false,
    slotFreedWithin60s: false,
    timedOut: true,
    timeoutSec: 120,
    durationMs: 120000,
  });
  assert.equal(cancelTimeout.verdict, 'FAIL');
  assert.equal(cancelTimeout.scenario, 'cancel');
  assert.match(cancelTimeout.reason ?? '', /timed out after 120s/u);

  // 5. judgeNotify timeout
  const notifyTimeout = judgeNotify({
    notificationFound: false,
    timedOut: true,
    timeoutSec: 60,
    durationMs: 60000,
  });
  assert.equal(notifyTimeout.verdict, 'FAIL');
  assert.equal(notifyTimeout.scenario, 'notify');
  assert.match(notifyTimeout.reason ?? '', /timed out after 60s waiting for inbox notification/u);
});

test('the table renders', () => {
  const fixtureResults: ProviderResult[] = [
    {
      provider: 'claude',
      version: '2.1.310 (Claude Code)',
      headroom: 45.0,
      scenarios: {
        answer: { scenario: 'answer', verdict: 'PASS', duration_ms: 4200 },
        served: { scenario: 'served', verdict: 'PASS', duration_ms: 50 },
        continue: { scenario: 'continue', verdict: 'PASS', duration_ms: 3100 },
        patch: { scenario: 'patch', verdict: 'SKIP', duration_ms: 0, reason: 'pass --patch-scope <scope> where project has allow_patch: true' },
        cancel: { scenario: 'cancel', verdict: 'PASS', duration_ms: 12500 },
        notify: { scenario: 'notify', verdict: 'PASS', duration_ms: 1100 },
      },
    },
    {
      provider: 'codex',
      version: 'codex-cli 0.160.1',
      headroom: 2.5,
      scenarios: {
        answer: { scenario: 'answer', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
        served: { scenario: 'served', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
        continue: { scenario: 'continue', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
        patch: { scenario: 'patch', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
        cancel: { scenario: 'cancel', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
        notify: { scenario: 'notify', verdict: 'SKIP', duration_ms: 0, reason: 'provider usage headroom is under 5% (2.5% remaining)' },
      },
    },
    {
      provider: 'antigravity',
      version: '1.4.7',
      headroom: 80.0,
      scenarios: {
        answer: { scenario: 'answer', verdict: 'FAIL', duration_ms: 300000, reason: 'timed out after 300s waiting for answer' },
        served: { scenario: 'served', verdict: 'FAIL', duration_ms: 0, reason: 'task result not available' },
        continue: { scenario: 'continue', verdict: 'FAIL', duration_ms: 0, reason: 'prerequisite "answer" scenario did not pass' },
        patch: { scenario: 'patch', verdict: 'SKIP', duration_ms: 0, reason: 'pass --patch-scope <scope> where project has allow_patch: true' },
        cancel: { scenario: 'cancel', verdict: 'PASS', duration_ms: 15400 },
        notify: { scenario: 'notify', verdict: 'FAIL', duration_ms: 0, reason: 'no answer task was submitted to check notifications for' },
      },
    },
  ];

  const tableOutput = renderTable(fixtureResults);
  assert.ok(typeof tableOutput === 'string' && tableOutput.length > 0);

  // Headers must be present
  assert.match(tableOutput, /Provider/u);
  assert.match(tableOutput, /Scenario/u);
  assert.match(tableOutput, /Verdict/u);
  assert.match(tableOutput, /Duration/u);
  assert.match(tableOutput, /Notes/u);

  // All providers and scenarios must appear
  for (const prov of ['claude', 'codex', 'antigravity']) {
    assert.match(tableOutput, new RegExp(prov, 'u'));
  }
  for (const sc of ['answer', 'served', 'continue', 'patch', 'cancel', 'notify']) {
    assert.match(tableOutput, new RegExp(sc, 'u'));
  }

  // Verdicts must appear
  assert.match(tableOutput, /PASS/u);
  assert.match(tableOutput, /FAIL/u);
  assert.match(tableOutput, /SKIP/u);

  // Reasons must appear in notes
  assert.match(tableOutput, /pass --patch-scope/u);
  assert.match(tableOutput, /headroom is under 5%/u);
  assert.match(tableOutput, /timed out after 300s/u);

  // Matrix view renders too
  const matrixOutput = renderMatrix(fixtureResults);
  assert.ok(typeof matrixOutput === 'string' && matrixOutput.length > 0);
  assert.match(matrixOutput, /Provider/u);
  assert.match(matrixOutput, /answer/u);
  assert.match(matrixOutput, /served/u);
  assert.match(matrixOutput, /claude/u);
});

test('judgePatch: skip without patch scope, fail without file in diff, pass with file in diff', () => {
  // Without patchScope -> SKIP
  const skipped = judgePatch({});
  assert.equal(skipped.verdict, 'SKIP');
  assert.match(skipped.reason ?? '', /pass --patch-scope/u);

  // With patchScope, but task not completed -> FAIL
  const failedStatus = judgePatch({
    patchScope: 'project:swarma',
    task: { id: 't-1', status: 'failed', version: 2 },
  });
  assert.equal(failedStatus.verdict, 'FAIL');
  assert.match(failedStatus.reason ?? '', /patch task ended with status "failed"/u);

  // With patchScope, completed, but 0 changed_files -> FAIL
  const zeroFiles = judgePatch({
    patchScope: 'project:swarma',
    task: { id: 't-2', status: 'completed', version: 2, result: { changed_files: 0 } },
    expectedNonce: 'n123',
    diffContent: 'some random diff',
  });
  assert.equal(zeroFiles.verdict, 'FAIL');
  assert.match(zeroFiles.reason ?? '', /changed_files is 0/u);

  // With patchScope, completed, changed_files >= 1, but diff does not contain smoke/<nonce>.txt -> FAIL
  const wrongDiff = judgePatch({
    patchScope: 'project:swarma',
    task: { id: 't-3', status: 'completed', version: 2, result: { changed_files: 1 } },
    expectedNonce: 'n123',
    diffContent: 'diff --git a/other.txt b/other.txt\n+hello',
  });
  assert.equal(wrongDiff.verdict, 'FAIL');
  assert.match(wrongDiff.reason ?? '', /branch diff does not contain "smoke\/n123.txt"/u);

  // With patchScope, completed, changed_files >= 1, diff contains smoke/<nonce>.txt -> PASS
  const patchPass = judgePatch({
    patchScope: 'project:swarma',
    task: { id: 't-4', status: 'completed', version: 2, result: { changed_files: 1 } },
    expectedNonce: 'n123',
    diffContent: 'diff --git a/smoke/n123.txt b/smoke/n123.txt\nnew file mode 100644\n+n123',
    durationMs: 4500,
  });
  assert.equal(patchPass.verdict, 'PASS');
  assert.equal(patchPass.duration_ms, 4500);
});

test('judgeCancel: status transition and slot freed verification', () => {
  // Not cancelled within 30s -> FAIL
  const notCancelled = judgeCancel({
    status: 'running',
    cancelledWithin30s: false,
    slotFreedWithin60s: true,
  });
  assert.equal(notCancelled.verdict, 'FAIL');
  assert.match(notCancelled.reason ?? '', /was not cancelled within 30s/u);

  // Cancelled within 30s, but slot not freed within 60s -> FAIL
  const slotNotFreed = judgeCancel({
    status: 'cancelled',
    cancelledWithin30s: true,
    slotFreedWithin60s: false,
  });
  assert.equal(slotNotFreed.verdict, 'FAIL');
  assert.match(slotNotFreed.reason ?? '', /worker slot was not freed within 60s/u);

  // Both succeed -> PASS
  const cancelPass = judgeCancel({
    status: 'cancelled',
    cancelledWithin30s: true,
    slotFreedWithin60s: true,
    durationMs: 8200,
  });
  assert.equal(cancelPass.verdict, 'PASS');
  assert.equal(cancelPass.duration_ms, 8200);
});

test('judgeNotify: notification found in inbox', () => {
  // Not found -> FAIL
  const notFound = judgeNotify({ notificationFound: false });
  assert.equal(notFound.verdict, 'FAIL');
  assert.match(notFound.reason ?? '', /not found in inbox_get/u);

  // Found -> PASS
  const found = judgeNotify({ notificationFound: true, durationMs: 1200 });
  assert.equal(found.verdict, 'PASS');
  assert.equal(found.duration_ms, 1200);
});

test('getCliVersion and getHelpText', () => {
  // Mock exec helper
  assert.equal(getCliVersion('claude', () => '2.1.300\n'), '2.1.300');
  assert.equal(getCliVersion('codex', () => '0.150.0\n'), '0.150.0');
  assert.equal(getCliVersion('antigravity', () => '1.4.0\n'), '1.4.0');
  assert.equal(getCliVersion('unknown-prov', () => '1.0'), 'unknown provider');
  assert.equal(getCliVersion('claude', () => { throw new Error('missing'); }), '(not installed)');

  const help = getHelpText();
  assert.match(help, /npm run smoke:providers/u);
  assert.match(help, /--providers/u);
  assert.match(help, /--scope/u);
  assert.match(help, /--patch-scope/u);
  assert.match(help, /--timeout/u);
  assert.match(help, /--as/u);
  assert.match(help, /--help/u);
});

test('TaskTracker: tracks, updates version, and untracks', () => {
  const tracker = new TaskTracker();
  tracker.track('task-a', 1);
  tracker.track('task-b', 1);
  assert.equal(tracker.getPending().length, 2);

  tracker.updateVersion('task-a', 3);
  assert.deepEqual(tracker.getPending(), [
    { id: 'task-a', version: 3 },
    { id: 'task-b', version: 1 },
  ]);

  tracker.untrack('task-a');
  assert.deepEqual(tracker.getPending(), [
    { id: 'task-b', version: 1 },
  ]);

  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('cancelled'), true);
  assert.equal(isTerminal('failed'), true);
  assert.equal(isTerminal('blocked'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isTerminal('queued'), false);
});
