import independentReview from '../../flows/independent-review.json' with { type: 'json' };
import verifiedPatch from '../../flows/verified-patch.json' with { type: 'json' };
import patchThenReview from '../../flows/patch-then-review.json' with { type: 'json' };
import { requireCondition } from '../errors.js';
import { enumValue, object, string, strings } from '../validation.js';
import { jsonObject, noExtraKeys } from './shared.js';

export const CHECKS = ['tests_pass','build_passes','diff_nonempty','files_within'] as const;
export interface FlowCheck { type:typeof CHECKS[number]; globs?:string[] }
export interface FlowStep {
  id:string; kind:'research'|'review'|'patch'|'check'|'approve'; capability:string|{different_provider_than:string};
  objective:string; needs:string[]; pin?:string; check?:FlowCheck;
}
export interface FlowDefinition { id:string; title:string; steps:FlowStep[] }
export interface FlowTask {
  step_id:string; needs:string[]; ready:boolean; commit:string|null; diff_base:string|null;
  provider:string|null; different_provider_than?:string; pin?:string; check?:FlowCheck;
}
export const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const name = (v:unknown):string => {
  const s = string(v,'id',80);
  requireCondition(/^[a-z][a-z0-9-]*$/.test(s),400,'invalid_flow','Flow and step IDs use lowercase letters, digits and hyphens.');
  return s;
};
export function validateFlow(value:unknown):FlowDefinition {
  const v = jsonObject(value,'flow',32768);
  noExtraKeys(v,['id','title','steps']);
  requireCondition(Array.isArray(v.steps) && v.steps.length>0 && v.steps.length<=20,400,'invalid_flow','A flow needs 1–20 steps.');
  const steps:FlowStep[] = v.steps.map(raw => {
    const s = object(raw);
    noExtraKeys(s,['id','kind','capability','objective','needs','pin','check']);
    const kind = enumValue(s.kind,'kind',['research','review','patch','check','approve'] as const);
    let capability:FlowStep['capability'];
    if (typeof s.capability === 'object' && s.capability !== null) {
      const c = object(s.capability); noExtraKeys(c,['different_provider_than']);
      requireCondition(['research','review','patch'].includes(kind),400,'invalid_flow','Only model steps can require another provider.');
      capability = {different_provider_than:name(c.different_provider_than)};
    } else {
      capability = string(s.capability ?? (kind==='check' ? 'bridge.check' : kind==='approve' ? 'owner.approve' : ''),'capability',80);
      const allowed = kind==='check' ? ['bridge.check'] : kind==='approve' ? ['owner.approve'] :
        ['auto','claude','codex','antigravity'].map(p => `${p}.${kind==='patch' ? 'patch' : 'read'}`);
      requireCondition(allowed.includes(capability),400,'invalid_flow','Capability does not match step kind.');
    }
    const needs = strings(s.needs ?? [],'needs',20,80).map(name);
    requireCondition(new Set(needs).size===needs.length,400,'invalid_flow','Dependencies must be unique.');
    const step:FlowStep = {id:name(s.id),kind,capability,objective:string(s.objective,'objective',8000),needs};
    if (s.pin !== undefined) step.pin = name(s.pin);
    requireCondition((s.check !== undefined)===(kind==='check'),400,'invalid_flow','Only check steps must specify check.');
    if (kind==='check') {
      const c = typeof s.check==='string' ? {type:s.check} : object(s.check);
      noExtraKeys(c,['type','globs']);
      const type = enumValue(c.type,'check.type',CHECKS);
      step.check = {type};
      if (type==='files_within') {
        const globs = strings(c.globs,'globs',30,240);
        requireCondition(globs.length>0 && globs.every(g => !g.startsWith('/') && !g.startsWith('!') && !g.includes('..') && !/[\\\x00-\x1f]/.test(g)),400,'invalid_flow','files_within needs relative, non-negated globs without traversal.');
        step.check.globs = globs;
      } else requireCondition(c.globs===undefined,400,'invalid_flow','Only files_within accepts globs.');
      requireCondition(step.pin,400,'invalid_flow','Checks must pin to an upstream patch commit.');
    }
    return step;
  });
  const byId = new Map(steps.map(s => [s.id,s]));
  requireCondition(byId.size===steps.length,400,'invalid_flow','Step IDs must be unique.');
  const ancestry = new Map<string,Set<string>>();
  const ancestors = (id:string,path:string[]=[]):Set<string> => {
    requireCondition(!path.includes(id),400,'invalid_flow','Flow dependencies must be acyclic.');
    const cached = ancestry.get(id); if (cached) return cached;
    const s = byId.get(id);
    requireCondition(s,400,'invalid_flow',`Unknown dependency ${id}.`);
    const all = new Set(s.needs.flatMap(n => [n,...ancestors(n,[...path,id])]));
    ancestry.set(id,all); return all;
  };
  for (const step of steps) {
    const prior = ancestors(step.id);
    for (const ref of [step.pin,typeof step.capability==='object' ? step.capability.different_provider_than : undefined]) {
      requireCondition(!ref || prior.has(ref),400,'invalid_flow','pin and different_provider_than must name a dependency ancestor.');
    }
    if (typeof step.capability==='object') requireCondition(['research','review','patch'].includes(byId.get(step.capability.different_provider_than)!.kind),400,'invalid_flow','different_provider_than must name a model step.');
    if (step.pin) requireCondition(byId.get(step.pin)!.kind!=='approve',400,'invalid_flow','Approval steps do not produce commits.');
    if (step.check) {
      let source = byId.get(step.pin!)!;
      const seen = new Set<string>();
      while (source.kind!=='patch' && source.pin) {
        requireCondition(!seen.has(source.id) && byId.has(source.pin),400,'invalid_flow','Check pin chain must be acyclic and name existing steps.');
        seen.add(source.id); source = byId.get(source.pin)!;
      }
      requireCondition(source.kind==='patch',400,'invalid_flow','Checks must trace their pin to a patch step.');
    }
    for (const match of step.objective.matchAll(/{{([^{}]+)}}/g)) {
      const key = match[1]!;
      const ref = /^steps\.([a-z][a-z0-9-]*)\.result$/.exec(key);
      requireCondition(ref ? prior.has(ref[1]!) : /^(?:inputs\.)?[a-z][a-z0-9_]*$/.test(key),400,'invalid_flow','Templates accept input names or dependency steps.<id>.result only.');
    }
  }
  return {id:name(v.id),title:string(v.title,'title',200),steps};
}
export const BUILTIN_FLOWS = [independentReview,verifiedPatch,patchThenReview].map(validateFlow);

