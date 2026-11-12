import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PRICES, loadPrices, priceGroup, priceUsage, aggregateUsageCost } from '../src/core/pricing.js';
import { TOOL_PERMISSIONS, TOOLS } from '../src/core/tools.js';
import { CoreService } from '../src/core/index.js';
import type { Principal } from '../src/types.js';

test('DEFAULT_PRICES is shipped empty in code and unknown models return null', () => {
  assert.deepEqual(DEFAULT_PRICES, {});
  // Without any prices configured, models return null
  assert.deepEqual(priceUsage('claude', 'claude-3-5-sonnet', { input_tokens: 1000, output_tokens: 500 }), { usd: null });
  assert.deepEqual(priceUsage('codex', 'gpt-4o', { input_tokens: 1000, output_tokens: 500 }), { usd: null });
  assert.deepEqual(priceUsage('antigravity', 'gemini-2.0-flash', { input_tokens: 1000, output_tokens: 500 }), { usd: null });
  assert.deepEqual(priceUsage(null, null, { input_tokens: 1000, output_tokens: 500 }), { usd: null });
  assert.deepEqual(priceUsage('claude', 'claude-3-5-sonnet', null), { usd: null });
});

test('priceUsage charges cached input at cached rate, not input rate', () => {
  const customPrices = {
    'claude-3-5-sonnet': {
      input: 3.0,
      cached_input: 0.3,
      output: 15.0,
    },
  };

  // 1M cached input tokens only: at $0.3/M cached rate, cost must be $0.3, not $3.0
  const cachedOnly = priceUsage('claude', 'claude-3-5-sonnet', {
    input_tokens: 0,
    cached_input_tokens: 1_000_000,
    output_tokens: 0,
  }, customPrices);
  assert.equal(cachedOnly.usd, 0.3);

  // 1M normal input tokens only: at $3.0/M input rate, cost must be $3.0
  const inputOnly = priceUsage('claude', 'claude-3-5-sonnet', {
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    output_tokens: 0,
  }, customPrices);
  assert.equal(inputOnly.usd, 3.0);

  // 1M output tokens only: at $15.0/M output rate, cost must be $15.0
  const outputOnly = priceUsage('claude', 'claude-3-5-sonnet', {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 1_000_000,
  }, customPrices);
  assert.equal(outputOnly.usd, 15.0);

  // Combined usage: 1M input ($3) + 1M cached input ($0.3) + 1M output ($15) = $18.3
  const combined = priceUsage('claude', 'claude-3-5-sonnet', {
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  }, customPrices);
  assert.equal(combined.usd, 18.3);
});

test('mixed models in a group are priced per model subgroup, not pre-summed', () => {
  const customPrices = {
    'claude-haiku-4': {
      input: 1.0,
      cached_input: 0.1,
      output: 5.0,
    },
    'claude-opus-5': {
      input: 15.0,
      cached_input: 1.5,
      output: 75.0,
    },
  };

  const groupSubgroups = [
    {
      provider: 'claude',
      model: 'claude-haiku-4',
      usage: { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 },
      // haiku cost: 1.0 * 1 + 0.5 * 0.1 + 0.1 * 5.0 = 1.0 + 0.05 + 0.5 = 1.55
    },
    {
      provider: 'claude',
      model: 'claude-opus-5',
      usage: { input_tokens: 200_000, cached_input_tokens: 100_000, output_tokens: 50_000 },
      // opus cost: 0.2 * 15.0 + 0.1 * 1.5 + 0.05 * 75.0 = 3.0 + 0.15 + 3.75 = 6.9
    },
  ];

  const result = priceGroup(groupSubgroups, customPrices);
  assert.equal(result.has_unpriced, false);
  assert.equal(result.usd, 8.45); // 1.55 + 6.9 = 8.45

  // If one model in the group is unknown, group usd is null and has_unpriced is true
  const groupWithUnknown = [
    ...groupSubgroups,
    {
      provider: 'claude',
      model: 'experimental-unlisted-model',
      usage: { input_tokens: 1000, output_tokens: 500 },
    },
  ];
  const resultWithUnknown = priceGroup(groupWithUnknown, customPrices);
  assert.equal(resultWithUnknown.usd, null);
  assert.equal(resultWithUnknown.has_unpriced, true);
});

