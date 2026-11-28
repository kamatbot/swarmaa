import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCondition } from '../errors.js';
import { AUTO_PATCH, AUTO_READ } from './swarm.js';
import type { RunnerConfig } from '../bridge/adapters.js';

export const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof VALID_EFFORTS[number];

export interface ProviderModelCatalog {
  default_model: string | null;
  turn_model?: string | null;
  models: string[];
  efforts: string[];
}

export interface ModelCatalog {
  providers: Record<string, ProviderModelCatalog>;
}

export interface WorkerProviderModelReport {
  default_model?: string | null;
  turn_model?: string | null;
  models?: string[];
  reported_at?: string;
}

const FALLBACK_CATALOG: ModelCatalog = {
  providers: {
    claude: {
      default_model: 'claude-sonnet-5-5',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      efforts: ['low', 'medium', 'high', 'max'],
    },
    codex: {
      default_model: 'gpt-5.4',
      models: ['gpt-6-astra', 'gpt-5.4', 'gpt-5.4-mini'],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    antigravity: {
      default_model: 'gemini-3.8-pro',
      models: ['gemini-3.8-pro', 'gemini-3.8-flash'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
    },
  },
};

let cachedStaticCatalog: ModelCatalog | undefined;

export function getStaticModelCatalog(): ModelCatalog {
  if (cachedStaticCatalog) return structuredClone(cachedStaticCatalog);
  const candidates = [
    fileURLToPath(new URL('../../config/models.json', import.meta.url)),
    path.resolve(process.cwd(), 'config/models.json'),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ModelCatalog;
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
        cachedStaticCatalog = parsed;
        return structuredClone(parsed);
      }
    } catch {
      // fall through to next candidate / embedded fallback
    }
  }
  cachedStaticCatalog = FALLBACK_CATALOG;
  return structuredClone(FALLBACK_CATALOG);
}

function inferredModelProvider(model: string): 'claude' | 'codex' | 'antigravity' | null {
  const raw = model.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('anthropic/')) return 'claude';
  if (raw.startsWith('openai/')) return 'codex';
  if (raw.startsWith('google/')) return 'antigravity';
  const base = raw.split('/').pop()!;
  if (base === 'sonnet' || base === 'opus' || base === 'haiku' || base.startsWith('claude-')) return 'claude';
  if (base.startsWith('gpt-') || /^o[134](?:-|$)/.test(base) || base.startsWith('codex')) return 'codex';
  if (base.startsWith('gemini-')) return 'antigravity';
  return null;
}

/**
 * Validates reasoning effort enum + provider compatibility and rejects obvious cross-provider model mismatches.
 * Custom/future model ids that belong to the right provider (or do not match another provider's family) are allowed.
 */
export function validateModelAndEffort(
  provider: string | null | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
  fieldPrefix = ''
): void {
  const catalog = getStaticModelCatalog();
  const p = provider ? provider.trim().toLowerCase() : null;
  const provCatalog = p ? catalog.providers[p] : undefined;

  if (effort !== undefined && effort !== null) {
    requireCondition(
      (VALID_EFFORTS as readonly string[]).includes(effort),
      400,
      'invalid_arguments',
      `${fieldPrefix}effort must be one of ${VALID_EFFORTS.join(', ')}.`
    );
    if (provCatalog && !provCatalog.efforts.includes(effort)) {
      requireCondition(
        false,
        400,
        'invalid_arguments',
        `${fieldPrefix}effort '${effort}' is not supported by ${p}; allowed: ${provCatalog.efforts.join(', ')}.`
      );
    }
  }

  if (p && model !== undefined && model !== null) {
    const inferred = inferredModelProvider(model);
    if (inferred && inferred !== p) {
      requireCondition(
        false,
        400,
        'invalid_arguments',
        `${fieldPrefix}model '${model}' is a ${inferred} model and cannot be used with provider '${p}'.`
      );
    }
  }
}

