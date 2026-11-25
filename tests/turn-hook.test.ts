import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { installInboxHooks, removeInboxHooks } from '../scripts/hooks-install.js';
import { handoffNotice, parseReview, peerReviewNotice, reviewHeadline } from '../src/core/peer-review.js';
const T: Record<string, any> = await import(resolve('clients/hooks/swarmaa-turn.mjs'));
const temp = () => mkdtempSync(join(tmpdir(), 'turn-hook-'));
const TASK = '0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f';

function repo(t: any) {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  g('init', '-q'); writeFileSync(join(dir, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'init');
  return { dir, g };
}

function fixture(t: any, { workers = ['claude', 'codex'], edits = ['codex'], usage = [] as unknown[] } = {}) {
  const root = temp(), home = temp();
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, '.local'));
  writeFileSync(join(root, '.local', 'setup.json'), JSON.stringify({ workers, edits, projects: [{ scope: 'project:demo', root: '/' }] }));
  const calls: { tool: string; body: any }[] = [];
  let task: any = { id: TASK, status: 'queued', result: null };
  const call = async (tool: string, body: any) => {
    calls.push({ tool, body });
    if (tool === 'task_submit') return { task: { id: TASK } };
    if (tool === 'task_get') return { task };
    if (tool === 'swarm_status') return { usage };
    return {};
  };
  let clock = Date.parse('2026-11-25T08:00:00Z');
  return { root, home, calls, call, now: () => clock, tick: (ms: number) => { clock += ms; }, setTask: (x: any) => { task = x; } };
}

test('commands are recognised raw, as Codex skill mentions and as an expanded Claude command', () => {
  assert.deepEqual(T.parseCommand('/swarm review on codex'), { verb: 'review', action: 'on', reviewer: 'codex' });
  assert.deepEqual(T.parseCommand('$swarm review on agy'), { verb: 'review', action: 'on', reviewer: 'antigravity' });
  assert.deepEqual(T.parseCommand('/swarm review'), { verb: 'review', action: 'status', reviewer: null });
  assert.equal(T.parseCommand('/swarm review maybe').action, 'help');
  assert.deepEqual(T.parseCommand(`---\n${T.COMMAND_MARKER}\nARGS: review off\n\nShow...`), { verb: 'review', action: 'off', reviewer: null });
  assert.deepEqual(T.parseCommand('/swarm handoff read finish the tests'), { verb: 'handoff', action: 'start', mode: 'read', instruction: 'finish the tests' });
  assert.deepEqual(T.parseCommand('/swarm handoff'), { verb: 'handoff', action: 'start', mode: null, instruction: '' });
  assert.equal(T.parseCommand('/swarm handoff status').action, 'status');
  assert.equal(T.parseCommand('please /swarm review on'), null);
  assert.equal(T.parseCommand('/swarm run fix it'), null);
});