test('SWARMAA_PRICING_FILE owner override is read and merged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-pricing-test-'));
  const file = join(dir, 'pricing.json');
  try {
    const override = {
      'gpt-6': {
        input: 10.0,
        cached_input: 1.0,
        output: 50.0,
      },
      'gpt-5': {
        input: 1.25,
        cached_input: 0.125,
        output: 10.0,
      },
    };
    writeFileSync(file, JSON.stringify(override, null, 2));

    const oldEnv = process.env.SWARMAA_PRICING_FILE;
    process.env.SWARMAA_PRICING_FILE = file;
    try {
      const prices = loadPrices();
      assert.ok(prices['gpt-6']);
      assert.equal(prices['gpt-6'].input, 10.0);
      assert.equal(prices['gpt-6'].cached_input, 1.0);
      assert.equal(prices['gpt-6'].output, 50.0);

      const priced = priceUsage('codex', 'gpt-5', {
        input_tokens: 1_000_000,
        cached_input_tokens: 800_000,
        output_tokens: 100_000,
      });
      // 1.0 * 1.25 + 0.8 * 0.125 + 0.1 * 10.0 = 1.25 + 0.1 + 1.0 = 2.35
      assert.equal(priced.usd, 2.35);
    } finally {
      if (oldEnv === undefined) delete process.env.SWARMAA_PRICING_FILE;
      else process.env.SWARMAA_PRICING_FILE = oldEnv;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SWARMAA_PRICING_FILE supports array prices format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-pricing-arr-test-'));
  const file = join(dir, 'prices-arr.json');
  try {
    const override = {
      prices: [
        { model: 'claude-fable-5', input: 10, output: 50, cacheRead: 1 },
      ],
    };
    writeFileSync(file, JSON.stringify(override));
    const prices = loadPrices(file);
    assert.ok(prices['claude-fable-5']);
    assert.equal(prices['claude-fable-5'].input, 10);
    assert.equal(prices['claude-fable-5'].cached_input, 1);
    assert.equal(prices['claude-fable-5'].output, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage_cost appears in MCP tool list and requires exact scope', () => {
  const tool = TOOLS.find(t => t.name === 'usage_cost');
  assert.ok(tool, 'usage_cost must exist in TOOLS');
  assert.equal(TOOL_PERMISSIONS.usage_cost, 'task:read');

  // Exact scope required in input schema
  assert.ok(Array.isArray(tool.inputSchema.required));
  assert.ok(tool.inputSchema.required.includes('scope'), 'scope must be required');
  assert.equal(tool.annotations?.readOnlyHint, true);

  // Listing tools via CoreService filters by permissions
  const mockPool = {} as any;
  const core = new CoreService(mockPool);

  const adminPrincipal: Principal = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'test-tenant',
    name: 'admin',
    role: 'admin',
    scopes: ['project:demo'],
    permissions: ['admin', 'task:read'],
  };
  const adminTools = core.listTools(adminPrincipal);
  assert.ok(adminTools.some(t => t.name === 'usage_cost'));

  const workerPrincipal: Principal = {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'test-tenant',
    name: 'worker',
    role: 'worker',
    scopes: ['project:demo'],
    permissions: ['task:read', 'task:claim', 'task:work'],
  };
  const workerTools = core.listTools(workerPrincipal);
  assert.ok(workerTools.some(t => t.name === 'usage_cost'));

  const restrictedPrincipal: Principal = {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: 'test-tenant',
    name: 'restricted',
    role: 'frontend',
    scopes: ['project:demo'],
    permissions: ['thread:read'], // No task:read
  };
  const restrictedTools = core.listTools(restrictedPrincipal);
  assert.equal(restrictedTools.some(t => t.name === 'usage_cost'), false);
});

test('aggregateUsageCost enforces exact scope and input validation', async () => {
  const mockPool = {
    query: async () => ({ rows: [] }),
  } as any;

  const principal: Principal = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'test-tenant',
    name: 'tester',
    role: 'frontend',
    scopes: ['project:allowed'],
    permissions: ['task:read'],
  };

  // Scope forbidden
  await assert.rejects(
    () => aggregateUsageCost(mockPool, principal, { scope: 'project:forbidden' }),
    { name: 'AppError', code: 'scope_forbidden', status: 403 }
  );

  // Missing scope
  await assert.rejects(
    () => aggregateUsageCost(mockPool, principal, {}),
    { name: 'AppError', code: 'invalid_arguments', status: 400 }
  );

  // Extra keys rejected
  await assert.rejects(
    () => aggregateUsageCost(mockPool, principal, { scope: 'project:allowed', extra: true }),
    { name: 'AppError', code: 'invalid_arguments', status: 400 }
  );

  // Invalid group_by
  await assert.rejects(
    () => aggregateUsageCost(mockPool, principal, { scope: 'project:allowed', group_by: 'invalid' }),
    { name: 'AppError', code: 'invalid_arguments', status: 400 }
  );

  // Invalid since timestamp
  await assert.rejects(
    () => aggregateUsageCost(mockPool, principal, { scope: 'project:allowed', since: 'not-a-date' }),
    { name: 'AppError', code: 'invalid_arguments', status: 400 }
  );

  // Valid call with empty query result returns default structure
  const emptyRes = await aggregateUsageCost(mockPool, principal, { scope: 'project:allowed' });
  assert.equal(emptyRes.groups.length, 0);
  assert.equal(emptyRes.total_usd, 0);
  assert.equal(emptyRes.has_unpriced, false);
  assert.match(emptyRes.since, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);

  // Dispatch via core.call
  const core = new CoreService(mockPool);
  const coreRes = await core.call(principal, 'usage_cost', { scope: 'project:allowed' }) as any;
  assert.equal(coreRes.groups.length, 0);
  assert.equal(coreRes.total_usd, 0);
  assert.equal(coreRes.has_unpriced, false);
});

