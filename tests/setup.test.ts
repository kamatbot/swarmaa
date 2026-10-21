import assert from 'node:assert/strict';
import test from 'node:test';
import { AGY_TOOLS, bridgeConfig, mergeAgyPermissions, parseEnv, plist, slugScopes, yes } from '../scripts/setup-lib.js';

test('slugScopes normalizes basenames and suffixes collisions', () => {
  assert.deepEqual(slugScopes(['/a/My App!', '/b/my-app', '/c/My App!', '/a/My App!', '/d/Demo']).map(s => s.scope),
    ['project:my-app', 'project:my-app-2', 'project:my-app-3', 'project:demo']);
  assert.deepEqual(slugScopes(['/x/demo', '/y/Demo'], ['demo']).map(s => s.scope), ['project:demo-2', 'project:demo-3']);
  assert.equal(slugScopes(['/x/___'])[0]!.scope, 'project:project');
});

test('plist escapes strings and sets launchd keys', () => {
  const x = plist('com.swarma.t', ['/bin/node', 'a&b<c>"\''], { workingDirectory: '/r', env: { PATH: '/a:/b', HOME: '/h' }, stdout: '/l/o.log', stderr: '/l/o.log' });
  assert.match(x, /a&amp;b&lt;c&gt;&quot;&apos;/);
  for (const k of ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'ProcessType', 'Background', 'WorkingDirectory', 'StandardOutPath']) assert.ok(x.includes(k), k);
  assert.ok(!x.includes('a&b<'));
  assert.ok(!plist('l', ['x']).includes('EnvironmentVariables'));
});

test('mergeAgyPermissions preserves keys, de-duplicates and tolerates junk', () => {
  const s = { theme: 'dark', permissions: { allow: ['shell(ls)', 'mcp(swarma/task_get)'], deny: ['x'] } };
  const out = mergeAgyPermissions(s, AGY_TOOLS) as { theme: string; permissions: { allow: string[]; deny: string[] } };
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.permissions.deny, ['x']);
  assert.equal(out.permissions.allow.length, 1 + AGY_TOOLS.length);
  assert.equal(out.permissions.allow.filter(a => a === 'mcp(swarma/task_get)').length, 1);
  assert.deepEqual(mergeAgyPermissions(mergeAgyPermissions(s, AGY_TOOLS), AGY_TOOLS), out);
  assert.ok((mergeAgyPermissions(null, ['a']) as any).permissions.allow.includes('mcp(swarma/a)'));
  assert.ok(!AGY_TOOLS.some(t => t.includes('*')));
  assert.equal(s.permissions.allow.length, 2);
});

test('bridgeConfig matches the example shape with token_file', () => {
  const c = bridgeConfig({ port: '8787', tokenFile: '/r/.local/worker-claude.json', agent: { id: 'claude', binary: '/b/claude', model: 'sonnet' }, projects: [{ scope: 'project:demo', root: '/r/demo' }] }) as any;
  assert.equal(c.service_url, 'http://127.0.0.1:8787');
  assert.equal(c.token_file, '/r/.local/worker-claude.json');
  assert.equal(c.token_env, undefined);
  assert.deepEqual(c.agents, [{ id: 'claude', provider: 'claude', binary: '/b/claude', model: 'sonnet', enable_patch: false }]);
  assert.deepEqual(c.projects, [{ scope: 'project:demo', root: '/r/demo', agents: ['claude'], allow_patch: false }]);
  assert.equal(c.reason, null);
  const codex = bridgeConfig({ port: 1, tokenFile: '/t', agent: { id: 'codex', binary: '/b/codex' }, projects: [] }) as any;
  assert.equal('model' in codex.agents[0], false);
});

test('parseEnv handles comments, quotes, export and values with =', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two"\n\nC=x=y\nD=\n bad\n'), { A: '1', B: 'two', C: 'x=y', D: '' });
});

test('yes honours defaults', () => {
  assert.equal(yes('', true), true);
  assert.equal(yes('', false), false);
  assert.equal(yes('Y', false), true);
  assert.equal(yes(' no ', true), false);
  assert.equal(yes('maybe', true), true);
});
