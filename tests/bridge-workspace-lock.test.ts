import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquirePatchWorkspaceLock } from '../src/bridge/workspace-lock.js';

test('one project root rejects a second patch owner even for another task', async () => {
  const root=await mkdtemp(join(tmpdir(),'collective-lock-test-'));
  try {
    const release=await acquirePatchWorkspaceLock(root,'task-one');
    await assert.rejects(acquirePatchWorkspaceLock(root,'task-two'),{code:'workspace_busy'});
    await release();
    const releaseAgain=await acquirePatchWorkspaceLock(root,'task-two');
    await releaseAgain();
  } finally { await rm(root,{recursive:true,force:true}); }
});
