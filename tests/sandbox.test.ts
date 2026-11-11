import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.ok(profile.includes('"/tmp/.env"') && profile.includes('"/tmp/.local"'));
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users/tester/.swarma"))'));
  assert.ok(profile.includes('(allow file-read* file-write* (subpath "/Users/tester/.swarma/worktrees"))'));
  assert.ok(!profile.includes('Keychains'), 'CLIs keep their keychain logins');
  assert.ok(!profile.includes('.claude') && !profile.includes('.codex'), 'provider logins stay reachable');
  if (process.platform !== 'darwin') return;
  const home = mkdtempSync(join(tmpdir(), 'sbx-home-'));
  try {
    mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id'), 'secret');
    mkdirSync(join(home, 'proj')); writeFileSync(join(home, 'proj', 'a.txt'), 'ok');
    const p = buildProfile({ ...base, home });
    const sh = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', p, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    assert.notEqual(sh(`cat "${home}/.ssh/id"`).status, 0, 'credentials unreadable');
    assert.equal(sh(`cat "${home}/proj/a.txt" && echo more >> "${home}/proj/a.txt"`).status, 0, 'everything else readable and writable');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
