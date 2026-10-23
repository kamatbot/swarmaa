import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBridgeConfig, readTokenFile, serviceUrl } from '../src/bridge/config.js';
import { buildInvocation, finalAnswer, projectCapabilities, providerEnvironment, providerSucceeded } from '../src/bridge/adapters.js';
import type { ProcessResult, Task } from '../src/bridge/types.js';

const input = () => ({ service_url: 'http://127.0.0.1:8080', agents: [{ id: 'claude', provider: 'claude', binary: '/bin/claude', enable_patch: false, sandbox: false }], projects: [{scope: 'project:demo', root: '/projects/demo', agents: ['claude'], allow_patch: false}] });
const task: Task = { id: '11111111-1111-4111-8111-111111111111', scope: 'project:demo', kind: 'review', objective: 'Review; $(touch /tmp/injected)', constraints: ['read only'], acceptance_criteria: [], resource_key: null, required_capability: 'claude.read', checkpoint: null, context_refs: [], version: 1 };

test('config rejects insecure remote origins, credentials and ambiguous local mapping', () => {
  assert.throws(() => serviceUrl('http://example.com'));
  assert.throws(() => serviceUrl('https://user:password@example.com'));
  assert.throws(() => serviceUrl('https://example.com/path'));
  const duplicate = input(); duplicate.projects.push(duplicate.projects[0]!);
  assert.throws(() => parseBridgeConfig(duplicate));
  assert.equal(serviceUrl('https://example.com/'), 'https://example.com');
});



test('patch requires explicit project and provider opt-ins; unsupported modes fail closed', () => {
  const config = parseBridgeConfig(input());
  assert.deepEqual(projectCapabilities(config.projects[0]!, config.agents), ['claude.read','auto.read']);
  assert.throws(() => buildInvocation(config.agents[0]!, config.projects[0]!, {...task, kind:'patch', required_capability:'claude.patch'}, {}, config, new AbortController().signal));
  const enabled = input(); enabled.agents[0]!.enable_patch = true; enabled.projects[0]!.allow_patch = true;
  const patchConfig = parseBridgeConfig(enabled);
  assert.deepEqual(projectCapabilities(patchConfig.projects[0]!, patchConfig.agents), ['claude.read','claude.patch','auto.read','auto.patch']);
});

test('exit zero without provider completion is not reported successful', () => {
  const result: ProcessResult = { exit_code:0, signal:null, stdout:'',stderr:'',duration_ms:1,stop_reason:null };
  assert.equal(providerSucceeded('claude', result), false);
  assert.equal(providerSucceeded('claude', {...result, stdout:JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true})}), false);
  assert.equal(providerSucceeded('claude', {...result, stdout:JSON.stringify({type:'result',subtype:'success',is_error:false})}), true);
  assert.equal(providerSucceeded('codex', {...result,stdout:'{"type":"turn.completed"}\n'}), true);
  assert.equal(providerSucceeded('codex', {...result,stdout:'{"type":"turn.completed"}\n{"type":"turn.failed"}\n'}), false);
  // Reconnect notices Codex recovers from are not failures (task afdc3554 was marked failed on these).
  assert.equal(providerSucceeded('codex', {...result,stdout:'{"type":"error","message":"Reconnecting... 2/5 (workspace routing discovery timed out)"}\n{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport."}}\n{"type":"turn.completed"}\n'}), true);
  assert.equal(providerSucceeded('codex', {...result,stdout:'{"type":"error","message":"stream disconnected"}\n'}), false);
});

