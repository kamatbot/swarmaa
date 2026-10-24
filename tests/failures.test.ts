import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, extractServed } from '../src/bridge/adapters.js';
import type { ProcessResult } from '../src/bridge/types.js';
import { sameModel } from '../src/core/failures.js';

function proc(stdout: string, stderr = '', exit_code: number | null = 1, stop_reason: ProcessResult['stop_reason'] = null): ProcessResult {
  return { stdout, stderr, exit_code, stop_reason, duration_ms: 100, signal: null };
}

test('samemodel: the providers alias of the same model is the same model', () => {
  const cases: [string, string][] = [
    ['claude-fable-5', 'anthropic/claude-fable-5'],
    ['gpt-5.6-sol', 'openai/gpt-5.6-sol'],
    ['mistral-medium-3.5', 'mistralai/mistral-medium-3-5'],
    ['qwen3.8-max', 'qwen/qwen3.8-max-0902'],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    ['gemini-3.5-flash', 'gemini-3.5-flash-001'],
    ['deepseek-v4.1-flash', 'deepseek-flash'],
  ];
  for (const [asked, served] of cases) {
    assert.equal(sameModel(asked, served), true, `Expected sameModel('${asked}', '${served}') to be true`);
  }
});

test('samemodel: another family, number or tier is a finding (not same model)', () => {
  const cases: [string, string][] = [
    ['gemini-3.8-flash', 'google/gemini-3-flash-preview'],
    ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    ['claude-sonnet-5', 'claude-opus-5'],
    ['gemini-3.8-flash', ''],
    ['deepseek-v4-flash', 'deepseek-flash'],
    ['', 'claude-3'],
  ];
  for (const [asked, served] of cases) {
    assert.equal(sameModel(asked, served), false, `Expected sameModel('${asked}', '${served}') to be false`);
  }
});

// ---- Claude classification ----

test('classifyFailure: claude quota_exhausted', () => {
  const res = proc(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'You have exceeded your monthly credit limit. Please upgrade your plan.' }));
  const f = classifyFailure('claude', res);
  assert.equal(f?.code, 'quota_exhausted');
  assert.equal(f?.retry, false);
});

test('classifyFailure: claude rate_limited with retry-after', () => {
  const res = proc(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 429, result: 'Rate limit exceeded. Please try again in 45s.' }));
  const f = classifyFailure('claude', res);
  assert.equal(f?.code, 'rate_limited');
  assert.equal(f?.retry, true);
  assert.equal(f?.retry_after_ms, 45000);
});

test('classifyFailure: claude auth_required', () => {
  const res = proc(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 401, result: 'Please run claude login to sign in to Claude Code.' }));
  const f = classifyFailure('claude', res);
  assert.equal(f?.code, 'auth_required');
  assert.equal(f?.retry, false);
  assert.equal(f?.detail, 'sign in to Claude Code');
});

test('classifyFailure: claude provider_error (529 overloaded)', () => {
  const res = proc(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 529, result: 'Anthropic API is currently overloaded.' }));
  const f = classifyFailure('claude', res);
  assert.equal(f?.code, 'provider_error');
  assert.equal(f?.retry, true);
});

test('classifyFailure: claude harness_error on unparsed output', () => {
  const res = proc('SyntaxError: Unexpected token < in JSON at position 0', '', 1);
  const f = classifyFailure('claude', res);
  assert.equal(f?.code, 'harness_error');
  assert.equal(f?.retry, false);
});

// ---- Codex classification ----

test('classifyFailure: codex quota_exhausted from turn.failed event', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a16741-8259-75a0-87d3-6699dbd30d5e"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"You have exceeded your current quota, please check your plan and billing details."}}'
  ].join('\n');
  const f = classifyFailure('codex', proc(stdout));
  assert.equal(f?.code, 'quota_exhausted');
  assert.equal(f?.retry, false);
});

test('classifyFailure: codex rate_limited with retry-after', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a16741-8259-75a0-87d3-6699dbd30d5e"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"Rate limit reached for requests. Retry-after: 30 seconds."}}'
  ].join('\n');
  const f = classifyFailure('codex', proc(stdout));
  assert.equal(f?.code, 'rate_limited');
  assert.equal(f?.retry, true);
  assert.equal(f?.retry_after_ms, 30000);
});

test('classifyFailure: codex auth_required', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a16741-8259-75a0-87d3-6699dbd30d5e"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"Authentication failed: Invalid API key or expired token. Please sign in."}}'
  ].join('\n');
  const f = classifyFailure('codex', proc(stdout));
  assert.equal(f?.code, 'auth_required');
  assert.equal(f?.retry, false);
  assert.equal(f?.detail, 'sign in to Codex');
});

test('classifyFailure: codex provider_error (stream disconnected / server error)', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a16741-8259-75a0-87d3-6699dbd30d5e"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"stream disconnected before completion: 503 Service Unavailable"}}'
  ].join('\n');
  const f = classifyFailure('codex', proc(stdout));
  assert.equal(f?.code, 'provider_error');
  assert.equal(f?.retry, true);
});