/** Merge static catalog with live workers' reported model catalogs. */
export function mergeModelCatalog(
  workerCatalogs: Array<Record<string, WorkerProviderModelReport> | null | undefined>
): ModelCatalog {
  const merged = getStaticModelCatalog();
  for (const catalog of workerCatalogs) {
    if (!catalog || typeof catalog !== 'object') continue;
    for (const [provider, report] of Object.entries(catalog)) {
      if (!report || typeof report !== 'object') continue;
      if (!merged.providers[provider]) {
        merged.providers[provider] = {
          default_model: null,
          models: [],
          efforts: [...VALID_EFFORTS],
        };
      }
      const target = merged.providers[provider]!;
      if (typeof report.default_model === 'string' && report.default_model.trim()) {
        target.default_model = report.default_model.trim();
      }
      if (typeof report.turn_model === 'string' && report.turn_model.trim()) {
        target.turn_model = report.turn_model.trim();
      }
      if (Array.isArray(report.models)) {
        const seen = new Set(target.models);
        for (const m of report.models) {
          if (typeof m === 'string' && m.trim() && !seen.has(m.trim())) {
            seen.add(m.trim());
            target.models.push(m.trim());
          }
        }
      }
    }
  }
  return merged;
}

export interface ResolvedTurnRunner {
  router: boolean;
  edits: boolean;
  routeKind: 'research' | 'patch' | 'review' | 'summary';
  capability: string;
  runner?: Record<string, unknown>;
}

export interface ResolveTurnRunnerInput {
  bot?: { id?: string; lead_agent_id: string; rules: Record<string, unknown>; routing: Record<string, unknown> } | null;
  agent: { id: string; edits: boolean; runner?: RunnerConfig | null };
  routeKind?: 'research' | 'patch' | 'review' | 'summary';
  /** Explicit per-message override (from thread_post.runner or requestedProvider). */
  override?: RunnerConfig | { mode?: 'auto'; provider?: string; model?: string; effort?: string } | null;
  /** First-reply quick model decision, when applicable (human chat turns only). */
  firstReply?: { capability?: string; runner: Record<string, unknown> } | null;
  /** Force read-only mode (e.g. swarm summary turns, fan-in synthesis turns). */
  forceReadOnly?: boolean;
  /** Mark runner.summary = true (reply-only summary/synthesis turn). */
  summary?: boolean;
  /** Force runner.fast = false (e.g. handoffs, schedules, answers). */
  noFast?: boolean;
}

/**
 * Unified turn runner resolution across all turn-queuing sites:
 *   explicit override -> firstReply (when active) -> bot.routing[kind] -> agent.runner -> auto.
 * Always produces permission_envelope.runner whenever provider/model/effort or flags (router/summary/fast) apply.
 */
