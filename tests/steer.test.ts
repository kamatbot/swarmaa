import assert from 'node:assert/strict';
import test from 'node:test';
import { finalAnswer, steerLine, steerMarker } from '../src/bridge/adapters.js';
import { runBoundedProcess } from '../src/bridge/process.js';

test('a steered Claude run answers with every result, in order', () => {
  const out = [
    JSON.stringify({ type: 'result', subtype: 'success', result: 'First reply.' }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: steerMarker(7) }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Second reply.' }),
  ].join('\n');
  assert.equal(finalAnswer('claude', out), 'First reply.\n\nSecond reply.');
});

test('steer line is one stream-json user message carrying the marker and fenced body', () => {
  const line = steerLine(12, 'also fix the typo');
  assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
  const msg = JSON.parse(line) as { type: string; message: { role: string; content: Array<{ text: string }> } };
  assert.equal(msg.type, 'user');
  assert.ok(msg.message.content[0]!.text.startsWith(steerMarker(12)));
  assert.ok(msg.message.content[0]!.text.includes('also fix the typo'));
});

test('kept-open stdin takes later writes, and on_line reports bounded line heads', async () => {
  const heads: string[] = [];
  const tails: string[] = [];
  let ctl: { write: (t: string) => boolean; end: () => void } | undefined;
  const long = 'x'.repeat(5000);
  const done = runBoundedProcess({
    command: '/bin/cat', args: [], cwd: '/', env: {}, input: 'first\n', keep_stdin_open: true,
    timeout_ms: 5000, max_output_bytes: 1 << 20,
    on_stdin: c => { ctl = c; }, on_line: (h, t) => { heads.push(h); tails.push(t); }
  });
  assert.ok(ctl);
  // Claude's result event: "type" comes after a long result string, so only the line's tail shows it.
  const result = JSON.stringify({ duration_ms: 1, result: 'y'.repeat(4000), type: 'result', subtype: 'success' });
  assert.equal(ctl.write(`${long}\n${result}\n`), true);
  ctl.end();
  assert.equal(ctl.write('late\n'), false);
  const out = await done;
  assert.equal(out.exit_code, 0);
  assert.equal(out.stdout, `first\n${long}\n${result}\n`);
  assert.deepEqual(heads.map(h => h.length), [5, 2048, 2048]);
  assert.ok(!heads[2]!.includes('"type":"result"') && tails[2]!.includes('"type":"result"'));
});