test('review reads the verdict, the three severities and a question; anything else needs a closer look', () => {
  const fix = parseReview('VERDICT: fix\n- [Important] a.ts:3: null deref; guard it\n- [Small detail] b.ts:9: typo\n- [Note] tests pass');
  assert.equal(fix.verdict, 'fix');
  assert.equal(reviewHeadline(fix), '2 things to fix (1 Important, 1 Small detail)');
  assert.equal(reviewHeadline(parseReview('**VERDICT:** complete\n- [Note] fine')), 'Review complete');
  assert.equal(reviewHeadline(parseReview('VERDICT: decision\nQUESTION: keep the old API?')), 'Your decision needed');
  assert.equal(parseReview('Looks good to me!').verdict, 'unclear');
  assert.equal(parseReview('VERDICT: fix\nno tagged findings').verdict, 'unclear', 'fix with nothing to fix is not a verdict');
  const body = peerReviewNotice({ id: TASK, status: 'completed' }, 'codex', 'VERDICT: fix\n- [Worth fixing] x\n- [Important] y');
  assert.match(body, /^Peer review of your last turn by Codex: 2 things to fix/);
  assert.ok(body.indexOf('[Important] y') < body.indexOf('[Worth fixing] x'), 'most severe first');
  assert.match(body, /Change nothing unless they ask you to fix the findings\. Full review: task_get/);
  assert.match(peerReviewNotice({ id: TASK, status: 'completed' }, 'claude', 'hmm'), /Review needs a closer look/);
  assert.match(peerReviewNotice({ id: TASK, status: 'failed' }, 'codex', '', { code: 'timeout' }), /^Review did not finish \(timeout\).*\/swarm review again/);
  const long = peerReviewNotice({ id: TASK, status: 'completed' }, 'codex', `VERDICT: fix\n${Array.from({ length: 40 }, (_, i) => `- [Important] finding ${i} ${'x'.repeat(80)}`).join('\n')}`);
  assert.ok(long.length <= 2000); assert.match(long, /more in the full review/); assert.match(long, /task_get/);
  assert.match(handoffNotice({ id: TASK, status: 'completed' }, 'codex', 'done', { branch: 'swarmaa/codex/x', native_session: { resume: 'codex resume 1' } }), /Codex picked up your conversation.*swarmaa\/codex\/x.*codex resume 1/);
});

test('peer review: off by default, snapshots each prompt, reviews only a turn that changed files, at most twice per diff', async t => {
  const f = fixture(t), { dir } = repo(t);
  const p = { session_id: 'chat-1', cwd: dir };
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hello' }, f), null, 'off by default: nothing shown');
  assert.equal(await T.run('claude', 'Stop', p, f), null);
  assert.equal(f.calls.length, 0);

  const on = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm review on' }, f);
  assert.equal(on.decision, 'block', 'handled without a model call');
  assert.match(on.systemMessage, /^Review is on for this chat/);

  writeFileSync(join(dir, 'untracked.txt'), 'before\n');
  await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'add a line' }, f);
  assert.equal(await T.run('claude', 'Stop', { ...p, last_assistant_message: 'no changes' }, f), null, 'no file changes, no review');
  assert.equal(f.calls.length, 0);

  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString();
  await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'add a line' }, f);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(dir, 'new.txt'), 'brand new\n');
  const started = await T.run('claude', 'Stop', { ...p, last_assistant_message: 'Added it.' }, f);
  assert.match(started.systemMessage, /^Another agent is reviewing this turn's changes \(2 files, task 0f8b6c1e\)/);
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString(), staged, "the user's index is untouched");
  const submit = f.calls.find(c => c.tool === 'task_submit')!.body;
  assert.equal(submit.kind, 'review'); assert.equal(submit.required_capability, 'auto.read');
  assert.deepEqual(submit.exclude_providers, ['claude']);
  assert.equal(submit.resource_key, 'peer-review:claude:chat-1');
  assert.match(submit.objective, /\+two/); assert.match(submit.objective, /new\.txt/);
  assert.doesNotMatch(submit.objective, /untracked\.txt/, 'only this turn\'s changes');
  assert.match(submit.objective, /add a line/); assert.match(submit.objective, /Added it\./); assert.match(submit.objective, /^VERDICT: complete \| fix \| decision$/m);
  assert.ok(submit.objective.length <= 16000);
  assert.deepEqual(f.calls.find(c => c.tool === 'task_watch')!.body, { task_id: TASK, session: 'claude:chat-1' });

  // The same unchanged diff again (e.g. a no-op follow-up from the same base) is reviewed at most twice.
  for (let i = 0; i < 2; i++) {
    const state = JSON.parse(readFileSync(T.stateFile(f.home, 'claude:chat-1'), 'utf8'));
    state.review.snapshot = { top: state.review.last.top, tree: state.review.last.base };
    writeFileSync(T.stateFile(f.home, 'claude:chat-1'), JSON.stringify(state));
    await T.run('claude', 'Stop', p, f);
  }
  assert.equal(f.calls.filter(c => c.tool === 'task_submit').length, 2);

  const again = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm review again' }, f);
  assert.equal(again.decision, 'block'); assert.match(again.systemMessage, /reviewing/);
  assert.equal(f.calls.filter(c => c.tool === 'task_submit').length, 3, 'review again is explicit and always runs');

  const named = await T.run('codex', 'UserPromptSubmit', { session_id: 'cx', cwd: dir, prompt: '$swarm review on claude' }, f);
  assert.match(named.systemMessage, /Claude Code reviews/);
  await T.run('codex', 'UserPromptSubmit', { session_id: 'cx', cwd: dir, prompt: 'more' }, f);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await T.run('codex', 'Stop', { session_id: 'cx', cwd: dir }, f);
  const pinned = f.calls.filter(c => c.tool === 'task_submit').at(-1)!.body;
  assert.equal(pinned.required_capability, 'claude.read'); assert.equal(pinned.exclude_providers, undefined);

  const off = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm review off' }, f);
  assert.equal(off.systemMessage, 'Review is off for this chat.');
});

