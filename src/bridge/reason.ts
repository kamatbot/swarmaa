import { providerEnvironment } from './adapters.js';
import { runBoundedProcess } from './process.js';
import type { BridgeConfig, ProcessResult, ProcessRunner } from './types.js';

type ReasonConfig = NonNullable<BridgeConfig['reason']>;

/** Uses the installed `reason-network` binary. No installer, relay endpoint, or shell. */
export async function reasonWho(config: ReasonConfig, tokenEnv: string, runner: ProcessRunner = runBoundedProcess): Promise<ProcessResult> {
  return runner({ command: config.binary, args: ['who', '--json'], cwd: config.cwd,
    env: providerEnvironment('reason', process.env, tokenEnv), input: '', timeout_ms: 10000, max_output_bytes: 32 * 1024 });
}

export async function reasonNotify(config: ReasonConfig, tokenEnv: string, taskId: string, outcome: string, runner: ProcessRunner = runBoundedProcess): Promise<ProcessResult> {
  if (!/^[a-f0-9-]{36}$/iu.test(taskId) || !['completed', 'failed', 'blocked'].includes(outcome)) throw new Error('Invalid notification metadata');
  return runner({ command: config.binary,
    args: ['send', config.recipient, `Swarmaa task ${taskId}: ${outcome}. Retrieve the authorized result from Swarmaa.`],
    cwd: config.cwd, env: providerEnvironment('reason', process.env, tokenEnv), input: '', timeout_ms: 10000, max_output_bytes: 8192 });
}