test('classifyFailure: codex harness_error on CLI usage error (real sample from live DB)', () => {
  const stderr = `error: unexpected argument '--search' found\n  tip: to pass '--search' as a value, use '-- --search'\nUsage: codex exec [OPTIONS] [PROMPT]`;
  const f = classifyFailure('codex', proc('', stderr, 2));
  assert.equal(f?.code, 'harness_error');
  assert.equal(f?.retry, false);
});

// ---- Antigravity classification ----

test('classifyFailure: antigravity quota_exhausted', () => {
  const stdout = JSON.stringify({ status: 'ERROR', response: '', error: 'Resource has been exhausted (e.g. check quota): user quota limit reached.' });
  const f = classifyFailure('antigravity', proc(stdout));
  assert.equal(f?.code, 'quota_exhausted');
  assert.equal(f?.retry, false);
});

test('classifyFailure: antigravity rate_limited', () => {
  const stdout = JSON.stringify({ status: 'ERROR', response: '', error: 'RATE_LIMIT_EXCEEDED: Rate limit exceeded. Try again in 20 seconds.' });
  const f = classifyFailure('antigravity', proc(stdout));
  assert.equal(f?.code, 'rate_limited');
  assert.equal(f?.retry, true);
  assert.equal(f?.retry_after_ms, 20000);
});

test('classifyFailure: antigravity auth_required', () => {
  const stdout = JSON.stringify({ status: 'ERROR', response: '', error: 'UNAUTHENTICATED: Authentication failed. Please sign in to Antigravity.' });
  const f = classifyFailure('antigravity', proc(stdout));
  assert.equal(f?.code, 'auth_required');
  assert.equal(f?.retry, false);
  assert.equal(f?.detail, 'sign in to Antigravity');
});

test('classifyFailure: antigravity provider_error', () => {
  const stdout = JSON.stringify({ status: 'ERROR', response: '', error: 'UNAVAILABLE: Upstream server returned 503' });
  const f = classifyFailure('antigravity', proc(stdout));
  assert.equal(f?.code, 'provider_error');
  assert.equal(f?.retry, true);
});

test('classifyFailure: antigravity sandbox_denied', () => {
  const stdout = JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ display_name: 'ShellCommand', action: 'exec' }] });
  const f = classifyFailure('antigravity', proc(stdout, '', 0));
  assert.equal(f?.code, 'sandbox_denied');
  assert.equal(f?.retry, false);
  assert.match(f?.detail ?? '', /ShellCommand/);
});

test('classifyFailure: common timeout and cancelled', () => {
  const timeoutProc = proc('', '', null, 'timeout');
  assert.equal(classifyFailure('codex', timeoutProc)?.code, 'timeout');
  assert.equal(classifyFailure('claude', timeoutProc)?.code, 'timeout');

  const cancelledProc = proc('', '', null, 'aborted');
  assert.equal(classifyFailure('antigravity', cancelledProc)?.code, 'cancelled');
});

// ---- extractServed tests ----

test('extractServed: claude extracts model from modelUsage and detects substitution', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    modelUsage: {
      'claude-sonnet-5-5': { inputTokens: 10 }
    }
  });
  const servedSame = extractServed('claude', proc(stdout, '', 0), 'claude-sonnet-5-5-20261001');
  assert.equal(servedSame.provider, 'claude');
  assert.equal(servedSame.model, 'claude-sonnet-5-5');
  assert.equal(servedSame.substituted, undefined);

  const servedSub = extractServed('claude', proc(stdout, '', 0), 'claude-opus-5');
  assert.equal(servedSub.provider, 'claude');
  assert.equal(servedSub.model, 'claude-sonnet-5-5');
  assert.equal(servedSub.substituted, true);
});

test('extractServed: codex extracts model from events', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"123"}',
    '{"type":"turn.started","model":"gpt-5.6-sol"}',
    '{"type":"turn.completed"}'
  ].join('\n');
  const served = extractServed('codex', proc(stdout, '', 0), 'openai/gpt-5.6-sol');
  assert.equal(served.provider, 'codex');
  assert.equal(served.model, 'gpt-5.6-sol');
  assert.equal(served.substituted, undefined);
});

test('extractServed: antigravity extracts model or returns null when absent', () => {
  const stdoutNoModel = JSON.stringify({ status: 'SUCCESS', response: 'done' });
  const servedNone = extractServed('antigravity', proc(stdoutNoModel, '', 0));
  assert.equal(servedNone.provider, 'antigravity');
  assert.equal(servedNone.model, null);

  const stdoutModel = JSON.stringify({ status: 'SUCCESS', response: 'done', model: 'gemini-3.5-flash-001' });
  const servedSub = extractServed('antigravity', proc(stdoutModel, '', 0), 'gemini-3.8-flash');
  assert.equal(servedSub.model, 'gemini-3.5-flash-001');
  assert.equal(servedSub.substituted, true);
});
