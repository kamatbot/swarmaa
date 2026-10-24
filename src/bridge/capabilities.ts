import type { AgentConfig, Provider } from './types.js';

/** Static adapter contract. It is not a readiness probe or a successful task receipt. */
export interface RuntimeCapabilities {
  schema_version: 1;
  provider: Provider;
  transport: 'headless-cli';
  delivery: { modes: ['next-run']; live_injection: false; stream_acknowledgement: false };
  execution: { wallclock_bounded: true; output_bounded: true; termination_scope: 'process-group'; filesystem_confinement: 'required-seatbelt'; patch: boolean };
  lifecycle: { cancel: true; pause: false; fork: false; native_resume: 'artifact-only' | 'unavailable' };
  observability: { process_exit: 'observed-or-unavailable'; output_bytes: 'exact'; provider_terminal: 'provider-reported'; tool_activity: 'unavailable'; model_reasoning: 'unavailable' };
  provenance: { source: 'static-local-configuration'; cli_version: 'unverified' };
  acceptance_criteria_verified: false;
}

/** Returned native-session artifacts are same-provider continuation hints only. */
export function runtimeCapabilities(agent: AgentConfig): RuntimeCapabilities {
  return {
    schema_version: 1, provider: agent.provider, transport: 'headless-cli',
    delivery: { modes: ['next-run'], live_injection: false, stream_acknowledgement: false },
    execution: { wallclock_bounded: true, output_bounded: true, termination_scope: 'process-group', filesystem_confinement: 'required-seatbelt', patch: agent.enable_patch },
    lifecycle: { cancel: true, pause: false, fork: false, native_resume: agent.provider === 'antigravity' ? 'unavailable' : 'artifact-only' },
    observability: { process_exit: 'observed-or-unavailable', output_bytes: 'exact', provider_terminal: 'provider-reported', tool_activity: 'unavailable', model_reasoning: 'unavailable' },
    provenance: { source: 'static-local-configuration', cli_version: 'unverified' },
    acceptance_criteria_verified: false,
  };
}