test('aggregateUsageCost correctly aggregates SQL rows across models and groups', async () => {
  const customPrices = {
    'claude-3-5-sonnet': { input: 3.0, cached_input: 0.3, output: 15.0 },
    'gpt-4o': { input: 2.5, cached_input: 1.25, output: 10.0 },
  };

  const sampleRows = [
    // Bot Alpha used sonnet
    {
      group_key: 'bot-1',
      group_label: 'AlphaBot',
      provider: 'claude',
      model: 'claude-3-5-sonnet',
      input_tokens: '1000000',
      cached_input_tokens: '500000',
      output_tokens: '100000',
      runs: '2',
    },
    // Bot Alpha also used gpt-4o
    {
      group_key: 'bot-1',
      group_label: 'AlphaBot',
      provider: 'codex',
      model: 'gpt-4o',
      input_tokens: '2000000',
      cached_input_tokens: '1000000',
      output_tokens: '200000',
      runs: '3',
    },
    // Bot Beta used an unpriced model
    {
      group_key: 'bot-2',
      group_label: 'BetaBot',
      provider: 'antigravity',
      model: 'unpriced-gemini',
      input_tokens: '10000',
      cached_input_tokens: '0',
      output_tokens: '5000',
      runs: '1',
    },
  ];

  let executedQuery = '';
  const mockPool = {
    query: async (q: string) => {
      executedQuery = q;
      return { rows: sampleRows };
    },
  } as any;

  const principal: Principal = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'test-tenant',
    name: 'tester',
    role: 'frontend',
    scopes: ['project:demo'],
    permissions: ['task:read'],
  };

  const res = await aggregateUsageCost(mockPool, principal, {
    scope: 'project:demo',
    since: '2026-11-01T00:00:00Z',
    group_by: 'bot',
  }, customPrices);

  assert.equal(res.since, '2026-11-01T00:00:00.000Z');
  assert.equal(res.groups.length, 2);

  // Group 1: AlphaBot
  const alpha = res.groups.find(g => g.key === 'bot-1')!;
  assert.equal(alpha.label, 'AlphaBot');
  assert.equal(alpha.input_tokens, 3_000_000);
  assert.equal(alpha.cached_input_tokens, 1_500_000);
  assert.equal(alpha.output_tokens, 300_000);
  assert.equal(alpha.runs, 5);
  // sonnet cost: 1.0 * 3.0 + 0.5 * 0.3 + 0.1 * 15.0 = 3.0 + 0.15 + 1.5 = 4.65
  // gpt-4o cost: 2.0 * 2.5 + 1.0 * 1.25 + 0.2 * 10.0 = 5.0 + 1.25 + 2.0 = 8.25
  // total alpha cost = 4.65 + 8.25 = 12.9
  assert.equal(alpha.usd, 12.9);

  // Group 2: BetaBot (has unpriced model)
  const beta = res.groups.find(g => g.key === 'bot-2')!;
  assert.equal(beta.label, 'BetaBot');
  assert.equal(beta.usd, null);
  assert.equal(beta.runs, 1);

  // Overall totals
  assert.equal(res.total_usd, 12.9);
  assert.equal(res.has_unpriced, true);
});
