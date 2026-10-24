import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_FLOWS, flowObjective, validateFlow } from '../src/core/flow-definition.js';
import { parseBridgeConfig } from '../src/bridge/config.js';

const review = () => structuredClone(BUILTIN_FLOWS[0]!);
test('built-in flows validate and synthesis takes both independent reviews',() => {
  assert.deepEqual(BUILTIN_FLOWS.map(f => f.id),['independent-review','verified-patch','patch-then-review']);
  const f = review();
  assert.deepEqual(f.steps[1]!.capability,{different_provider_than:'review-a'});
  assert.deepEqual(f.steps[2]!.needs,['review-a','review-b']);
  assert.equal(f.steps[1]!.pin,'review-a');
  assert.match(flowObjective(f.steps[2]!,{objective:'fixture'},new Map([['review-a',{answer:'first'}],['review-b',{answer:'second'}]])),/first.*second/);
});
test('definitions reject cycles, missing refs, invalid pins, arbitrary commands and kind escalation',() => {
  const bad = (mutate:(f:any)=>void) => { const f=review(); mutate(f); assert.throws(() => validateFlow(f)); };
  bad(f => f.steps[0].needs=['synthesis']);
  bad(f => f.steps[0].needs=['missing']);
  bad(f => f.steps[1].needs=[]);
  bad(f => f.steps[1].pin='missing');
  bad(f => f.steps[1].capability={different_provider_than:'missing'});
  bad(f => f.steps[1].capability='auto.patch');
  bad(f => f.steps[0].check={type:'tests_pass'});
  bad(f => f.steps[1].id='review-a');
  bad(f => f.steps[2].objective='{{steps.missing.result}}');
  bad(f => f.steps[0].objective='{{steps.review-b.result}}');
  const patch=structuredClone(BUILTIN_FLOWS[1]!) as any;
  patch.steps[1].check.command='curl example.test';
  assert.throws(() => validateFlow(patch));
  patch.steps[1].check={type:'files_within',globs:['../private/**']};
  assert.throws(() => validateFlow(patch));
  patch.steps[1].check={type:'files_within',globs:['src/**','tests/**/*.ts']};
  assert.equal(validateFlow(patch).steps[1]!.check!.type,'files_within');
});
test('template inputs are required, bounded plain text and never evaluated',() => {
  const step=review().steps[0]!;
  assert.throws(() => flowObjective(step,{},new Map()));
  assert.throws(() => flowObjective({...step,objective:'{{constructor}}'},{},new Map()));
  assert.match(flowObjective(step,{objective:'$(touch /tmp/nope) {{inputs.other}}'},new Map()),/\$\(touch/);
  assert.throws(() => flowObjective(step,{objective:'x'.repeat(17000)},new Map()));
});
test('checks opt in through static owner config with bounded executable argv',() => {
  const base={service_url:'http://localhost:8080',agents:[{id:'codex',provider:'codex',binary:'/bin/fixture',enable_patch:true,sandbox:false}],projects:[{scope:'project:a',root:'/tmp/fixture',agents:['codex'],allow_patch:true,checks:{tests_pass:{command:process.execPath,args:['--test'],timeout_seconds:600}}}]};
  assert.equal(parseBridgeConfig(base).projects[0]!.checks!.tests_pass!.timeout_seconds,600);
  for (const value of [{command:'npm',args:['test']},{command:process.execPath,args:'--test'},{command:process.execPath,args:[],timeout_seconds:0},{command:process.execPath,args:[],env:{SECRET:'x'}}]) {
    assert.throws(() => parseBridgeConfig({...base,projects:[{...base.projects[0],checks:{tests_pass:value}}]}));
  }
});

test('large dependency results cannot prevent an upstream completion from activating a step',() => {
  const step=review().steps[2]!;
  const rendered=flowObjective(step,{objective:'x'.repeat(7000)},new Map([['review-a',{answer:'🙂'.repeat(20000)}],['review-b',{answer:'z'.repeat(60000)}]]));
  assert.ok(rendered.length<=16000); assert.ok(Buffer.byteLength(rendered)<=32768);
});

test('malformed unsorted check pin chains terminate even before their own dependency validation',() => {
  assert.throws(() => validateFlow({id:'pin-cycle',title:'Invalid',steps:[
    {id:'a',kind:'check',objective:'check',needs:['b'],pin:'b',check:'tests_pass'},
    {id:'b',kind:'check',objective:'check',needs:[],pin:'a',check:'tests_pass'},
  ]}));
});