test('token_file must be absolute and owner-only', async () => {
  assert.throws(() => parseBridgeConfig({ ...input(), token_file: 'relative.json' }));
  const dir = await mkdtemp(join(tmpdir(), 'swarma-token-'));
  try {
    const file = join(dir, 'worker.json');
    await writeFile(file, JSON.stringify({ token: 'cn_test' }), { mode: 0o644 });
    await assert.rejects(readTokenFile(file), /chmod 600/);
    await chmod(file, 0o600);
    assert.equal(await readTokenFile(file), 'cn_test');
    assert.equal(parseBridgeConfig({ ...input(), token_file: file }).token_file, file);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('finalAnswer extracts the agent answer from Codex events and Claude results', async () => {
  const { finalAnswer } = await import('../src/bridge/adapters.js');
  const codex = ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"x"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}', '{"type":"turn.completed"}', '{"partial'].join('\n');
  assert.equal(finalAnswer('codex', codex), 'final answer');
  assert.equal(finalAnswer('codex', '{"msg":{"type":"agent_message","message":"legacy"}}'), 'legacy');
  assert.equal(finalAnswer('claude', '{"type":"result","subtype":"success","result":"done"}'), 'done');
  assert.equal(finalAnswer('claude', 'not json'), '');
});


const agy = (extra: Record<string, unknown> = {}) => ({ ...input(), agents: [{ id: 'antigravity', provider: 'antigravity', binary: '/bin/agy', ...extra }], projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['antigravity'] }] });

test('antigravity: sandbox-only, advertises antigravity.read + auto.read', () => {
  const cfg = parseBridgeConfig(agy());
  assert.equal(cfg.agents[0]!.sandbox, true);
  assert.deepEqual(projectCapabilities(cfg.projects[0]!, cfg.agents), ['antigravity.read', 'auto.read']);
  assert.throws(() => parseBridgeConfig(agy({ sandbox: false })), /sandbox:true/u);
});

test('antigravity argv: sandboxed default mode + skip-permissions, json, prompt attached to -p=, no token, no stdin', { skip: process.platform !== 'darwin' }, () => {
  const cfg = parseBridgeConfig(agy());
  const t = { ...task, required_capability: 'antigravity.read', objective: '$(touch /tmp/x); --mode auto' };
  const req = buildInvocation(cfg.agents[0]!, cfg.projects[0]!, t, {}, cfg, new AbortController().signal, { COLLECTIVE_WORKER_TOKEN: 'secret', HOME: '/h', GEMINI_API_KEY: 'k' });
  assert.equal(req.command, '/usr/bin/sandbox-exec');
  const [, , bin, ...args] = req.args;
  assert.equal(bin, '/bin/agy');
  assert.deepEqual(args.slice(0, 5), ['--output-format', 'json', '--print-timeout', '3600s', '--dangerously-skip-permissions']);
  assert.ok(!args.includes('--sandbox') && !args.includes('--mode'));
  const prompts = args.filter(a => a.startsWith('-p='));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes('$(touch /tmp/x); --mode auto'));
  assert.equal(req.input, '');
  assert.ok(!JSON.stringify(req.env).includes('secret'));
  assert.throws(() => buildInvocation(cfg.agents[0]!, cfg.projects[0]!, { ...t, kind: 'patch', required_capability: 'antigravity.patch' }, {}, cfg, new AbortController().signal));
});

const all = (sandbox: boolean) => parseBridgeConfig({ service_url: 'http://127.0.0.1:8080', agents: [
  { id: 'claude', provider: 'claude', binary: '/bin/claude', enable_patch: true, sandbox }, { id: 'codex', provider: 'codex', binary: '/bin/codex', enable_patch: true, sandbox },
  { id: 'antigravity', provider: 'antigravity', binary: '/bin/agy', enable_patch: true }],
  projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['claude', 'codex', 'antigravity'], allow_patch: true }] });
const patchReq = (cfg: ReturnType<typeof all>, id: string, cap = `${id}.patch`) => {
  const a = cfg.agents.find(x => x.id === id)!;
  const r = buildInvocation(a, cfg.projects[0]!, { ...task, kind: 'patch', required_capability: cap }, {}, cfg, new AbortController().signal, {}, { dir: '/wt/x', gitDir: '/projects/demo/.git' });
  const i = r.args.indexOf(a.binary);
  return { r, args: i >= 0 ? r.args.slice(i + 1) : r.args };
};

test('patch is advertised and built for every provider, plus auto.patch', () => {
  const cfg = all(false);
  assert.deepEqual(projectCapabilities(cfg.projects[0]!, cfg.agents), ['claude.read', 'claude.patch', 'codex.read', 'codex.patch', 'antigravity.read', 'antigravity.patch', 'auto.read', 'auto.patch']);
  assert.equal(cfg.task_timeout_seconds, 3600);
  const noPatch = projectCapabilities({ ...cfg.projects[0]!, allow_patch: false }, cfg.agents);
  assert.ok(!noPatch.includes('auto.patch') && !noPatch.some(c => c.endsWith('.patch')));
});


