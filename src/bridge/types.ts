import type { FlowTask } from '../core/flow-definition.js';
export type TaskKind = 'research' | 'review' | 'patch' | 'check' | 'turn';
export type Provider = 'claude' | 'codex' | 'antigravity';
export type AntigravityAuthMode = 'oauth' | 'api_key' | 'enterprise' | 'agent_platform';

export interface AgentConfig {
  id: string;
  provider: Provider;
  binary: string;
  model?: string;
  /** Explicit auth mode for providers with unattended OAuth restrictions (e.g. antigravity). */
  auth_mode?: AntigravityAuthMode;
  enable_patch: boolean;
  /** macOS Seatbelt confinement of the provider process (default true). */
  sandbox: boolean;
}
export interface CheckCommand { command:string; args:string[]; timeout_seconds:number }
export interface ProjectConfig {
  scope: string;
  root: string;
  agents: string[];
  allow_patch: boolean;
  checks?: Partial<Record<'tests_pass'|'build_passes',CheckCommand>>;
}
export interface BridgeConfig {
  service_url: string;
  token_env: string;
  token_file?: string;
  poll_seconds: number;
  usage_seconds: number;
  lease_seconds: number;
  heartbeat_seconds: number;
  request_timeout_ms: number;
  task_timeout_seconds: number;
  /** Tasks one bridge process runs at once (each in its own sandbox; patches in their own worktree). */
  max_concurrent: number;
  max_output_bytes: number;
  max_prompt_bytes: number;
  agents: AgentConfig[];
  projects: ProjectConfig[];
  reason?: { binary: string; recipient: string; cwd: string };
}
export interface Task {
  id: string;
  flow_id?: string;
  flow?: FlowTask;
  scope: string;
  kind: TaskKind;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  resource_key: string | null;
  required_capability: string;
  /** Patch only: ref/commit to branch the worktree from; empty or absent means HEAD. */
  base_ref?: string | null;
  checkpoint: Record<string, unknown> | null;
  context_refs: string[];
  instructions?: unknown[];
  /** Optional provider session id populated from agent_provider_sessions on turn claim. */
  native_session_id?: string | null;
  /** Optional swarm metadata populated on swarm step/summary turns. */
  swarm?: { id?: string; title?: string; goal?: string } | null;
  version: number;
}
export interface ProviderModelInfo {
  id: string;
  label: string;
  efforts?: string[];
  fast?: boolean;
  default?: boolean;
}
export interface Claim {
  task: Task | null;
  lease_token?: string;
  lease_generation?: number;
  /** Router decision for auto.* tasks: the provider to run (null = any allowed) and the providers the policy enables. */
  route?: { provider: string | null; allowed: string[] };
  /** Present when task_claim is called with limit > 1 on a batch-capable service. */
  claims?: Claim[];
}
export interface Lease {
  task_id: string;
  lease_token: string;
  lease_generation: number;
}
export interface ToolClient {
  call<T = unknown>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}
export interface AcpImageInput {
  seq: string;
  data: string;
  mimeType?: string;
}

export interface AcpRequestConfig {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  images?: AcpImageInput[];
  patch?: boolean;
  resume_session_id?: string;
  dangerously_skip_permissions?: boolean;
}

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  /** The prompt text as built, for the context receipt; runners ignore it. */
  prompt?: string;
  /** When set, run this request over the official Agent Client Protocol (ACP) JSON-RPC 2.0 stdio transport. */
  acp?: AcpRequestConfig;
  /** Pool key metadata computed by buildInvocation for warm resident provider processes; runners ignore it. */
  pool_meta?: { model?: string; effort?: string; light_chat?: boolean; patch?: boolean };
  timeout_ms: number;
  max_output_bytes: number;
  signal?: AbortSignal;
  /** Written with pid/pgid/start marker while the child lives, removed on exit, so a later bridge can fence an orphan. */
  pidfile?: string;
  on_progress?: (progress: { output_bytes: number; stdout_bytes?: number; stdout_tail: string }) => void;
  /** Leave stdin open after `input`; the runner hands the caller a writer through on_stdin. */
  keep_stdin_open?: boolean;
  on_stdin?: (stdin: { write: (text: string) => boolean; end: () => void }) => void;
  /** Each complete stdout line as its first and last 2048 characters (an event's type may be at either end). */
  on_line?: (head: string, tail: string) => void;
}
export interface ProcessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  stop_reason: 'timeout' | 'output_limit' | 'aborted' | 'spawn_error' | null;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export type BridgeLogger = (event: string, metadata?: Record<string, unknown>) => void;
