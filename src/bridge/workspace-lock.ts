import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A local single-writer guard independent of user-selected resource keys. No timeout
 * reaping: after a bridge crash, the operator must verify the old provider stopped.
 */
export async function acquirePatchWorkspaceLock(root: string, taskId: string): Promise<() => Promise<void>> {
  const directory = join(root, '.collective-patch.lock');
  const ownerFile = join(directory, 'owner.json');
  const nonce = randomUUID();
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw Object.assign(new Error('Patch workspace is locked. Check the active or interrupted worker before removing the lock.'), { code: 'workspace_busy' });
    }
    throw error;
  }
  try {
    await writeFile(ownerFile, JSON.stringify({ nonce, task_id: taskId, pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async (): Promise<void> => {
    // Do not erase a replacement owner's guard if an operator changed it meanwhile.
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { nonce?: unknown };
    if (owner.nonce !== nonce) throw new Error('Workspace lock owner changed; manual review required');
    await rm(directory, { recursive: true, force: true });
  };
}
