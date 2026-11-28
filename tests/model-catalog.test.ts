import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getStaticModelCatalog,
  mergeModelCatalog,
  mergeDispatchedFrom,
  normalizeDispatchedFrom,
  resolveTurnRunner,
  validateModelAndEffort,
} from '../src/core/model-catalog.js';
import { sameModel } from '../src/core/failures.js';
import { parseReview } from '../src/core/peer-review.js';
import { extractMentions } from '../src/core/teams.js';
import { extractActionsBlock } from '../src/core/actions.js';

test('static model catalog loads config/models.json with claude, codex, antigravity', () => {
  const cat = getStaticModelCatalog();
  assert.deepEqual(cat.providers.claude?.models, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(cat.providers.claude?.efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(cat.providers.codex?.models, ['gpt-6-astra', 'gpt-5.4', 'gpt-5.4-mini']);
  assert.deepEqual(cat.providers.codex?.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(cat.providers.antigravity?.models, ['gemini-4-neon-high', 'gemini-4-neon-medium', 'gemini-4-neon-low', 'gemini-4-neon-xhigh', 'gemini-3.8-flash']);
  assert.deepEqual(cat.providers.antigravity?.efforts, ['low', 'medium', 'high', 'xhigh']);
});

test('validateModelAndEffort rejects cross-provider model mismatches and unsupported efforts', () => {
  // Valid combinations pass
  assert.doesNotThrow(() => validateModelAndEffort('claude', 'claude-opus-5-5', 'max'));
  assert.doesNotThrow(() => validateModelAndEffort('codex', 'gpt-6-astra', 'minimal'));
  assert.doesNotThrow(() => validateModelAndEffort('codex', 'gpt-5.4', 'xhigh'));
  assert.doesNotThrow(() => validateModelAndEffort('antigravity', 'gemini-3.8-pro', 'xhigh'));

  // Cross-provider mismatches rejected
  for (const [provider, model] of [
    ['codex', 'claude-opus-5-5'],
    ['codex', 'sonnet'],
    ['antigravity', 'claude-sonnet-5-5'],
    ['claude', 'gpt-6-astra'],
    ['claude', 'gpt-5.4-mini'],
    ['antigravity', 'gpt-5.4'],
    ['claude', 'gemini-3.8-pro'],
    ['codex', 'gemini-3.8-flash'],
  ] as const) {
    assert.throws(
      () => validateModelAndEffort(provider, model, undefined),
      { name: 'AppError', code: 'invalid_arguments', status: 400 },
      `expected ${provider} + ${model} to be rejected`
    );
  }

  // Provider-incompatible efforts rejected
  assert.throws(() => validateModelAndEffort('claude', 'claude-opus-5-5', 'minimal'), { code: 'invalid_arguments' });
  assert.throws(() => validateModelAndEffort('claude', 'claude-opus-5-5', 'xhigh'), { code: 'invalid_arguments' });
  assert.throws(() => validateModelAndEffort('codex', 'gpt-5.4', 'max'), { code: 'invalid_arguments' });
  assert.throws(() => validateModelAndEffort('antigravity', 'gemini-3.8-pro', 'max'), { code: 'invalid_arguments' });
  assert.throws(() => validateModelAndEffort('antigravity', 'gemini-3.8-pro', 'minimal'), { code: 'invalid_arguments' });
  assert.throws(() => validateModelAndEffort(null, null, 'bogus'), { code: 'invalid_arguments' });
});

test('mergeModelCatalog overlays live worker default_model, turn_model, and models[]', () => {
  const merged = mergeModelCatalog([
    {
      claude: { default_model: 'claude-opus-5-5', turn_model: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-custom-6'] },
      codex: { default_model: 'gpt-6-astra', models: ['gpt-6-astra'] },
    },
  ]);
  assert.equal(merged.providers.claude?.default_model, 'claude-opus-5-5');
  assert.equal(merged.providers.claude?.turn_model, 'claude-sonnet-5-5');
  assert.ok(merged.providers.claude?.models.includes('claude-custom-6'));
  assert.ok(merged.providers.claude?.models.includes('claude-haiku-5-5'));
  assert.equal(merged.providers.codex?.default_model, 'gpt-6-astra');
});

test('resolveTurnRunner unifies bot.routing -> agent.runner -> override -> forceReadOnly/summary', () => {
  const bot = {
    id: 'b1',
    lead_agent_id: 'lead',
    rules: { lead_mode: 'default' },
    routing: {
      patch: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
      summary: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    },
  };
  const editAgent = { id: 'lead', edits: true, runner: { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' } };

  // Non-router edit turn picks bot.routing.patch and propagates provider/model/effort
  const patchTurn = resolveTurnRunner({ bot, agent: editAgent });
  assert.equal(patchTurn.capability, 'codex.patch');
  assert.equal(patchTurn.edits, true);
  assert.deepEqual(patchTurn.runner, { provider: 'codex', model: 'gpt-6-astra', effort: 'high' });

  // Swarm summary turn forces read-only even when lead has edits: true
  const summaryTurn = resolveTurnRunner({ bot, agent: editAgent, routeKind: 'summary', forceReadOnly: true, summary: true });
  assert.equal(summaryTurn.capability, 'claude.read');
  assert.equal(summaryTurn.edits, false);
  assert.deepEqual(summaryTurn.runner, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', fast: false, summary: true });

  // Explicit per-message override wins over bot routing
  const overrideTurn = resolveTurnRunner({ bot, agent: editAgent, override: { provider: 'antigravity', model: 'gemini-3.8-pro', effort: 'high' } });
  assert.equal(overrideTurn.capability, 'antigravity.patch');
  assert.deepEqual(overrideTurn.runner, { provider: 'antigravity', model: 'gemini-3.8-pro', effort: 'high', fast: false });

  // Agent without bot propagates its own runner into permission_envelope.runner
  const standalone = resolveTurnRunner({ agent: editAgent });
  assert.equal(standalone.capability, 'claude.patch');
  assert.deepEqual(standalone.runner, { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' });
});

test('sameModel normalizes Claude short aliases and Antigravity thought-level suffixes', () => {
  assert.equal(sameModel('sonnet', 'claude-sonnet-5-5'), true);
  assert.equal(sameModel('opus', 'claude-opus-5-5-20261001'), true);
  assert.equal(sameModel('haiku', 'anthropic/claude-haiku-5-5'), true);
  assert.equal(sameModel('claude-sonnet-5-5', 'sonnet'), true);
  assert.equal(sameModel('sonnet', 'claude-opus-5-5'), false);

  assert.equal(sameModel('gemini-3.8-pro', 'gemini-3.8-pro-high'), true);
  assert.equal(sameModel('gemini-3.8-flash-high', 'gemini-3.8-flash'), true);
  assert.equal(sameModel('gemini-3.8-flash-low', 'gemini-3.8-flash-xhigh'), true);
  assert.equal(sameModel('gemini-3.8-pro-medium', 'google/gemini-3.8-pro-001'), true);
  assert.equal(sameModel('gemini-3.8-flash', 'gemini-3.8-pro-high'), false);
  assert.equal(sameModel('gemini-3.5-flash', 'gemini-3.5-flash-lite'), false);
});

test('parseReview handles bolded severity tags and [Blocking]', () => {
  const review = parseReview([
    'VERDICT: fix',
    '- **[Important]** Missing tenant scope filter on query',
    '- **[Blocking]**: Race condition in lock release',
    '1. **[Worth fixing]** Extract helper function',
    '- **[Small detail]** Typo in comment',
    '- **[Note]** Existing tests cover the happy path',
  ].join('\n'));
  assert.equal(review.verdict, 'fix');
  assert.equal(review.findings.length, 4);
  assert.equal(review.findings[0]?.severity, 'Important');
  assert.equal(review.findings[1]?.severity, 'Important');
  assert.equal(review.findings[1]?.text, 'Race condition in lock release');
  assert.equal(review.findings[2]?.severity, 'Worth fixing');
  assert.equal(review.findings[3]?.severity, 'Small detail');
  assert.deepEqual(review.notes, ['Existing tests cover the happy path']);
});

test('extractMentions parses @"Agent Name", dotted names, and strips trailing punctuation', () => {
  const mentions = extractMentions('Hey @"Code Reviewer", @api.bot., and @Linus: please check!');
  assert.deepEqual([...mentions].sort(), ['api.bot', 'code reviewer', 'linus']);
});

test('extractActionsBlock supports structured handoff fields', () => {
  const artId = '11111111-1111-4111-8111-111111111111';
  const threadId = '22222222-2222-4222-8222-222222222222';
  const res = extractActionsBlock(
    `Handing off.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([{
      type: 'handoff',
      to_agent: 'Reviewer',
      body: 'Please check branch',
      base_ref: 'main',
      branch: 'swarmaa/codex/abc',
      artifact_ids: [artId],
      reply_to_thread: threadId,
    }])}\n\`\`\``
  );
  assert.equal(res.error, undefined);
  assert.equal(res.actions?.length, 1);
  assert.deepEqual(res.actions?.[0], {
    type: 'handoff',
    to_agent: 'Reviewer',
    body: 'Please check branch',
    swarm_step_id: undefined,
    base_ref: 'main',
    branch: 'swarmaa/codex/abc',
    artifact_ids: [artId],
    reply_to_thread: threadId,
  });

  // Invalid base_ref rejected
  const bad = extractActionsBlock(
    `Bad.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([{
      type: 'handoff', to_agent: 'Reviewer', body: 'hi', base_ref: '--bad'
    }])}\n\`\`\``
  );
  assert.match(bad.error ?? '', /base_ref/);
});

test('mergeDispatchedFrom preserves array without clobbering or duplicating entries', () => {
  const a = { thread_id: 't1', scope: 'project:a', bot_id: 'b1', dispatch_group_id: 'g1' };
  const b = { thread_id: 't2', scope: 'project:b', bot_id: 'b2', dispatch_group_id: 'g2' };
  const merged = mergeDispatchedFrom(a, b);
  assert.equal(merged.length, 2);
  assert.equal(mergeDispatchedFrom(merged, a).length, 2);
  assert.deepEqual(normalizeDispatchedFrom(a), [a]);
});
