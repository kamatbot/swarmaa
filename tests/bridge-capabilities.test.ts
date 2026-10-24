import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCapabilities } from '../src/bridge/capabilities.js';
import type { Provider } from '../src/bridge/types.js';

test('headless adapters advertise only observable behavior and supported continuation', () => {
  for (const provider of ['claude', 'codex', 'antigravity'] as Provider[]) {
    const capabilities = runtimeCapabilities({ id: provider, provider, binary: '/bin/true', sandbox: true, enable_patch: false });
    assert.deepEqual(capabilities.delivery.modes, ['next-run']);
    assert.equal(capabilities.delivery.live_injection, false);
    assert.equal(capabilities.observability.tool_activity, 'unavailable');
    assert.equal(capabilities.observability.provider_terminal, 'provider-reported');
    assert.equal(capabilities.observability.process_exit, 'observed-or-unavailable');
    assert.equal(capabilities.execution.termination_scope, 'process-group');
    assert.equal(capabilities.provenance.cli_version, 'unverified');
    assert.equal(capabilities.acceptance_criteria_verified, false);
    assert.equal(capabilities.execution.patch, false);
    assert.equal(capabilities.lifecycle.native_resume, provider === 'antigravity' ? 'unavailable' : 'artifact-only');
  }
});