test('antigravity result parsing', () => {
  const ok = { exit_code: 0, signal: null, stderr: '', duration_ms: 1, stop_reason: null, stdout: JSON.stringify({ status: 'SUCCESS', response: 'done\n' }) } as const;
  assert.equal(providerSucceeded('antigravity', ok), true);
  assert.equal(finalAnswer('antigravity', ok.stdout), 'done\n');
  assert.equal(providerSucceeded('antigravity', { ...ok, stdout: JSON.stringify({ status: 'ERROR', response: '' }) }), false);
  assert.equal(providerSucceeded('antigravity', { ...ok, stdout: JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] }) }), false);
  assert.equal(providerSucceeded('antigravity', { ...ok, stdout: 'not json' }), false);
  assert.equal(providerSucceeded('antigravity', { ...ok, exit_code: 1 }), false);
});

test('deniedActions reads Antigravity denials and ignores other providers', async () => {
  const { deniedActions } = await import('../src/bridge/adapters.js');
  const out = JSON.stringify({ status: 'SUCCESS', response: 'I will clone it first.', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
  assert.deepEqual(deniedActions('antigravity', out), ['RunCommand']);
  assert.deepEqual(deniedActions('antigravity', JSON.stringify({ status: 'SUCCESS', response: 'done' })), []);
  assert.deepEqual(deniedActions('codex', out), []);
  assert.deepEqual(deniedActions('antigravity', 'not json'), []);
});

test('workers run the real CLIs headless with auto-approved permissions, wrapped in the light sandbox', () => {
  const cfg = (provider: string, sandbox: boolean, patch = false) => parseBridgeConfig({ service_url: 'http://127.0.0.1:8080',
    agents: [{ id: provider, provider, binary: `/bin/${provider}`, enable_patch: patch, sandbox }], projects: [{ scope: 'project:demo', root: '/projects/demo', agents: [provider], allow_patch: patch }] });
  const run = (provider: string, sandbox: boolean, kind: 'review' | 'patch' = 'review') => {
    const c = cfg(provider, sandbox, kind === 'patch');
    return buildInvocation(c.agents[0]!, c.projects[0]!, { ...task, kind, required_capability: `${provider}.${kind === 'patch' ? 'patch' : 'read'}` }, {}, c, new AbortController().signal, { PATH: '/bin', COLLECTIVE_MCP_TOKEN: 'secret', MY_MCP_KEY: 'k' });
  };
  const claude = run('claude', false);
  assert.deepEqual(claude.args, ['--print', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--max-turns', '200']);
  assert.ok(!claude.args.some(a => ['--restricted', '--tools', '--strict-mcp-config', '--no-session-persistence'].includes(a)));
  assert.equal(claude.cwd, '/projects/demo');
  assert.ok(claude.input.includes('Review; $(touch /tmp/injected)'), 'task text stays stdin data');
  assert.deepEqual(run('codex', false).args, ['--search', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-']);
  const agy = run('antigravity', true); // agy always runs inside the sandbox
  assert.deepEqual(agy.args.slice(2, 8), ['/bin/antigravity', '--output-format', 'json', '--print-timeout', '3600s', '--dangerously-skip-permissions']);
  assert.ok(agy.args.at(-1)!.startsWith('-p=') && agy.input === '');
  const wrapped = run('codex', true, 'patch');
  assert.equal(wrapped.command, '/usr/bin/sandbox-exec');
  assert.match(wrapped.args[1]!, /\(allow default\)/u);
  assert.deepEqual(wrapped.args.slice(2, 5), ['/bin/codex', '--search', 'exec']);
  // The user's own environment reaches the CLI (MCP keys, config), minus the bridge's service token.
  assert.equal(claude.env.MY_MCP_KEY, 'k');
  assert.equal(claude.env.COLLECTIVE_MCP_TOKEN, undefined);
  assert.equal(providerEnvironment('codex', { A: '1', T: 'x' }, 'T').T, undefined);
});