export function resolveTurnRunner(input: ResolveTurnRunnerInput): ResolvedTurnRunner {
  const { bot, agent, override, firstReply, forceReadOnly = false, summary = false, noFast = false } = input;
  const isRouter = Boolean(bot && bot.rules?.lead_mode === 'router' && agent.id === bot.lead_agent_id);
  const edits = forceReadOnly || isRouter ? false : agent.edits;
  const routeKind: 'research' | 'patch' | 'review' | 'summary' =
    forceReadOnly || isRouter ? 'summary' : (input.routeKind ?? (edits ? 'patch' : 'summary'));

  const suffix = edits ? 'patch' : 'read';

  // 1. Explicit per-message runner override
  if (override) {
    if (override.mode === 'auto') {
      return {
        router: isRouter,
        edits,
        routeKind,
        capability: edits ? AUTO_PATCH : AUTO_READ,
        runner: {
          mode: 'auto',
          fast: false,
          ...(isRouter ? { router: true } : {}),
          ...(summary ? { summary: true } : {}),
        },
      };
    }
    if (override.provider) {
      return {
        router: isRouter,
        edits,
        routeKind,
        capability: `${override.provider}.${suffix}`,
        runner: {
          provider: override.provider,
          ...(override.model ? { model: override.model } : {}),
          ...(override.effort ? { effort: override.effort } : {}),
          fast: false,
          ...(isRouter ? { router: true } : {}),
          ...(summary ? { summary: true } : {}),
        },
      };
    }
  }

  // 2. Active quick first-reply model (only when it specifies a provider capability)
  if (!forceReadOnly && !summary && !isRouter && !noFast && firstReply?.capability) {
    return {
      router: false,
      edits,
      routeKind,
      capability: firstReply.capability,
      runner: { ...firstReply.runner },
    };
  }

  // 3. bot.routing[routeKind] -> fallback to agent.runner
  const botRoute = (bot?.routing && typeof bot.routing === 'object')
    ? (bot.routing[routeKind] as { mode?: string; provider?: string; model?: string; effort?: string } | undefined)
    : undefined;
  const agentRunner = agent.runner;

  let capability: string;
  const runnerObj: Record<string, unknown> = {};

  if (botRoute && botRoute.mode !== 'auto' && botRoute.mode !== 'different_from_author' && botRoute.provider) {
    capability = `${botRoute.provider}.${suffix}`;
    runnerObj.provider = botRoute.provider;
    if (botRoute.model) runnerObj.model = botRoute.model;
    if (botRoute.effort) runnerObj.effort = botRoute.effort;
  } else if (agentRunner && agentRunner.mode !== 'auto' && agentRunner.provider) {
    capability = `${agentRunner.provider}.${suffix}`;
    runnerObj.provider = agentRunner.provider;
    if (agentRunner.model) runnerObj.model = agentRunner.model;
    if (agentRunner.effort) runnerObj.effort = agentRunner.effort;
  } else {
    capability = edits ? AUTO_PATCH : AUTO_READ;
    if (agentRunner?.model) runnerObj.model = agentRunner.model;
    if (agentRunner?.effort) runnerObj.effort = agentRunner.effort;
  }

  if (isRouter) {
    runnerObj.fast = false;
    runnerObj.router = true;
  }
  if (summary) {
    runnerObj.fast = false;
    runnerObj.summary = true;
  }
  if (noFast || firstReply?.runner?.fast === false) {
    runnerObj.fast = false;
  }

  return {
    router: isRouter,
    edits,
    routeKind,
    capability,
    ...(Object.keys(runnerObj).length > 0 ? { runner: runnerObj } : {}),
  };
}

export interface DispatchedFromEntry {
  thread_id: string;
  scope: string;
  bot_id: string;
  dispatch_group_id?: string;
  hop_depth?: number;
}

export function normalizeDispatchedFrom(raw: unknown): DispatchedFromEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: DispatchedFromEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.thread_id !== 'string' || typeof obj.scope !== 'string' || typeof obj.bot_id !== 'string') continue;
    out.push({
      thread_id: obj.thread_id,
      scope: obj.scope,
      bot_id: obj.bot_id,
      ...(typeof obj.dispatch_group_id === 'string' ? { dispatch_group_id: obj.dispatch_group_id } : {}),
      ...(typeof obj.hop_depth === 'number' && Number.isFinite(obj.hop_depth) ? { hop_depth: obj.hop_depth } : {}),
    });
  }
  return out;
}

export function mergeDispatchedFrom(
  existing: unknown,
  incoming: DispatchedFromEntry | DispatchedFromEntry[] | undefined | null
): DispatchedFromEntry[] {
  const merged = normalizeDispatchedFrom(existing);
  const toAdd = normalizeDispatchedFrom(incoming);
  const seen = new Set(merged.map(e => `${e.thread_id}|${e.bot_id}|${e.dispatch_group_id ?? ''}`));
  for (const entry of toAdd) {
    const key = `${entry.thread_id}|${entry.bot_id}|${entry.dispatch_group_id ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}
