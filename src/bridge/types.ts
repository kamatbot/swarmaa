export type TaskKind = 'research' | 'review' | 'patch';
export type Provider = 'claude' | 'codex' | 'antigravity';

export interface AgentConfig {
  id: string;
  provider: Provider;
  binary: string;
  model?: string;
  enable_patch: boolean;
}
export interface ProjectConfig {
  scope: string;
  root: string;
  agents: string[];
  allow_patch: boolean;
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
  max_output_bytes: number;
  max_prompt_bytes: number;
  agents: AgentConfig[];
  projects: ProjectConfig[];
  reason?: { binary: string; recipient: string; cwd: string };
}
export interface Task {
  id: string;
  scope: string;
  kind: TaskKind;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  resource_key: string | null;
  required_capability: string;
  checkpoint: Record<string, unknown> | null;
  context_refs: string[];
  instructions?: unknown[];
  version: number;
}
export interface Claim {
  task: Task | null;
  lease_token?: string;
  lease_generation?: number;
}
export interface Lease {
  task_id: string;
  lease_token: string;
  lease_generation: number;
}
export interface ToolClient {
  call<T = unknown>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}
export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeout_ms: number;
  max_output_bytes: number;
  signal?: AbortSignal;
  on_progress?: (progress: { output_bytes: number; stdout_tail: string }) => void;
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