test('out of usage: the next prompt shows the keep-going card once, and /swarm handoff continues with another agent', async t => {
  const usage = [
    { provider: 'claude', ok: true, headroom: 0, windows: [{ name: '5h', used_percent: 100, resets_at: '2026-11-25T10:20:00Z' }, { name: 'weekly', used_percent: 40, resets_at: '2026-11-30T00:00:00Z' }] },
    { provider: 'codex', ok: true, headroom: 0.62, windows: [{ name: '5h', used_percent: 38, resets_at: null }, { name: 'weekly', used_percent: 10, resets_at: null }] },
  ];
  const f = fixture(t, { usage }), { dir } = repo(t);
  const transcript = join(f.root, 't.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { content: 'Build the login page' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Started on it.' }] } },
    { type: 'user', message: { content: 'Now add tests for it' } },
  ].map(x => JSON.stringify(x)).join('\n'));
  const p = { session_id: 'chat-2', cwd: dir, transcript_path: transcript };

  assert.equal(await T.run('claude', 'StopFailure', { ...p, error_type: 'rate_limit' }, f), null);
  const card = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'try again' }, f);
  assert.equal(card.decision, undefined, 'the prompt still goes through; the card only offers the handoff');
  assert.match(card.systemMessage, /^Claude Code is out of usage until .+\. Keep going with another agent: type \/swarm handoff and Codex \(62% of its 5-hour window left\) continues/);
  assert.match(card.systemMessage, /Nothing is sent until you do\./);
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'again' }, f), null, 'shown once per limit');
  assert.equal(f.calls.filter(c => c.tool === 'task_submit').length, 0, 'never hands off on its own');

  const go = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff' }, f);
  assert.equal(go.decision, 'block');
  assert.match(go.systemMessage, /^Continuing with Codex \(task 0f8b6c1e\)\. It gets this conversation and your last message\. It can edit files/);
  const submit = f.calls.find(c => c.tool === 'task_submit')!.body;
  assert.equal(submit.kind, 'patch'); assert.equal(submit.required_capability, 'auto.patch');
  assert.deepEqual(submit.exclude_providers, ['claude']); assert.equal(submit.resource_key, 'handoff:claude:chat-2');
  assert.match(submit.objective, /Build the login page/); assert.match(submit.objective, /last message, which still needs an answer:\n<<<\nNow add tests for it/);
  assert.deepEqual(f.calls.find(c => c.tool === 'task_watch')!.body, { task_id: TASK, session: 'claude:chat-2' });

  f.setTask({ id: TASK, status: 'running', result: null });
  assert.match((await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff status' }, f)).systemMessage, /is working on handoff 0f8b6c1e/);
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, f), null, 'nothing to show while it runs');
  f.setTask({ id: TASK, status: 'completed', result: { provider: 'codex', answer: 'Added 4 tests.', branch: 'swarmaa/codex/0f8b6c1e', base_ref: 'main', native_session: { resume: 'cd /p && codex resume abc' } } });
  const done = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, f);
  assert.match(done.systemMessage, /^Codex finished handoff 0f8b6c1e\.\nAnswer: Added 4 tests\.\nChanges: local branch swarmaa\/codex\/0f8b6c1e\. Review with git diff main\.\.\.swarmaa\/codex\/0f8b6c1e\.\nKeep going there: cd \/p && codex resume abc$/);
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, f), null, 'a finished handoff is shown once');

  const read = await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff read' }, f);
  assert.match(read.systemMessage, /It answers only; no files change/);
  assert.equal(f.calls.filter(c => c.tool === 'task_submit').at(-1)!.body.required_capability, 'auto.read');
});

