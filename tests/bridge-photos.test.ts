import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { buildInvocation, buildTurnPrompt, withTurnImages } from '../src/bridge/adapters.js';
import type { Task } from '../src/bridge/types.js';

const bytes = await readFile(new URL('./fixtures/chat-photo.jpg', import.meta.url));
const photo = { id: 'p', name: 'ignored.jpg', media_type: 'image/jpeg', byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data_base64: bytes.toString('base64') };
const task = { id:'x', scope:'project:demo', kind:'turn', objective:'Answer', constraints:[], acceptance_criteria:[], resource_key:null, required_capability:'codex.read', checkpoint:null, context_refs:[], version:1, thread_messages:[{seq:3, author:{kind:'user',id:'u'},kind:'text',body:'look',attachments:[photo, {...photo, data_base64:undefined}]}] } as unknown as Task;
const config = (provider: string) => parseBridgeConfig({ service_url:'http://127.0.0.1:8080', agents:[{id:provider,provider,binary:'/bin/true',sandbox:provider === 'antigravity'}], projects:[{scope:'project:demo',root:'/tmp',agents:[provider]}] });

test('Codex receives private image files, removed after success and failure', async () => {
  const cfg = config('codex'); let path = '';
  for (const fail of [false, true]) {
    const controller = new AbortController();
    const run = withTurnImages(cfg.agents[0]!, task, {}, async images => {
      path = images[0]!.path!;
      assert.deepEqual(await readFile(path), bytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(path.substring(0, path.lastIndexOf('/')))).mode & 0o777, 0o700);
      const req = buildInvocation(cfg.agents[0]!,cfg.projects[0]!,task,{},cfg,new AbortController().signal,{},undefined,undefined,images);
      assert.equal(req.args[req.args.indexOf('--image') + 1],path);
      assert.ok(!req.input.includes(photo.data_base64));
      assert.ok(!req.args.join(' ').includes(photo.data_base64));
      assert.match(req.input,/older photo unavailable/);
      if (fail) { controller.abort(); await new Promise<void>((resolve, reject) => controller.signal.aborted ? reject(new Error('aborted')) : resolve()); }
    });
    if (fail) await assert.rejects(run, /aborted/); else await run;
    await assert.rejects(access(path));
  }
});

test('Claude receives image blocks through stream JSON stdin', async () => {
  const cfg = config('claude'); const t = { ...task, required_capability:'claude.read' };
  await withTurnImages(cfg.agents[0]!,t,{},async images => {
    const req = buildInvocation(cfg.agents[0]!,cfg.projects[0]!,t,{},cfg,new AbortController().signal,{},undefined,undefined,images);
    assert.deepEqual(req.args.slice(req.args.indexOf('--input-format'),req.args.indexOf('--input-format')+2),['--input-format','stream-json']);
    assert.ok(!req.args.join(' ').includes(photo.data_base64));
    const content = JSON.parse(req.input).message.content;
    assert.equal(content[2].source.data,photo.data_base64);
    assert.match(content[1].text,/message #3/);
    assert.ok(!buildTurnPrompt(t, {}).includes(photo.data_base64));
  });
});

test('invalid, oversized, excessive and unsupported photo payloads fail closed', async () => {
  const cfg = config('codex');
  for (const altered of [{...photo,sha256:'bad'}, {...photo,data_base64:'A'.repeat(220000)}, {...photo,byte_length:999}]) {
    const t = {...task,thread_messages:[{seq:1,attachments:[altered]}]};
    await assert.rejects(withTurnImages(cfg.agents[0]!,t,{},async () => {}), /Invalid photo/);
  }
  const t = {...task,thread_messages:[{seq:1,attachments:[photo,photo,photo]}]};
  await assert.rejects(withTurnImages(cfg.agents[0]!,t,{},async () => {}), /Too many/);
  const agy = config('antigravity');
  await assert.rejects(withTurnImages(agy.agents[0]!,task,{},async () => {}), /not supported/);
});

test('worker stores photo turn answer and removes image on completion and abort', async () => {
  const { BridgeWorker } = await import('../src/bridge/worker.js');
  for (const abort of [false, true]) {
    const cfg = config('codex');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'task_claim') return { task, lease_token:'lease', lease_generation:1 } as T;
      if (name === 'context_get') return { scope:task.scope, memories:[], conflicts:[] } as T;
      if (name === 'artifact_put') return { artifact:{id:'artifact'} } as T;
      return { task } as T;
    } };
    const controller = new AbortController(); let path = '';
    const worker = new BridgeWorker(cfg, client, () => {}, async request => {
      path = request.args[request.args.indexOf('--image') + 1]!;
      assert.deepEqual(await readFile(path), bytes);
      if (abort) {
        controller.abort();
        assert.equal(request.signal?.aborted, true);
        return { exit_code:null, signal:null, stdout:'', stderr:'', duration_ms:1, stop_reason:'aborted' };
      }
      return { exit_code:0, signal:null, stdout:'{"type":"item.completed","item":{"type":"agent_message","text":"red"}}\n{"type":"turn.completed"}\n', stderr:'', duration_ms:1, stop_reason:null };
    });
    await worker.claimAndRun(cfg.projects, controller.signal);
    await assert.rejects(access(path));
    const finish = calls.find(call => call.name === 'task_finish');
    assert.ok(finish);
    if (!abort) {
      assert.equal(finish.args.outcome, 'completed');
      assert.equal((finish.args.result as {answer:string}).answer, 'red');
      assert.ok(!JSON.stringify(calls).includes(photo.data_base64));
    } else assert.notEqual(finish.args.outcome, 'completed');
  }
});
