#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Delivery } from './delivery.js';
import { connection, installRoot, listen, type Report } from './inbox.js';
import { Terminal, type Harness } from './terminal.js';

export const ALIASES="alias codex='swarmaa wrap codex'\nalias agy='swarmaa wrap agy'";
export function childEnvironment(parent:NodeJS.ProcessEnv,session:string):NodeJS.ProcessEnv {
  return {...Object.fromEntries(Object.entries(parent).filter(([key]) => !/^(COLLECTIVE|SWARMAA|SWARMA)_/.test(key))),SWARMAA_WRAP_SESSION:session};
}

export async function wrap(harness:Harness,args:string[]):Promise<number> {
  if (process.versions.node.split('.')[0]!=='24') throw new Error('Swarmaa wrap requires Node.js 24.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Swarmaa wrap needs an interactive terminal.');
  const session=`wrap:${harness}:${randomUUID()}`,stop=new AbortController();
  const dir=join(homedir(),'.swarma','wrap'),logFile=join(dir,`${session.replaceAll(':','-')}.jsonl`);
  mkdirSync(dir,{recursive:true,mode:0o700});
  let logBytes=0;
  const report:Report=event => {
    const line=`${JSON.stringify({at:new Date().toISOString(),session,...event})}\n`;
    if ((logBytes+=Buffer.byteLength(line))<=2*1024*1024) try { appendFileSync(logFile,line,{mode:0o600}); } catch { /* never break the user's terminal */ }
  };
  let inbox;
  try { inbox=connection(process.env.SWARMAA_WRAP_ROOT || installRoot(),harness); }
  catch { throw new Error('Wrapper identity unavailable. Run Swarmaa setup for this harness first.'); }
  process.stderr.write(`Swarmaa session: ${session}\nReceipts: ${logFile}\n`);
  const {spawn}=await import('node-pty');
  const terminal=new Terminal(process.stdout.columns||80,process.stdout.rows||24);
  const child=spawn(harness,args,{cwd:process.cwd(),cols:terminal.cols,rows:terminal.rows,name:process.env.TERM || 'xterm-256color',env:childEnvironment(process.env,session)});
  const delivery=new Delivery(terminal,harness,data => child.write(data));
  const raw=process.stdin.isRaw;
  let code=1,killTimer:ReturnType<typeof setTimeout>|undefined;
  const exit=new Promise<void>(resolve => child.onExit(result => {
    code=result.signal ? 128+result.signal : result.exitCode; stop.abort(); delivery.cancel(); resolve();
  }));
  const output=child.onData(data => {
    terminal.feed(data);
    if (!process.stdout.write(data)) child.pause();
  });
  const drain=() => child.resume();
  const input=(data:Buffer) => {
    if (!terminal.response(data.toString('utf8'))) delivery.userInput();
    if (data.length===1 && data[0]===26) suspend(); else child.write(data);
  };
  const resize=() => {
    delivery.cancel(); terminal.resize(process.stdout.columns||80,process.stdout.rows||24);
    child.resize(terminal.cols,terminal.rows);
  };
  const signals=new Map<NodeJS.Signals,()=>void>();
  const suspend=() => {
    delivery.cancel(); process.stdin.setRawMode(false);
    try { child.kill('SIGTSTP'); } catch { /* child already exited */ }
    process.kill(process.pid,'SIGSTOP');
  };
  const resume=() => {
    if (stop.signal.aborted) return;
    process.stdin.setRawMode(true);
    try { child.kill('SIGCONT'); resize(); } catch { /* child already exited */ }
  };
  for (const [signal,handler] of [['SIGTSTP',suspend],['SIGCONT',resume]] as const) {
    signals.set(signal,handler); process.on(signal,handler);
  }
  for (const signal of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT'] as const) {
    const handler=() => {
      delivery.cancel(); stop.abort();
      try { child.kill(signal); } catch { /* child already exited */ }
      killTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } },2000);
    };
    signals.set(signal,handler); process.on(signal,handler);
  }
  const end=() => { try { child.write('\x04'); } catch { /* gone */ } };
  process.stdout.on('drain',drain); process.stdout.on('resize',resize);
  process.stdin.on('data',input); process.stdin.on('end',end);
  let listening:Promise<void>|undefined;
  try {
    process.stdin.setRawMode(true); process.stdin.resume();
    report({event:'started'});
    listening=listen(inbox,delivery,session,stop.signal,report);
    await exit;
    return code;
  } finally {
    stop.abort(); delivery.cancel();
    if (killTimer) clearTimeout(killTimer);
    process.stdin.off('data',input); process.stdin.off('end',end); process.stdin.setRawMode(raw); process.stdin.pause();
    process.stdout.off('drain',drain); process.stdout.off('resize',resize); output.dispose();
    for (const [signal,handler] of signals) process.off(signal,handler);
    await listening;
    report({event:'exited',reason:String(code)});
    // Restore modes the child may leave behind when killed, after its output has drained.
    process.stdout.write(`${terminal.alternateScreen ? '\x1b[?1049l' : ''}\x1b[?2004l\x1b[?25h\x1b[0m`);
  }
}
export async function main(args=process.argv.slice(2)) {
  if (args[0]==='wrap' && args[1]==='--aliases') { process.stdout.write(`${ALIASES}\n`); return 0; }
  if (args[0]!=='wrap' || !['codex','agy'].includes(args[1])) {
    process.stdout.write('Usage: swarmaa wrap <codex|agy> [CLI args…]\n       swarmaa wrap --aliases (print only)\n'); return args.includes('--help') ? 0 : 1;
  }
  return wrap(args[1] as Harness,args.slice(2));
}
if (process.argv[1] && realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode=await main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Wrapper failed'}\n`); process.exitCode=1; }
}