test('handoff explains instead of failing when nobody can take over', async t => {
  const alone = fixture(t, { workers: ['claude'], edits: [] });
  const p = { session_id: 'x', cwd: '/tmp', transcript_path: '/nonexistent' };
  await T.run('claude', 'StopFailure', { ...p, error_type: 'rate_limit' }, alone);
  assert.match((await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, alone)).systemMessage, /No other agent is set up to take over/);
  assert.match((await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff' }, alone)).systemMessage, /nobody to hand off to/);
  const readOnly = fixture(t, { workers: ['claude', 'codex'], edits: [] });
  assert.match((await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff edit' }, readOnly)).systemMessage, /No other agent here may edit files/);
  assert.match((await T.run('claude', 'UserPromptSubmit', { ...p, prompt: '/swarm handoff' }, readOnly)).systemMessage, /Could not read this conversation/);
  assert.equal(readOnly.calls.filter(c => c.tool === 'task_submit').length, 0);
  await T.run('claude', 'StopFailure', { ...p, error_type: 'server_error' }, readOnly);
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, readOnly), null, 'other API errors are not usage limits');
});

test('a normal finished turn clears the usage-limit note', async t => {
  const f = fixture(t);
  const p = { session_id: 'y', cwd: '/tmp' };
  await T.run('claude', 'StopFailure', { ...p, error_type: 'rate_limit' }, f);
  await T.run('claude', 'Stop', p, f);
  assert.equal(await T.run('claude', 'UserPromptSubmit', { ...p, prompt: 'hi' }, f), null);
});

test('Codex rollout turns skip injected context', () => {
  const lines = [
    { type: 'session_meta', payload: { cwd: '/p' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } },
  ].map(x => JSON.stringify(x)).join('\n');
  assert.deepEqual(T.extractCodexTurns(lines), [{ role: 'user', text: 'Fix the bug' }, { role: 'assistant', text: 'Fixed.' }]);
});

test('installer adds the turn hooks for Claude Code (with the usage-limit StopFailure) and Codex, and removes only them', async t => {
  const home = temp(); t.after(() => rmSync(home, { recursive: true, force: true }));
  const o = { home, root: '/tmp/swarma', dry: false, log: () => {}, node: process.execPath };
  await installInboxHooks('claude', o);
  const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  const cmds = (ev: string) => claude.hooks[ev].flatMap((g: any) => g.hooks.map((h: any) => h.command)).filter((c: string) => c.includes('swarmaa-turn.mjs'));
  assert.equal(cmds('UserPromptSubmit').length, 1); assert.equal(cmds('Stop').length, 1);
  assert.equal(claude.hooks.StopFailure[0].matcher, 'rate_limit|billing_error');
  assert.match(claude.hooks.StopFailure[0].hooks[0].command, /swarmaa-turn\.mjs' claude StopFailure$/);
  await installInboxHooks('codex', o);
  const codex = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.hooks.StopFailure, undefined, 'Codex has no usage-limit event');
  assert.ok(codex.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command.includes('swarmaa-turn.mjs'))));
  await removeInboxHooks('claude', o); await removeInboxHooks('codex', o);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')), {});
});
