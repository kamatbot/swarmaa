import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProfile, sbplString } from '../src/bridge/sandbox.js';

const base = { provider: 'claude' as const, binary: '/opt/claude/bin/claude', projectRoot: '/tmp', home: '/Users/tester', tmp: '/private/var/folders/xx/T' };

test('sbplString escapes quotes and backslashes and refuses control characters', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\nb'));
});




test('light profile: allow by default, deny credential folders and service files, keep worktrees', () => {
  const profile = buildProfile(base);
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-read\* file-write\* /u);
  assert.ok(profile.includes('"/Users/tester/.ssh"') && profile.includes('"/Users/tester/.config/gh"'));
  assert.ok(profile.includes('"/Users/tester/.env"') && profile.includes('"/Users/tester/.local"') && profile.includes('"/Users/tester/.swarmaa"'));
  // macOS realpath of /tmp is /private/tmp. Match whatever this host resolves.
  const project = realpathSync('/tmp');
  assert.ok(profile.includes(`"${project}/.env"`) && profile.includes(`"${project}/.local"`));
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users/tester/.swarma"))'));
  assert.ok(profile.includes('(allow file-read* file-write* (subpath "/Users/tester/.swarma/worktrees"))'));
  assert.ok(!profile.includes('Keychains'), 'CLIs keep their keychain logins');
  assert.ok(!profile.includes('.claude') && !profile.includes('.codex'), 'provider logins stay reachable');
  if (process.platform !== 'darwin') return;
  const home = mkdtempSync(join(tmpdir(), 'sbx-home-'));
  try {
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id'), 'secret');
    mkdirSync(join(home, '.local')); writeFileSync(join(home, '.local', 'token.json'), 'secret');
    writeFileSync(join(home, '.env'), 'DATABASE_URL=secret');
    mkdirSync(join(home, '.swarma')); writeFileSync(join(home, '.swarma', 'secret'), 'secret');
    const tree = join(home, '.swarma', 'worktrees', 'demo');
    mkdirSync(tree, { recursive: true }); writeFileSync(join(tree, 'edit.txt'), 'ok');
    mkdirSync(join(home, 'proj')); writeFileSync(join(home, 'proj', 'a.txt'), 'ok');
    const p = buildProfile({ ...base, home });
    const sh = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', p, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    assert.notEqual(sh(`cat "${home}/.ssh/id"`).status, 0, 'credentials unreadable');
    assert.notEqual(sh(`cat "${home}/.env"`).status, 0, 'service env unreadable');
    assert.notEqual(sh(`cat "${home}/.local/token.json"`).status, 0, 'local tokens unreadable');
    assert.notEqual(sh(`cat "${home}/.swarma/secret"`).status, 0, 'swarma secrets unreadable');
    assert.equal(sh(`cat "${tree}/edit.txt" && echo more >> "${tree}/edit.txt"`).status, 0, 'patch worktrees stay writable');
    assert.equal(sh(`cat "${home}/proj/a.txt" && echo more >> "${home}/proj/a.txt"`).status, 0, 'everything else readable and writable');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
