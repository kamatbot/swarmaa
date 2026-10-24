import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBridgeConfig, readTokenFile, serviceUrl } from '../src/bridge/config.js';
import { buildInvocation, cleanupInvocation, deniedActions, finalAnswer, projectCapabilities, providerEnvironment, providerSucceeded } from '../src/bridge/adapters.js';
import { cleanupNative, prepareNative } from '../src/bridge/native-session.js';
import type { ProcessRequest, ProcessResult, Provider, Task } from '../src/bridge/types.js';

const input = () => ({ service_url: 'http://127.0.0.1:8080', agents: [{ id: 'claude', provider: 'claude', binary: '/bin/claude', enable_patch: false, sandbox: true }], projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['claude'], allow_patch: false }] });
const task: Task = { id: '11111111-1111-4111-8111-111111111111', scope: 'project:demo', kind: 'review', objective: 'Review; $(touch /tmp/injected)', constraints: ['read only'], acceptance_criteria: [], resource_key: null, required_capability: 'claude.read', checkpoint: null, context_refs: [], version: 1 };
const result: ProcessResult = { exit_code: 0, signal: null, stdout: '', stderr: '', duration_ms: 1, stop_reason: null };

test('config rejects insecure origins, duplicate scopes and every unconfined provider', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path']) assert.throws(() => serviceUrl(url));
  const duplicate = input(); duplicate.projects.push(duplicate.projects[0]!);
  assert.throws(() => parseBridgeConfig(duplicate));
  assert.equal(serviceUrl('https://example.com/'), 'https://example.com');
  for (const provider of ['claude', 'codex', 'antigravity']) assert.throws(() => parseBridgeConfig({ ...input(), agents: [{ id: 'claude', provider, binary: '/bin/true', sandbox: false }] }), /sandbox:true/u);
});

test('project capacity and explicit patch opt-ins are preserved', () => {
  const config = input();
  config.projects = Array.from({ length: 512 }, (_, i) => ({ ...config.projects[0]!, scope: `project:p${i}` }));
  assert.equal(parseBridgeConfig(config).projects.length, 512);
  config.projects.push({ ...config.projects[0]!, scope: 'project:overflow' });
  assert.throws(() => parseBridgeConfig(config), /1–512/u);
  const parsed = parseBridgeConfig(input());
  assert.deepEqual(projectCapabilities(parsed.projects[0]!, parsed.agents), ['claude.read', 'auto.read']);
  assert.throws(() => buildInvocation(parsed.agents[0]!, parsed.projects[0]!, { ...task, kind: 'patch', required_capability: 'claude.patch' }, {}, parsed, new AbortController().signal), /not enabled/u);
  const enabled = input(); enabled.agents[0]!.enable_patch = true; enabled.projects[0]!.allow_patch = true;
  const patch = parseBridgeConfig(enabled);
  assert.deepEqual(projectCapabilities(patch.projects[0]!, patch.agents), ['claude.read', 'claude.patch', 'auto.read', 'auto.patch']);
  assert.throws(() => buildInvocation(patch.agents[0]!, patch.projects[0]!, { ...task, kind: 'patch', required_capability: 'claude.patch' }, {}, patch, new AbortController().signal), /isolated worktree/u);
  assert.throws(() => buildInvocation({ ...parsed.agents[0]!, sandbox: false }, parsed.projects[0]!, task, {}, parsed, new AbortController().signal), /unconfined/u);
});

test('environment passes only runtime values and the selected provider credentials', () => {
  const parent = { HOME: '/home/worker', PATH: '.:/usr/bin::relative:/bin', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', GEMINI_API_KEY: 'gemini', COLLECTIVE_WORKER_TOKEN: 'worker', SWARMAA_TOKEN: 'service', DATABASE_URL: 'db-secret', GITHUB_TOKEN: 'github', MY_MCP_KEY: 'mcp', NODE_OPTIONS: '--require /tmp/evil.js', BASH_ENV: '/tmp/evil', ANTHROPIC_BASE_URL: 'https://wrong.example', HTTP_PROXY: 'http://user:secret@proxy' };
  const claude = providerEnvironment('claude', parent, 'COLLECTIVE_WORKER_TOKEN');
  assert.equal(claude.ANTHROPIC_API_KEY, 'anthropic');
  assert.equal(claude.PATH, '/usr/bin:/bin');
  for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'COLLECTIVE_WORKER_TOKEN', 'SWARMAA_TOKEN', 'DATABASE_URL', 'GITHUB_TOKEN', 'MY_MCP_KEY', 'NODE_OPTIONS', 'BASH_ENV', 'ANTHROPIC_BASE_URL', 'HTTP_PROXY']) assert.equal(claude[key], undefined, key);
  const codex = providerEnvironment('codex', parent, 'COLLECTIVE_WORKER_TOKEN');
  assert.equal(codex.OPENAI_API_KEY, 'openai'); assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  assert.equal(providerEnvironment('claude', parent, 'ANTHROPIC_API_KEY').ANTHROPIC_API_KEY, undefined);
});

