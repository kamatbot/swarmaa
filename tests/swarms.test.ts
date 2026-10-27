import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStepGraph, deriveSwarmStatus } from '../src/core/swarms.js';

test('step-graph validation: accepts linear chain and diamond DAG', () => {
  // Linear chain: 1 -> 2 -> 3
  assert.doesNotThrow(() => {
    validateStepGraph([
      { key: 'step1', needs: [] },
      { key: 'step2', needs: ['step1'] },
      { key: 'step3', needs: ['step2'] }
    ]);
  });

  // Diamond DAG: 1 -> (2, 3) -> 4
  assert.doesNotThrow(() => {
    validateStepGraph([
      { key: 'step1', needs: [] },
      { key: 'step2', needs: ['step1'] },
      { key: 'step3', needs: ['step1'] },
      { key: 'step4', needs: ['step2', 'step3'] }
    ]);
  });
});

test('step-graph validation: rejects cycles', () => {
  // Direct cycle: 1 -> 2 -> 1
  assert.throws(
    () => {
      validateStepGraph([
        { key: 'step1', needs: ['step2'] },
        { key: 'step2', needs: ['step1'] }
      ]);
    },
    /cycle/i
  );

  // Self cycle
  assert.throws(
    () => {
      validateStepGraph([
        { key: 'step1', needs: ['step1'] }
      ]);
    },
    /itself/i
  );

  // 3-node cycle: 1 -> 2 -> 3 -> 1
  assert.throws(
    () => {
      validateStepGraph([
        { key: 'a', needs: ['c'] },
        { key: 'b', needs: ['a'] },
        { key: 'c', needs: ['b'] }
      ]);
    },
    /cycle/i
  );
});

test('step-graph validation: rejects duplicate keys or unknown dependencies', () => {
  assert.throws(
    () => {
      validateStepGraph([
        { key: 'step1', needs: [] },
        { key: 'step1', needs: [] }
      ]);
    },
    /Duplicate step key/i
  );

  assert.throws(
    () => {
      validateStepGraph([
        { key: 'step1', needs: ['unknown_step'] }
      ]);
    },
    /unknown step/i
  );
});

test('swarm status derivation: prioritizes statuses by urgency', () => {
  // Closed / cancelled
  assert.equal(deriveSwarmStatus([], false, true), 'cancelled');
  assert.equal(deriveSwarmStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled');

  // waiting_on_you is highest urgency
  assert.equal(
    deriveSwarmStatus([
      { status: 'done' },
      { status: 'running' },
      { status: 'waiting_on_you' },
      { status: 'blocked' }
    ]),
    'waiting_on_you'
  );

  // blocked / failed is next
  assert.equal(
    deriveSwarmStatus([
      { status: 'done' },
      { status: 'running' },
      { status: 'blocked' }
    ]),
    'blocked'
  );

  assert.equal(
    deriveSwarmStatus([
      { status: 'done' },
      { status: 'failed' }
    ]),
    'blocked'
  );

  // running / pending
  assert.equal(
    deriveSwarmStatus([
      { status: 'done' },
      { status: 'running' },
      { status: 'pending' }
    ]),
    'running'
  );

  assert.equal(
    deriveSwarmStatus([
      { status: 'pending' }
    ]),
    'running'
  );

  // All done
  assert.equal(
    deriveSwarmStatus([
      { status: 'done' },
      { status: 'done' }
    ]),
    'done'
  );

  // Explicitly closed
  assert.equal(
    deriveSwarmStatus([], true),
    'done'
  );

  // Empty steps without closed
  assert.equal(
    deriveSwarmStatus([]),
    'planning'
  );
});
