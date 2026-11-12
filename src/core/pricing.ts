import { existsSync, readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { getPricingFile } from '../config.js';
import { requireCondition } from '../errors.js';
import type { Principal } from '../types.js';
import { enumValue, scopeName, string } from '../validation.js';
import { sameModel } from './failures.js';
import { assertKnownScope, noExtraKeys } from './shared.js';

export interface ModelPricing {
  input: number;
  cached_input?: number;
  output: number;
}

export interface TokenUsageInput {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export interface PriceResult {
  usd: number | null;
}

export interface UsageCostGroup {
  key: string;
  label: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  usd: number | null;
  runs: number;
}

export interface UsageCostResult {
  since: string;
  groups: UsageCostGroup[];
  total_usd: number;
  has_unpriced: boolean;
}

/** Default price table is shipped empty; populated only by owner override via SWARMAA_PRICING_FILE. */
export const DEFAULT_PRICES: Record<string, ModelPricing> = {};

/**
 * Loads price table from DEFAULT_PRICES combined with owner overrides from SWARMAA_PRICING_FILE.
 */
export function loadPrices(filePath?: string): Record<string, ModelPricing> {
  const file = filePath !== undefined ? filePath : getPricingFile();
  const prices: Record<string, ModelPricing> = { ...DEFAULT_PRICES };
  if (!file) return prices;

  try {
    if (!existsSync(file)) return prices;
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return prices;

    if (Array.isArray(data.prices)) {
      for (const item of data.prices) {
        if (!item || typeof item !== 'object') continue;
        const modelId = typeof item.model === 'string' ? item.model : (typeof item.id === 'string' ? item.id : undefined);
        if (!modelId || typeof item.input !== 'number' || typeof item.output !== 'number') continue;
        const cached = typeof item.cached_input === 'number'
          ? item.cached_input
          : (typeof item.cacheRead === 'number' ? item.cacheRead : undefined);
        prices[modelId] = {
          input: item.input,
          ...(cached !== undefined ? { cached_input: cached } : {}),
          output: item.output,
        };
      }
    } else {
      const entries = (data.prices && typeof data.prices === 'object') ? data.prices : data;
      for (const [key, val] of Object.entries(entries)) {
        if (key.startsWith('_')) continue;
        if (!val || typeof val !== 'object') continue;
        const item = val as Record<string, unknown>;
        if (typeof item.input !== 'number' || typeof item.output !== 'number') continue;
        const cached = typeof item.cached_input === 'number'
          ? item.cached_input
          : (typeof item.cacheRead === 'number' ? item.cacheRead : undefined);
        prices[key] = {
          input: item.input,
          ...(cached !== undefined ? { cached_input: cached } : {}),
          output: item.output,
        };
      }
    }
  } catch {
    // Return base prices on error
  }
  return prices;
}

/**
 * Looks up model pricing by model ID (exact, lowercase, provider-prefixed, stripped, or sameModel match).
 */
export function findModelPricing(
  provider: string | null | undefined,
  model: string | null | undefined,
  prices: Record<string, ModelPricing>
): ModelPricing | undefined {
  if (!model || typeof model !== 'string') return undefined;
  const m = model.trim();
  if (!m) return undefined;

  // 1. Direct exact match
  if (prices[m]) return prices[m];

  // 2. Case-insensitive match
  const mLower = m.toLowerCase();
  if (prices[mLower]) return prices[mLower];

  // 3. Provider prefixed in table
  if (provider) {
    const prov = provider.trim().toLowerCase();
    if (prices[`${prov}/${m}`]) return prices[`${prov}/${m}`];
    if (prices[`${prov}:${m}`]) return prices[`${prov}:${m}`];
    if (prices[`${prov}/${mLower}`]) return prices[`${prov}/${mLower}`];
    if (prices[`${prov}:${mLower}`]) return prices[`${prov}:${mLower}`];
  }

  // 4. Model has provider prefix, but table has stripped model id
  if (m.includes('/')) {
    const stripped = m.split('/').pop()!;
    if (prices[stripped]) return prices[stripped];
    if (prices[stripped.toLowerCase()]) return prices[stripped.toLowerCase()];
  }

  // 5. sameModel match
  for (const [key, pricing] of Object.entries(prices)) {
    if (sameModel(key, m)) {
      return pricing;
    }
  }

  return undefined;
}

/**
 * Calculates USD cost for token usage on a given model.
 * Prices are USD per million tokens for input, cached_input, and output.
 * Cached input is charged at the cached rate, not the input rate.
 * Unknown model returns { usd: null }.
 */
export function priceUsage(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: TokenUsageInput | null | undefined,
  customPrices?: Record<string, ModelPricing>
): PriceResult {
  if (!model || !usage) return { usd: null };

  const prices = customPrices ?? loadPrices();
  const pricing = findModelPricing(provider, model, prices);
  if (!pricing) return { usd: null };

  const inputTokens = typeof usage.input_tokens === 'number' && usage.input_tokens > 0 ? usage.input_tokens : 0;
  const cachedTokens = typeof usage.cached_input_tokens === 'number' && usage.cached_input_tokens > 0 ? usage.cached_input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' && usage.output_tokens > 0 ? usage.output_tokens : 0;

  const cachedRate = typeof pricing.cached_input === 'number' ? pricing.cached_input : 0;

  // Cached input is charged at the cached rate, not the input rate.
  const cost = (inputTokens * pricing.input + cachedTokens * cachedRate + outputTokens * pricing.output) / 1_000_000;
  const usd = Number(cost.toFixed(8));
  return { usd };
}

/**
 * Prices a group composed of multiple model/subgroup usages without pre-summing tokens across models.
 */
export function priceGroup(
  subgroups: Array<{ provider?: string; model?: string; usage: TokenUsageInput }>,
  customPrices?: Record<string, ModelPricing>
): { usd: number | null; has_unpriced: boolean } {
  let totalUsd = 0;
  let hasUnpriced = false;

  for (const item of subgroups) {
    const res = priceUsage(item.provider, item.model, item.usage, customPrices);
    if (res.usd === null) {
      hasUnpriced = true;
    } else {
      totalUsd += res.usd;
    }
  }

  return {
    usd: hasUnpriced ? null : Number(totalUsd.toFixed(8)),
    has_unpriced: hasUnpriced,
  };
}

/**
 * Aggregates token usage and API-equivalent cost for tasks in an exact scope.
 */
export async function aggregateUsageCost(
  pool: Pool,
  p: Principal,
  input: Record<string, unknown>,
  customPrices?: Record<string, ModelPricing>
): Promise<UsageCostResult> {
  noExtraKeys(input, ['scope', 'since', 'group_by']);
  const scope = scopeName(input.scope);
  assertKnownScope(p, scope);

  let sinceDate: Date;
  if (input.since !== undefined) {
    const sinceStr = string(input.since, 'since', 100);
    sinceDate = new Date(sinceStr);
    requireCondition(!isNaN(sinceDate.getTime()), 400, 'invalid_arguments', 'since must be a valid ISO date-time string.');
  } else {
    const now = new Date();
    sinceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  const groupBy = input.group_by === undefined
    ? 'bot'
    : enumValue(input.group_by, 'group_by', ['bot', 'model', 'provider', 'day'] as const);

  const prices = customPrices ?? loadPrices();

  let query: string;
  if (groupBy === 'bot') {
    query = `SELECT
      COALESCE(t.bot_id::text, 'none') AS group_key,
      COALESCE(b.name, t.bot_id::text, 'none') AS group_label,
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', '') AS provider,
      COALESCE(t.result->'served'->>'model', t.result->>'model', '') AS model,
      SUM(CASE WHEN (t.result->'usage'->>'input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'input_tokens')::bigint ELSE 0 END)::bigint AS input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'cached_input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'cached_input_tokens')::bigint ELSE 0 END)::bigint AS cached_input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'output_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'output_tokens')::bigint ELSE 0 END)::bigint AS output_tokens,
      COUNT(*)::bigint AS runs
    FROM tasks t
    LEFT JOIN bots b ON b.id = t.bot_id AND b.tenant_id = t.tenant_id
    WHERE t.tenant_id = $1
      AND t.scope = $2
      AND t.created_at >= $3
      AND t.result IS NOT NULL
      AND jsonb_typeof(t.result->'usage') = 'object'
    GROUP BY group_key, group_label, provider, model
    ORDER BY group_key ASC`;
  } else if (groupBy === 'model') {
    query = `SELECT
      COALESCE(t.result->'served'->>'model', t.result->>'model', 'unknown') AS group_key,
      COALESCE(t.result->'served'->>'model', t.result->>'model', 'unknown') AS group_label,
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', '') AS provider,
      COALESCE(t.result->'served'->>'model', t.result->>'model', 'unknown') AS model,
      SUM(CASE WHEN (t.result->'usage'->>'input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'input_tokens')::bigint ELSE 0 END)::bigint AS input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'cached_input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'cached_input_tokens')::bigint ELSE 0 END)::bigint AS cached_input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'output_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'output_tokens')::bigint ELSE 0 END)::bigint AS output_tokens,
      COUNT(*)::bigint AS runs
    FROM tasks t
    WHERE t.tenant_id = $1
      AND t.scope = $2
      AND t.created_at >= $3
      AND t.result IS NOT NULL
      AND jsonb_typeof(t.result->'usage') = 'object'
    GROUP BY group_key, group_label, provider, model
    ORDER BY group_key ASC`;
  } else if (groupBy === 'provider') {
    query = `SELECT
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', 'unknown') AS group_key,
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', 'unknown') AS group_label,
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', 'unknown') AS provider,
      COALESCE(t.result->'served'->>'model', t.result->>'model', '') AS model,
      SUM(CASE WHEN (t.result->'usage'->>'input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'input_tokens')::bigint ELSE 0 END)::bigint AS input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'cached_input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'cached_input_tokens')::bigint ELSE 0 END)::bigint AS cached_input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'output_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'output_tokens')::bigint ELSE 0 END)::bigint AS output_tokens,
      COUNT(*)::bigint AS runs
    FROM tasks t
    WHERE t.tenant_id = $1
      AND t.scope = $2
      AND t.created_at >= $3
      AND t.result IS NOT NULL
      AND jsonb_typeof(t.result->'usage') = 'object'
    GROUP BY group_key, group_label, provider, model
    ORDER BY group_key ASC`;
  } else {
    // day
    query = `SELECT
      to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS group_key,
      to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS group_label,
      COALESCE(t.result->'served'->>'provider', t.result->>'provider', '') AS provider,
      COALESCE(t.result->'served'->>'model', t.result->>'model', '') AS model,
      SUM(CASE WHEN (t.result->'usage'->>'input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'input_tokens')::bigint ELSE 0 END)::bigint AS input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'cached_input_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'cached_input_tokens')::bigint ELSE 0 END)::bigint AS cached_input_tokens,
      SUM(CASE WHEN (t.result->'usage'->>'output_tokens') ~ '^[0-9]+$' THEN (t.result->'usage'->>'output_tokens')::bigint ELSE 0 END)::bigint AS output_tokens,
      COUNT(*)::bigint AS runs
    FROM tasks t
    WHERE t.tenant_id = $1
      AND t.scope = $2
      AND t.created_at >= $3
      AND t.result IS NOT NULL
      AND jsonb_typeof(t.result->'usage') = 'object'
    GROUP BY group_key, group_label, provider, model
    ORDER BY group_key ASC`;
  }

  const result = await pool.query<{
    group_key: string;
    group_label: string;
    provider: string;
    model: string;
    input_tokens: string | number;
    cached_input_tokens: string | number;
    output_tokens: string | number;
    runs: string | number;
  }>(query, [p.tenantId, scope, sinceDate]);

  const groupMap = new Map<string, {
    key: string;
    label: string;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    runs: number;
    subgroups: Array<{ provider: string; model: string; usage: TokenUsageInput }>;
  }>();

  for (const row of result.rows) {
    let group = groupMap.get(row.group_key);
    if (!group) {
      group = {
        key: row.group_key,
        label: row.group_label,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        runs: 0,
        subgroups: [],
      };
      groupMap.set(row.group_key, group);
    }
    const inp = Number(row.input_tokens) || 0;
    const cache = Number(row.cached_input_tokens) || 0;
    const out = Number(row.output_tokens) || 0;
    const runs = Number(row.runs) || 0;

    group.input_tokens += inp;
    group.cached_input_tokens += cache;
    group.output_tokens += out;
    group.runs += runs;
    group.subgroups.push({
      provider: row.provider,
      model: row.model,
      usage: {
        input_tokens: inp,
        cached_input_tokens: cache,
        output_tokens: out,
      },
    });
  }

  let totalUsd = 0;
  let hasUnpriced = false;
  const groups: UsageCostGroup[] = [];

  for (const group of groupMap.values()) {
    let groupUsd: number | null = 0;
    let groupUnpriced = false;

    for (const sub of group.subgroups) {
      const res = priceUsage(sub.provider, sub.model, sub.usage, prices);
      if (res.usd === null) {
        groupUnpriced = true;
        hasUnpriced = true;
      } else if (groupUsd !== null) {
        groupUsd += res.usd;
      }
    }

    const finalGroupUsd = groupUnpriced ? null : Number(groupUsd!.toFixed(8));
    if (finalGroupUsd !== null) {
      totalUsd += finalGroupUsd;
    }

    groups.push({
      key: group.key,
      label: group.label,
      input_tokens: group.input_tokens,
      cached_input_tokens: group.cached_input_tokens,
      output_tokens: group.output_tokens,
      usd: finalGroupUsd,
      runs: group.runs,
    });
  }

  return {
    since: sinceDate.toISOString(),
    groups,
    total_usd: Number(totalUsd.toFixed(8)),
    has_unpriced: hasUnpriced,
  };
}
