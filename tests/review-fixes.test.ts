import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedProcess, slideTail } from '../src/bridge/process.js';
import { swarmBranchRef } from '../src/core/sources.js';

test('stdout tail keeps the last 8 KiB in linear time', () => {
  const chunk = Buffer.alloc(128, 0x61);
  let tail: Uint8Array = Buffer.alloc(0);
  const started = performance.now();
  for (let i = 0; i < 8192; i++) tail = slideTail(tail, chunk);
  const elapsed = performance.now() - started;
  assert.equal(tail.length, 8192);
  assert.ok(elapsed < 250, `sliding 1 MiB took ${elapsed.toFixed(0)} ms`);
  const big = Buffer.alloc(9000, 0x62);
  assert.equal(slideTail(tail, big).length, 8192);
  assert.equal(slideTail(tail, big)[0], 0x62);
});

test('a provider stream reports an 8 KiB stdout tail and keeps stderr out of it', async () => {
  const tails: string[] = [];
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("err"); for (let i = 0; i < 300; i++) process.stdout.write("x".repeat(40));'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    input: '',
    timeout_ms: 10_000,
    max_output_bytes: 64 * 1024,
    on_progress: progress => tails.push(progress.stdout_tail),
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'x'.repeat(12000));
  assert.equal(result.stderr, 'err');
  assert.ok(tails.at(-1)?.endsWith('x'));
  assert.equal(Buffer.byteLength(tails.at(-1) ?? ''), 8192);
  assert.equal(tails.some(t => t.includes('err')), false);
});

test('swarm branch refs accept a full task id and the older 8-hex prefix', () => {
  const id = '12345678-1111-4111-8111-111111111111';
  assert.deepEqual(swarmBranchRef(`swarmaa/claude/${id}`), { provider: 'claude', taskId: id, exact: true });
  assert.deepEqual(swarmBranchRef('swarmaa/codex/12345678'), { provider: 'codex', taskId: '12345678', exact: false });
  assert.equal(swarmBranchRef('swarma/claude/12345678'), null);
  assert.equal(swarmBranchRef('swarmaa/claude/not-a-task'), null);
});
