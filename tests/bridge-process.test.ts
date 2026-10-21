import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedProcess } from '../src/bridge/process.js';

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