export function flowObjective(step:FlowStep,inputs:Record<string,string>,results:Map<string,unknown>,prefix=''):string {
  const template = /{{([^{}]+)}}/g;
  const dependency = /^steps\.([a-z][a-z0-9-]*)\.result$/;
  const inputValue = (key:string):string => {
    const inputKey = key.replace(/^inputs\./,'');
    const value = inputs[inputKey];
    requireCondition(Object.hasOwn(inputs,inputKey),400,'invalid_flow_inputs',`Missing flow input ${key}.`);
    return value;
  };
  const fixed = prefix+step.objective.replace(template,(_,key:string) => dependency.test(key) ? '' : inputValue(key));
  requireCondition(fixed.length<=16000 && Buffer.byteLength(fixed)<=32768,400,'invalid_flow_inputs','Rendered objective is too large.');
  const refs = [...step.objective.matchAll(template)].filter(m => dependency.test(m[1]!)).length;
  // Reserve bounded space for every result at start; large answers can never roll back an upstream completion.
  const budget = refs ? Math.max(0,Math.min(5000,Math.floor((16000-fixed.length)/refs)-3,Math.floor((32768-Buffer.byteLength(fixed))/refs)-3)) : 0;
  return prefix+step.objective.replace(template,(_,key:string) => {
    const ref = dependency.exec(key);
    return ref ? Buffer.from(JSON.stringify(results.get(ref[1]!) ?? null)).subarray(0,budget).toString('utf8') : inputValue(key);
  });
}