function withInvocation(provider: Provider, patch: boolean, check: (request: ProcessRequest, args: string[]) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-argv-')));
  const home = join(base, 'home'), root = join(base, 'project'), dir = join(base, 'worktree'), gitDir = join(root, '.git');
  for (const path of [home, root, dir, gitDir]) mkdirSync(path, { recursive: true });
  const config = parseBridgeConfig({ service_url: 'http://localhost:8787', agents: [{ id: provider, provider, binary: '/usr/bin/true', enable_patch: patch }], projects: [{ scope: task.scope, root, agents: [provider], allow_patch: patch }] });
  const t: Task = { ...task, kind: patch ? 'patch' : 'review', required_capability: `${provider}.${patch ? 'patch' : 'read'}` };
  const native = prepareNative(config.agents[0]!, t, patch ? dir : undefined, home, base);
  let request: ProcessRequest | undefined;
  try {
    request = buildInvocation(config.agents[0]!, config.projects[0]!, t, {}, config, new AbortController().signal, { HOME: home, PATH: '/usr/bin:/bin', COLLECTIVE_WORKER_TOKEN: 'secret' }, patch ? { dir, gitDir } : undefined, native);
    assert.equal(request.command, '/usr/bin/sandbox-exec');
    assert.match(request.args[1]!, /\(deny default\)/u);
    assert.ok(request.env.TMPDIR && request.env.TMPDIR !== tmpdir());
    assert.equal(statSync(request.env.TMPDIR!).mode & 0o777, 0o700);
    assert.equal(request.env.COLLECTIVE_WORKER_TOKEN, undefined);
    check(request, request.args.slice(3));
    const scratch = request.env.TMPDIR!;
    cleanupInvocation(request); cleanupInvocation(request);
    assert.equal(existsSync(scratch), false);
  } finally { if (native) cleanupNative(native); if (request) cleanupInvocation(request); rmSync(base, { recursive: true, force: true }); }
}

test('Claude denies unapproved tools and inherited MCP; read tasks do not persist interactive sessions', () => {
  withInvocation('claude', false, (request, args) => {
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
    assert.ok(!args.includes('bypassPermissions'));
    assert.ok(!args[args.indexOf('--tools') + 1]!.split(',').includes('Write'));
    assert.ok(request.input.includes('$(touch /tmp/injected)'));
    assert.ok(!args.some(a => a.includes('$(touch')));
  });
  withInvocation('claude', true, (_request, args) => {
    assert.ok(args[args.indexOf('--tools') + 1]!.split(',').includes('Write'));
    assert.ok(!args.includes('--no-session-persistence'));
  });
});

test('Codex and Antigravity bypass flags exist only inside required outer confinement', () => {
  withInvocation('codex', false, (request, args) => {
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(request.env.CODEX_HOME && request.env.CODEX_HOME !== join(request.env.HOME!, '.codex'));
    assert.equal(args.at(-1), '-');
  });
  withInvocation('antigravity', true, (request, args) => {
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.equal(args.filter(arg => arg.startsWith('-p=')).length, 1);
    assert.equal(request.input, '');
  });
});

test('provider success requires terminal evidence and no reported permission blocker', () => {
  assert.equal(providerSucceeded('claude', result), false);
  assert.equal(providerSucceeded('claude', { ...result, stdout: '{"type":"result","subtype":"success"}' }), true);
  assert.equal(providerSucceeded('claude', { ...result, stdout: '{"type":"result","subtype":"success","permission_denials":[{"tool_name":"Write"}]}' }), false);
  assert.deepEqual(deniedActions('claude', '{"permission_denials":[{"tool_name":"Write"}]}'), ['Write']);
  assert.equal(providerSucceeded('codex', { ...result, stdout: '{"type":"error","message":"reconnecting"}\n{"type":"turn.completed"}\n' }), true);
  assert.equal(providerSucceeded('codex', { ...result, stdout: '{"type":"turn.completed"}\n{"type":"turn.failed"}\n' }), false);
  assert.equal(providerSucceeded('antigravity', { ...result, stdout: '{"status":"SUCCESS","response":""}' }), false);
  assert.deepEqual(deniedActions('antigravity', '{"denied_actions":[{"display_name":"RunCommand"}]}'), ['RunCommand']);
});

test('final answers remain provider output rather than command arguments', () => {
  assert.equal(finalAnswer('codex', '{"item":{"type":"agent_message","text":"first"}}\n{"item":{"type":"agent_message","text":"last"}}\n{partial'), 'last');
  assert.equal(finalAnswer('claude', '{"result":"done"}'), 'done');
  assert.equal(finalAnswer('antigravity', '{"response":"done"}'), 'done');
  assert.equal(finalAnswer('claude', 'not json'), '');
});

test('token files remain absolute, owner-only and separate from invocation environment', async () => {
  assert.throws(() => parseBridgeConfig({ ...input(), token_file: 'relative.json' }));
  const dir = await mkdtemp(join(tmpdir(), 'swarma-token-'));
  try {
    const file = join(dir, 'worker.json');
    await writeFile(file, JSON.stringify({ token: 'cn_test' }), { mode: 0o644 });
    await assert.rejects(readTokenFile(file), /chmod 600/u);
    await chmod(file, 0o600);
    assert.equal(await readTokenFile(file), 'cn_test');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
