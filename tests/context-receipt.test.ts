import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPrompt } from '../src/bridge/adapters.js';
import { annotateEvidence, contextReceipt } from '../src/bridge/context-receipt.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { RemoteError } from '../src/bridge/client.js';
import { orTerms } from '../src/core/memory.js';
import { sourceInput } from '../src/core/shared.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

const task: Task = { id:'11111111-1111-4111-8111-111111111111',scope:'project:demo',kind:'review',objective:'Review source',constraints:[],acceptance_criteria:[],resource_key:null,required_capability:'claude.read',checkpoint:null,context_refs:[],version:1 };
const mem = (id: string, reason: string, size = 10) => ({ id, key: `k-${id}`, version: 1, included_reason: reason, content: 'x'.repeat(size) });

test('orTerms makes an any-word query from letters and digits only, without stopwords', () => {
  assert.equal(orTerms('Deploy the RetireOdds app; run migrate & smoke!'), 'deploy | retireodds | app | run | migrate | smoke');
  assert.equal(orTerms("x' | !( :*"), null);
  assert.equal(orTerms(null), null);
});

test('source.evidence accepts repo paths pinned to commits and rejects traversal or non-hex commits', () => {
  const p = { id: 'p' } as never;
  const ok = sourceInput({ type: 'agent', reference: 'r', evidence: [{ path: 'src/core/memory.ts', commit: 'ABC1234' }] }, p);
  assert.deepEqual(ok.evidence, [{ path: 'src/core/memory.ts', commit: 'abc1234' }]);
  assert.equal(sourceInput({ type: 'agent', reference: 'r' }, p).evidence, undefined);
  for (const evidence of [[{ path: '../etc/passwd', commit: 'abc1234' }], [{ path: '/abs', commit: 'abc1234' }], [{ path: 'a', commit: 'main' }], [{ path: 'a', commit: 'abc1234', x: 1 }]])
    assert.throws(() => sourceInput({ type: 'agent', reference: 'r', evidence }, p), /evidence|Unknown argument/);
});

test('buildPrompt drops optional memories lowest-ranked first to fit, never explicit refs, then fails with sizes', () => {
  const context = { memories: [mem('a', 'explicit_ref', 2000), mem('b', 'search_match', 2000), mem('c', 'search_match', 2000)] } as Record<string, any>;
  const base = Buffer.byteLength(buildPrompt(task, { memories: [] }, 1e6), 'utf8');
  const prompt = buildPrompt(task, context, base + 4300);
  assert.deepEqual(context.memories.map((m: { id: string }) => m.id), ['a', 'b']);
  assert.deepEqual(context.omitted, [{ kind: 'memory', id: 'c', key: 'k-c', reason: 'prompt_limit' }]);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= base + 4300);
  const tight = { memories: [mem('a', 'explicit_ref', 2000), mem('b', 'recent', 2000)] } as Record<string, any>;
  assert.throws(() => buildPrompt(task, tight, base + 100), (e: any) => e.code === 'context_too_large' && e.detail.limit_bytes === base + 100 && e.detail.parts.memories > 2000);
  assert.deepEqual(tight.memories.map((m: { id: string }) => m.id), ['a']);
});

test('annotateEvidence labels memories current, source_changed, source_missing or unverified at the base', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(root, 'a.ts'), 'one'); writeFileSync(join(root, 'b.ts'), 'two'); writeFileSync(join(root, 'c.ts'), 'three');
    git('add', '.'); git('commit', '-qm', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'b.ts'), 'changed'); git('rm', '-q', 'c.ts'); git('commit', '-qam', 'two');
    const ev = (path: string, commit = first) => ({ source: { evidence: [{ path, commit }] } });
    const context = { memories: [ev('a.ts'), ev('b.ts'), ev('c.ts'), ev('a.ts', 'deadbee'), { source: {} }] } as { memories: Array<Record<string, unknown>> };
    return annotateEvidence(context, root, 'HEAD').then(() => {
      assert.deepEqual(context.memories.map(m => m.validity), ['current', 'source_changed', 'source_missing', 'unverified', undefined]);
      assert.match(String(context.memories[1]!.validity_note), /verify/);
    }).finally(() => rmSync(root, { recursive: true, force: true }));
  } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; }
});

