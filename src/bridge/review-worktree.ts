import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './types.js';

const exec = promisify(execFile);
export interface ReviewWorktree { dir:string; gitDir:string; baseCommit:string }
const failure = (code:string,message:string) => Object.assign(new Error(message),{code});

/** Only immutable commits may select the source for a read task. Never fetch a remote. */
export function reviewCommit(task:Pick<Task,'base_ref'>):string {
  if (typeof task.base_ref !== 'string' || !/^[a-f0-9]{40}$/u.test(task.base_ref)) {
    throw failure('invalid_review_commit','Pinned review work requires a full lowercase 40-character commit SHA.');
  }
  return task.base_ref;
}

async function git(root:string,args:string[],signal?:AbortSignal,config:string[]=[]):Promise<string> {
  const result = await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...config,'-C',root,...args],{
    encoding:'utf8',timeout:15000,maxBuffer:256*1024,signal,
    env:{PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:homedir(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},
  });
  return result.stdout.trim();
}

/** Checkout filters are local Git config, but untrusted attributes can select one. Disable every configured driver. */
async function withoutFilters(root:string,signal?:AbortSignal):Promise<string[]> {
  let keys:string;
  try { keys = await git(root,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(process|smudge|required)$'],signal); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return []; // no matching drivers
    throw error;
  }
  const drivers = new Set<string>();
  for (const key of keys.split('\0').filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:process|smudge|required)$/u.exec(key);
    if (!match || /[\x00-\x1f\x7f=]/u.test(match[1]!)) throw failure('unsafe_git_filter','Cannot safely disable a configured checkout filter.');
    drivers.add(match[1]!);
  }
  return [...drivers].flatMap(name => ['-c',`filter.${name}.process=`,'-c',`filter.${name}.smudge=`,'-c',`filter.${name}.required=false`]);
}

/** A fresh detached snapshot per lease attempt; the user's checkout and patch branches are untouched. */
export async function createReviewWorktree(root:string,task:Task,generation:number,signal?:AbortSignal):Promise<ReviewWorktree> {
  const requested = reviewCommit(task);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(task.id) || !Number.isInteger(generation) || generation<1) {
    throw failure('invalid_review_attempt','Invalid task identity or lease generation.');
  }
  const resolved = await git(root,['rev-parse','--verify','--quiet',`${requested}^{commit}`],signal);
  if (resolved !== requested) throw failure('review_commit_mismatch','The requested revision is not the resolved commit.');
  const gitDir = await git(root,['rev-parse','--path-format=absolute','--git-common-dir'],signal);
  const checkoutConfig = await withoutFilters(root,signal);
  const parent = join(homedir(),'.swarma','reviews');
  await mkdir(parent,{recursive:true,mode:0o700});
  const dir = await mkdtemp(join(parent,`${task.id}-${generation}-`));
  await chmod(dir,0o700);
  try {
    await git(root,['worktree','add','--detach',dir,requested],signal,checkoutConfig);
    const actual = await git(dir,['rev-parse','HEAD'],signal);
    if (actual !== requested) throw failure('review_commit_mismatch','The detached review snapshot has an unexpected HEAD.');
    return {dir,gitDir,baseCommit:actual};
  } catch (error) {
    // Only this invocation's newly allocated path is eligible for removal.
    try { await git(root,['worktree','remove','--force',dir]); } catch { /* add may have failed before registration */ }
    await rm(dir,{recursive:true,force:true});
    throw error;
  }
}

export async function removeReviewWorktree(root:string,worktree:ReviewWorktree):Promise<void> {
  await git(root,['worktree','remove','--force',worktree.dir]);
}
