import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProfile, CREDENTIAL_PATHS, real, sbplString } from '../src/bridge/sandbox.js';

const base = {
  provider: 'claude' as const,
  binary: '/opt/claude/bin/claude',
  projectRoot: '/Users/tester/proj',
  home: '/Users/tester',
  tmp: '/private/var/folders/xx/T',
};

test('sbplString escapes quotes and backslashes and refuses control characters', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\nb'));
});

test('CREDENTIAL_PATHS includes expanded sensitive paths and excludes Keychains', () => {
  for (const p of ['.ssh', '.swarmaa', '.swarma', 'Library/LaunchAgents', '.pgpass', '.zsh_history', '.bash_history', '.config/op', '.local/relay-host.key', '.env']) {
    assert.ok(CREDENTIAL_PATHS.includes(p), `expected ${p} in CREDENTIAL_PATHS`);
  }
  const profile = buildProfile(base);
  assert.ok(profile.includes('(deny file-write*)'));
  assert.ok(profile.includes('"/Users/tester/.swarma"'));
  assert.ok(profile.includes('"/Users/tester/Library/LaunchAgents"'));
  assert.ok(profile.includes('"/Users/tester/.env"'));
  assert.ok(!profile.includes('Keychains'), 'CLIs keep their keychain logins');
});

test('read-only profile denies writes to projectRoot, home, LaunchAgents and denies credential reads', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-ro-')));
  try {
    const home = join(root, 'home');
    const proj = join(home, 'proj');
    const tmp = join(root, 'scratch-tmp');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, '.swarma'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(proj, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(home, '.ssh', 'id'), 'ssh-secret');
    writeFileSync(join(home, '.swarma', 'bot-secrets.json'), '{"project:a":["TOKEN"]}');
    writeFileSync(join(home, '.env'), 'DATABASE_URL=secret');
    writeFileSync(join(proj, 'a.txt'), 'ok');

    const p = buildProfile({ provider: 'claude', binary: '/bin/sh', projectRoot: proj, home, tmp, patch: false });
    const sh = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', p, '/bin/sh', '-c', cmd], { encoding: 'utf8' });

    // Credential reads denied
    assert.notEqual(sh(`cat "${home}/.ssh/id"`).status, 0, '.ssh unreadable');
    assert.notEqual(sh(`cat "${home}/.swarma/bot-secrets.json"`).status, 0, '.swarma unreadable');
    assert.notEqual(sh(`cat "${home}/.env"`).status, 0, '.env unreadable');

    // Project readable, NOT writable in read-only mode
    assert.equal(sh(`cat "${proj}/a.txt"`).status, 0, 'project readable');
    assert.notEqual(sh(`echo bad >> "${proj}/a.txt"`).status, 0, 'project NOT writable when patch=false');

    // Home and LaunchAgents NOT writable
    assert.notEqual(sh(`echo bad > "${home}/pwned.txt"`).status, 0, 'home NOT writable');
    assert.notEqual(sh(`echo bad > "${home}/Library/LaunchAgents/evil.plist"`).status, 0, 'LaunchAgents NOT writable');

    // Tmp, /dev/null, and provider runtime dir ARE writable
    assert.equal(sh(`echo ok > "${tmp}/out.txt"`).status, 0, 'tmp writable');
    assert.equal(sh(`echo ok > /dev/null`).status, 0, '/dev/null writable');
    assert.equal(sh(`echo ok > "${home}/.claude/cache.tmp"`).status, 0, 'provider runtime dir writable');

    // Builds and the CLI's own settings file keep working: xcodebuild, simulators, npm, ~/.claude.json
    for (const d of ['Library/Developer/Xcode/DerivedData', 'Library/Caches', '.npm']) {
      mkdirSync(join(home, d), { recursive: true });
      assert.equal(sh(`echo ok > "${home}/${d}/x"`).status, 0, `${d} writable`);
    }
    assert.equal(sh(`echo {} > "${home}/.claude.json"`).status, 0, '~/.claude.json writable');
    assert.equal(sh(`echo {} > "${home}/.claude.json.backup"`).status, 0, '~/.claude.json siblings writable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('patch profile allows writes to worktree inside ~/.swarma/worktrees, gitDir and ownHistoryDir, while blocking sibling worktrees and ~/.swarma secrets', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-patch-')));
  try {
    const home = join(root, 'home');
    const wt = join(home, '.swarma', 'worktrees', 'demo', 'task-1');
    const otherWt = join(home, '.swarma', 'worktrees', 'demo', 'task-2');
    const gitDir = join(root, 'repo', '.git');
    const ownHistoryDir = join(home, '.claude', 'projects', 'task-1');
    const otherHistoryDir = join(home, '.claude', 'projects', 'other-proj');
    const tmp = join(root, 'scratch-tmp');
    for (const d of [wt, otherWt, gitDir, ownHistoryDir, otherHistoryDir, tmp, join(home, 'Library', 'LaunchAgents')]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(home, '.swarma', 'bot-secrets.json'), '{"project:a":["TOKEN"]}');
    writeFileSync(join(otherWt, 'secret.txt'), 'sibling');

    const p = buildProfile({
      provider: 'claude',
      binary: '/bin/sh',
      projectRoot: wt,
      gitDir,
      ownHistoryDir,
      home,
      tmp,
      patch: true,
    });
    const sh = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', p, '/bin/sh', '-c', cmd], { encoding: 'utf8' });

    // Allowed writes
    assert.equal(sh(`echo edit > "${wt}/changed.txt"`).status, 0, 'own worktree writable');
    assert.equal(sh(`echo ref > "${gitDir}/FETCH_HEAD"`).status, 0, 'gitDir writable');
    assert.equal(sh(`echo log > "${ownHistoryDir}/session.jsonl"`).status, 0, 'ownHistoryDir writable');
    assert.equal(sh(`echo tmp > "${tmp}/t.txt"`).status, 0, 'tmp writable');

    // Denied reads/writes
    assert.notEqual(sh(`cat "${home}/.swarma/bot-secrets.json"`).status, 0, '.swarma secrets unreadable');
    assert.notEqual(sh(`cat "${otherWt}/secret.txt"`).status, 0, 'sibling worktree unreadable');
    assert.notEqual(sh(`echo x > "${otherWt}/hack.txt"`).status, 0, 'sibling worktree unwritable');
    assert.notEqual(sh(`echo x > "${otherHistoryDir}/hijack.jsonl"`).status, 0, 'sibling claude project history unwritable');
    assert.notEqual(sh(`echo x > "${home}/Library/LaunchAgents/evil.plist"`).status, 0, 'LaunchAgents unwritable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real() normalizes /tmp and /var symlinks even for non-existent leaf paths', { skip: process.platform !== 'darwin' }, () => {
  assert.ok(real('/tmp/nonexistent-swarmaa-leaf').startsWith('/private/tmp/'));
  assert.ok(real('/var/folders/nonexistent-swarmaa-leaf').startsWith('/private/var/folders/'));
});
