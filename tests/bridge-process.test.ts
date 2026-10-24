import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedProcess } from '../src/bridge/process.js';

test('stdin receipt requires a spawned process and a complete bounded prompt flush', async () => {
  const input = 'queued task guidance\n'.repeat(32 * 1024);
  const result = await runBoundedProcess({command:process.execPath,args:['-e','let n=0; process.stdin.on("data", x => n += x.length); process.stdin.on("end", () => process.stdout.write(String(n)));'],cwd:process.cwd(),env:{PATH:process.env.PATH},input,timeout_ms:5000,max_output_bytes:8192});
  assert.equal(result.exit_code,0);
  assert.equal(result.input_delivered,true);
  assert.equal(Number(result.stdout),Buffer.byteLength(input));
});

test('missing executable, pre-start abort and early stdin closure do not produce delivery receipts', async () => {
  const request = {command:process.execPath,args:['-e','process.stdin.destroy(); process.exit(0);'],cwd:process.cwd(),env:{PATH:process.env.PATH},input:'x'.repeat(4 * 1024 * 1024),timeout_ms:5000,max_output_bytes:8192};
  const failed = await runBoundedProcess({...request,command:'/swarmaa-no-such-executable'});
  assert.equal(failed.stop_reason,'spawn_error');
  assert.notEqual(failed.input_delivered,true);
  const controller = new AbortController(); controller.abort();
  const aborted = await runBoundedProcess({...request,signal:controller.signal});
  assert.equal(aborted.stop_reason,'aborted');
  assert.notEqual(aborted.input_delivered,true);
  const closed = await runBoundedProcess(request);
  assert.notEqual(closed.input_delivered,true);
});

test('argv-only input records spawn without claiming successful provider processing', async () => {
  const result = await runBoundedProcess({command:process.execPath,args:['-e','process.exit(2);','queued task guidance'],cwd:process.cwd(),env:{PATH:process.env.PATH},input:'',timeout_ms:5000,max_output_bytes:8192});
  assert.equal(result.exit_code,2);
  assert.equal(result.input_delivered,true);
});

test('subprocess output is capped and runaway child is terminated', async () => {
  const result = await runBoundedProcess({command:process.execPath,args:['-e','setInterval(() => process.stdout.write("x".repeat(4096)), 1)'],cwd:process.cwd(),env:{PATH:process.env.PATH},input:'',timeout_ms:5000,max_output_bytes:8192});
  assert.equal(result.stop_reason,'output_limit');
  assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=8192);
});

test('timeout and abort terminate child instead of waiting for model indefinitely', async () => {
  const request = {command:process.execPath,args:['-e','setInterval(() => {}, 1000)'],cwd:process.cwd(),env:{PATH:process.env.PATH},input:'',timeout_ms:100,max_output_bytes:8192};
  assert.equal((await runBoundedProcess(request)).stop_reason,'timeout');
  const controller=new AbortController();controller.abort();
  assert.equal((await runBoundedProcess({...request,signal:controller.signal})).stop_reason,'aborted');
});
