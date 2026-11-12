import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botSecrets, scrubSecrets } from '../src/bridge/bot-secrets.js';
import { extractActionsBlock } from '../src/core/actions.js';

test('bot secrets come only from the scope index, never Swarmaa tokens, and skip missing items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-secrets-'));
  const index = join(dir, 'bot-secrets.json');
  writeFileSync(index, JSON.stringify({ 'project:a': ['GITHUB_TOKEN', 'SWARMAA_WORKER_TOKEN', 'lower', 'MISSING'], 'project:b': ['OTHER'] }));
  const asked: string[] = [];
  const read = (account: string): string => { asked.push(account); if (account.endsWith('MISSING')) throw new Error('not found'); return 'ghp_abcdefgh12345\n'; };
  assert.deepEqual(botSecrets('project:a', index, read), { GITHUB_TOKEN: 'ghp_abcdefgh12345' });
  assert.deepEqual(asked, ['project:a/GITHUB_TOKEN', 'project:a/MISSING']);
  assert.deepEqual(botSecrets('project:none', index, read), {});
  assert.deepEqual(botSecrets('project:a', join(dir, 'absent.json'), read), {});
});

test('secret values are scrubbed from output', () => {
  assert.equal(scrubSecrets('token is ghp_abcdefgh12345 ok', { GITHUB_TOKEN: 'ghp_abcdefgh12345' }), 'token is [GITHUB_TOKEN] ok');
});

test('a credential ask is answered only Added / Not now and rejects bad names', () => {
  const parse = (action: unknown) => extractActionsBlock(`Need it\n\n\`\`\`swarmaa-actions\n${JSON.stringify([action])}\n\`\`\``);
  const ok = parse({ type: 'question_ask', prompt: 'I need a GitHub token', options: ['x'], free_text: true, credential: 'GITHUB_TOKEN' });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.actions[0], { type: 'question_ask', prompt: 'I need a GitHub token', options: ['Added', 'Not now'], multi: false, free_text: false, swarm_step_id: undefined, expires_in: undefined, credential: 'GITHUB_TOKEN' });
  for (const credential of ['github_token', 'SWARMAA_WORKER_TOKEN', 'COLLECTIVE_X', 'A', 7]) {
    assert.ok(parse({ type: 'question_ask', prompt: 'p', options: [], credential }).error, String(credential));
  }
});
