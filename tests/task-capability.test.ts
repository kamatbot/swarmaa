import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCapabilities } from '../src/bridge/adapters.js';
import { VALID_CAPABILITIES } from '../src/core/tasks.js';

test('every capability a bridge can advertise is accepted by task_submit; patch is claude-only', () => {
  const agents = ['claude', 'codex', 'antigravity'].map(id => ({ id, provider: id as 'claude', binary: '/b', enable_patch: true, sandbox: true }));
  const caps = projectCapabilities({ scope: 'project:a', root: '/r', agents: agents.map(a => a.id), allow_patch: true }, agents);
  for (const c of caps) assert.ok((VALID_CAPABILITIES as readonly string[]).includes(c), c);
  assert.deepEqual(VALID_CAPABILITIES.filter(c => c.endsWith('.patch')), ['claude.patch']);
  assert.ok(!(VALID_CAPABILITIES as readonly string[]).includes('antigravity.patch'));
});