test('contextReceipt hashes the prompt and lists memories for tasks, thread window and swarms for turns', () => {
  const r = contextReceipt(task, { memories: [{ ...mem('a', 'explicit_ref'), validity: 'source_changed', source: { evidence: [{ path: 'x', commit: 'abc1234' }] } }], lessons: [{ id: 'L-1', title: 'Migrate first' }], omitted: [{ kind: 'memory', id: 'z', reason: 'budget' }] }, 'abcd', 1000, 'feat/x');
  assert.equal(r.prompt_bytes, 4); assert.equal(r.estimated_tokens, 1); assert.equal(r.base_ref, 'feat/x');
  assert.match(String(r.prompt_sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual((r.items as any[]).map(i => [i.kind, i.reason, i.validity]), [['memory', 'explicit_ref', 'source_changed'], ['lesson', 'lesson_match', undefined]]);
  assert.equal((r.omitted as unknown[]).length, 1);
  const turn = { ...task, kind: 'turn', thread_messages: [
    { seq: 3, author: { kind: 'user', id: 'u' }, kind: 'text', body: 'hi' },
    { seq: 4, author: { kind: 'agent', id: 'a' }, kind: 'swarm', body: 'Swarm "Pilots" (id s1) is completed, branching from main.', ref: { swarm_id: 's1' } }] } as unknown as Task;
  const t = contextReceipt(turn, { memories: [mem('a', 'recent')] }, 'p', 1000, null);
  assert.deepEqual(t.items, [{ kind: 'thread', first_seq: 3, last_seq: 4, count: 2 }, { kind: 'swarm', id: 's1', title: 'Pilots', status: 'completed' }]);
});

const result: ProcessResult = {exit_code:0,signal:null,stdout:'{"type":"result","subtype":"success","is_error":false}',stderr:'',duration_ms:10,stop_reason:null};
const config = () => parseBridgeConfig({ service_url:'http://localhost:8080', agents:[{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:false}], projects:[{scope:'project:demo',root:'/projects/demo',agents:['claude']}] });

test('a service restart before the provider starts is retried, and the result records the context used', { timeout: 10_000 }, async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = []; let fails = 2;
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='context_get') { if (fails-- > 0) throw new Error('fetch failed'); return {scope:task.scope,memories:[mem('m1','search_match')],lessons:[],conflicts:[],omitted:[]} as T; }
    if(name==='artifact_put') return {artifact:{id:'22222222-2222-4222-8222-222222222222'}} as T;
    return {task} as T;
  } };
  const cfg = config();
  const worker = new BridgeWorker(cfg,client,()=>{},async () => result);
  await worker.claimAndRun(cfg.projects,new AbortController().signal);
  const finish = calls.find(c=>c.name==='task_finish')!;
  assert.equal(finish.args.outcome,'completed');
  assert.equal(calls.filter(c=>c.name==='context_get').length,3);
  const used = (finish.args.result as any).context_used;
  assert.equal(used.items[0].id,'m1'); assert.ok(used.prompt_bytes > 0);
});

test('a refused context_get blocks at once with a code-specific summary', async () => {
  const calls: {name:string;args:Record<string,unknown>}[] = [];
  const client: ToolClient = { async call<T>(name:string,args:Record<string,unknown>):Promise<T> {
    calls.push({name,args});
    if(name==='task_claim') return {task,lease_token:'lease-secret',lease_generation:1} as T;
    if(name==='context_get') throw Object.assign(new RemoteError(404,'not_found'),{code:'not_a_git_repo'});
    return {task} as T;
  } };
  const cfg = config();
  await new BridgeWorker(cfg,client,()=>{},async () => result).claimAndRun(cfg.projects,new AbortController().signal);
  const finish = calls.find(c=>c.name==='task_finish')!;
  assert.equal(calls.filter(c=>c.name==='context_get').length,1);
  assert.equal(finish.args.outcome,'blocked');
  assert.match(String((finish.args.result as any).summary),/git init/);
});
