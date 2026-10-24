/** Authored source only. These tests use disposable Git repositories, never the developer's checkout. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createReviewWorktree, removeReviewWorktree } from '../src/bridge/review-worktree.js';
import type { Task } from '../src/bridge/types.js';

const exec = promisify(execFile);
const exists = async (path:string):Promise<boolean> => { try { await access(path); return true; } catch { return false; } };

test('pinned read snapshots ignore a moving/dirty checkout and suppress checkout hooks and filters',{concurrency:false},async () => {
  const temporary = await mkdtemp(join(tmpdir(),'swarmaa-pinned-review-test-'));
  const previousHome = process.env.HOME;
  const home = join(temporary,'home'), root = join(temporary,'project');
  await mkdir(home); await mkdir(root);
  process.env.HOME = home;
  const git = async (...args:string[]):Promise<string> => (await exec('/usr/bin/git',['-C',root,...args],{
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8',timeout:15000,
  })).stdout.trim();
  let snapshot:Awaited<ReturnType<typeof createReviewWorktree>>|undefined;
  try {
    await git('init','-b','main');
    await git('config','user.name','Swarmaa review test');
    await git('config','user.email','review-test@example.invalid');
    await writeFile(join(root,'source.txt'),'pinned version\n');
    await writeFile(join(root,'.gitattributes'),'*.txt filter=tripwire\n');
    await git('add','.'); await git('commit','-m','pinned source');
    const pinned = await git('rev-parse','HEAD');
    await writeFile(join(root,'source.txt'),'newer committed version\n');
    await git('add','.'); await git('commit','-m','moving head');
    const current = await git('rev-parse','HEAD');
    await writeFile(join(root,'source.txt'),'user uncommitted version\n');
    // Use only fixed test paths/commands. A checkout would fail or create markers if these ran.
    const hook = join(root,'.git','hooks','post-checkout');
    await writeFile(hook,'#!/bin/sh\nprintf hook > "$HOME/hook-ran"\n');
    await chmod(hook,0o700);
    await git('config','filter.tripwire.smudge','sh -c \'printf filter > "$HOME/filter-ran"; cat\'');
    await git('config','filter.tripwire.process','sh -c \'printf process > "$HOME/process-ran"; exit 1\'');
    await git('config','filter.tripwire.required','true');
    const task:Task = {id:randomUUID(),scope:'project:review',kind:'review',objective:'Review source',
      constraints:[],acceptance_criteria:[],resource_key:null,checkpoint:null,context_refs:[],version:1,
      required_capability:'claude.read',base_ref:pinned};
    snapshot = await createReviewWorktree(root,task,1);
    assert.equal(snapshot.baseCommit,pinned);
    assert.equal(await readFile(join(snapshot.dir,'source.txt'),'utf8'),'pinned version\n');
    assert.equal(await git('rev-parse','HEAD'),current);
    assert.equal(await readFile(join(root,'source.txt'),'utf8'),'user uncommitted version\n');
    for (const marker of ['hook-ran','filter-ran','process-ran']) assert.equal(await exists(join(home,marker)),false);
    const path = snapshot.dir;
    await removeReviewWorktree(root,snapshot); snapshot = undefined;
    assert.equal(await exists(path),false);
    assert.ok(!(await git('worktree','list','--porcelain')).includes(path));
  } finally {
    if (snapshot) await removeReviewWorktree(root,snapshot).catch(() => undefined);
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(temporary,{recursive:true,force:true});
  }
});

test('an absent pinned commit fails before allocating a review snapshot',{concurrency:false},async () => {
  const temporary = await mkdtemp(join(tmpdir(),'swarmaa-missing-review-test-'));
  const previousHome = process.env.HOME;
  process.env.HOME = temporary;
  try {
    await exec('/usr/bin/git',['init',join(temporary,'repo')],{timeout:15000});
    const task:Task = {id:randomUUID(),scope:'project:review',kind:'review',objective:'Review source',
      constraints:[],acceptance_criteria:[],resource_key:null,checkpoint:null,context_refs:[],version:1,
      required_capability:'claude.read',base_ref:'0'.repeat(40)};
    await assert.rejects(() => createReviewWorktree(join(temporary,'repo'),task,1));
    assert.equal(await exists(join(temporary,'.swarma','reviews')),false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(temporary,{recursive:true,force:true});
  }
});
