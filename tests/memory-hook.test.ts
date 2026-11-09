import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { installInboxHooks, removeInboxHooks, type Harness } from '../scripts/hooks-install.js';
const M: Record<string, any> = await import(resolve('clients/hooks/swarmaa-memory.mjs'));
const temp = () => mkdtempSync(join(tmpdir(), 'memory-hook-'));

async function fixture(t: any, withToken = true, up = true) {
  const root = temp(), home = temp();
  mkdirSync(join(root, '.local'));
  if (withToken) for (const n of ['claude', 'codex', 'antigravity']) writeFileSync(join(root, '.local', `${n}.json`), JSON.stringify({ token: 'fake-token' }));
  writeFileSync(join(root, '.local', 'setup.json'), JSON.stringify({ projects: [{ scope: 'project:demo', root: '/work/demo' }] }));
  const ownRef = `${home}/.claude/projects/-work-demo-sub/memory/own.md`;
  const server = createServer(async (req, res) => {
    let data = ''; for await (const c of req) data += c;
    const { scope } = JSON.parse(data);
    res.end(JSON.stringify({ result: scope === 'project:demo'
      ? { memories: [
          { key: 'deploy', content: '---\nname: x\ndescription: Deploy with npm run deploy\n---\nbody', source: { reference: 'x' } },
          { key: 'own', content: 'mine', source: { reference: ownRef } }],
        lessons: [{ title: 'Run smoke first' }] }
      : { memories: [{ key: 'style', content: '\nPlain first line\nsecond' }], lessons: [{ title: 'Run smoke first' }] } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(root, '.env'), `PORT=${up ? (server.address() as { port: number }).port : 1}\n`);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  return { root, home };
}

test('claude SessionStart injects project + general memories, skips own Claude memory', async t => {
  const { root, home } = await fixture(t);
  const out = await M.run('claude', 'SessionStart', { cwd: '/work/demo/sub' }, { root, home });
  const text = out.hookSpecificOutput.additionalContext as string;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(text, /Project project:demo:\n- deploy: Deploy with npm run deploy/);
  assert.match(text, /General:\n- style: Plain first line/);
  assert.doesNotMatch(text, /own:/);
  assert.equal(text.match(/- Run smoke first/g)?.length, 1);
  assert.match(text, /scope "project:demo"/);
});

test('agy PreInvocation injects once per conversation', async t => {
  const { root, home } = await fixture(t);
  const p = { conversationId: 'c1', workspacePaths: ['/work/demo'] };
  const first = await M.run('agy', 'PreInvocation', p, { root, home });
  assert.match(first.injectSteps[0].ephemeralMessage, /Swarmaa shared memory/);
  assert.equal(await M.run('agy', 'PreInvocation', p, { root, home }), null);
  assert.equal(await M.run('claude', 'PreInvocation', { cwd: '/work/demo' }, { root, home }), null);
});

test('server down or no token returns null', async t => {
  const a = await fixture(t, true, false);
  assert.equal(await M.run('claude', 'SessionStart', { cwd: '/work/demo' }, a), null);
  const b = await fixture(t, false);
  assert.equal(await M.run('claude', 'SessionStart', { cwd: '/work/demo' }, b), null);
});

test('installer coexists with inbox hooks, is idempotent, removes only ours', async t => {
  const home = temp(); t.after(() => rmSync(home, { recursive: true, force: true }));
  const o = { home, root: '/tmp/swarma', dry: false, log: () => {}, node: process.execPath };
  for (const harness of ['claude', 'codex', 'agy'] as Harness[]) {
    const file = join(home, harness === 'claude' ? '.claude/settings.json' : harness === 'codex' ? '.codex/hooks.json' : '.gemini/config/hooks.json');
    const foreign = harness === 'agy' ? { foreign: { Stop: [{ command: 'foreign' }] } } : { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'foreign' }] }] } };
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(foreign));
    assert.deepEqual((await installInboxHooks(harness, o)).changed, [file]);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (harness === 'agy') {
      assert.ok(cfg['swarmaa-memory'].PreInvocation[0].command.includes('swarmaa-memory.mjs'));
      assert.ok(cfg['swarmaa-inbox']);
    } else {
      const cmds = cfg.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command)) as string[];
      assert.equal(cmds.filter(c => c.includes('swarmaa-memory.mjs')).length, 1);
      assert.equal(cmds.filter(c => c.includes('swarmaa-inbox.mjs')).length, 1);
      assert.ok(cmds.includes('foreign'));
    }
    assert.deepEqual((await installInboxHooks(harness, o)).changed, []);
    assert.deepEqual((await removeInboxHooks(harness, o)).changed, [file]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), foreign);
  }
});
