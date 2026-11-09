import { matchesGlob } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMIT } from '../core/flow-definition.js';
import { redactSecrets } from '../safety/redact.js';
import { wrapCommand } from './sandbox.js';
import { inspectWorktree } from './worktree.js';
import type { Worktree } from './worktree.js';
import type { AgentConfig, BridgeConfig, CheckCommand, ProcessRunner, ProjectConfig, Task } from './types.js';

async function runCheckCommand(command:CheckCommand,agent:AgentConfig,config:BridgeConfig,worktree:Worktree,runner:ProcessRunner,signal:AbortSignal) {
  // Check commands get a small environment, without service/provider tokens or shell startup overrides.
  const env:NodeJS.ProcessEnv = {PATH:`/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,HOME:process.env.HOME,
    TMPDIR:process.env.TMPDIR ?? tmpdir(),LANG:process.env.LANG ?? 'en_US.UTF-8',NO_COLOR:'1',TERM:'dumb'};
  const invocation = agent.sandbox ? wrapCommand(command.command,command.args,{provider:agent.provider,binary:command.command,
    projectRoot:worktree.dir,gitDir:worktree.gitDir,patch:true,tmp:env.TMPDIR}) : {command:command.command,args:command.args};
  const result = await runner({...invocation,cwd:worktree.dir,env,input:'',signal,
    timeout_ms:Math.min(command.timeout_seconds,config.task_timeout_seconds)*1000,max_output_bytes:config.max_output_bytes});
  return {exitCode:result.exit_code,stopReason:result.stop_reason,duration:result.duration_ms,output:`${result.stdout}\n${result.stderr}`};
}

/** After a patch task's provider succeeds: run the owner-configured checks in its worktree (never anything from task text). */
export async function runConfiguredChecks(project:ProjectConfig,agent:AgentConfig,config:BridgeConfig,worktree:Worktree,runner:ProcessRunner,signal:AbortSignal) {
  const results:Array<{name:string;passed:boolean;exit_code:number|null;stop_reason:string|null;duration_ms:number;output_tail:string}> = [];
  for (const [name,command] of Object.entries(project.checks ?? {})) {
    const ran = await runCheckCommand(command,agent,config,worktree,runner,signal);
    results.push({name,passed:ran.exitCode===0 && ran.stopReason===null && !signal.aborted,exit_code:ran.exitCode,stop_reason:ran.stopReason,duration_ms:ran.duration,
      output_tail:Buffer.from(redactSecrets(ran.output.replaceAll('\0','\uFFFD'))).subarray(-4000).toString('utf8')});
  }
  return results;
}

/** Static owner config selects commands; neither a definition, input, nor model output can supply argv. */
export async function runFlowCheck(task:Task,project:ProjectConfig,agent:AgentConfig,config:BridgeConfig,worktree:Worktree,runner:ProcessRunner,signal:AbortSignal) {
  const flow = task.flow, spec = flow?.check;
  if (!flow || !spec || !flow.commit || !COMMIT.test(flow.commit) || !flow.diff_base || !COMMIT.test(flow.diff_base)) throw new Error('Check has no pinned patch provenance');
  const before = await inspectWorktree(worktree,flow.diff_base);
  if (before.commit!==flow.commit || before.dirty) throw new Error('Check worktree differs from the pinned commit');
  let exitCode:number|null = 0, stopReason:string|null = null, output = '', duration = 0;
  if (spec.type==='diff_nonempty') {
    exitCode = before.files.length ? 0 : 1;
    output = before.files.length ? `${before.files.length} changed paths` : 'Patch diff is empty.';
  } else if (spec.type==='files_within') {
    const outside = before.files.filter(file => !spec.globs?.some(glob => matchesGlob(file,glob)));
    exitCode = outside.length ? 1 : 0;
    output = outside.length ? `Paths outside allowed globs:\n${outside.join('\n')}` : `${before.files.length} paths are within the allowed globs.`;
  } else {
    const command = project.checks?.[spec.type];
    if (!command) throw Object.assign(new Error(`No owner-configured ${spec.type} command`),{code:'check_not_configured'});
    const ran = await runCheckCommand(command,agent,config,worktree,runner,signal);
    exitCode = ran.exitCode; stopReason = ran.stopReason; duration = ran.duration; output = ran.output;
  }
  const after = await inspectWorktree(worktree,flow.diff_base);
  if (after.commit!==flow.commit || after.dirty) { exitCode = 1; output += '\nCheck changed tracked source or HEAD; pinned evidence is invalid.'; }
  const passed = exitCode===0 && stopReason===null && !signal.aborted;
  if (signal.aborted) stopReason = 'aborted';
  return {type:spec.type,commit:flow.commit,base_commit:flow.diff_base,passed,exit_code:exitCode,stop_reason:stopReason,duration_ms:duration,
    output_tail:Buffer.from(redactSecrets(output.replaceAll('\0','\uFFFD'))).subarray(-12000).toString('utf8')};
}
