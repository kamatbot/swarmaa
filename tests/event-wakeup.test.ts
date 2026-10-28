import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, mock } from 'node:test';
import pg, { type Pool } from 'pg';
import { eventWakeup } from '../src/event-wakeup.js';

test('event wake-up shares one client, reconnects after loss, and closes on last unsubscribe', { timeout: 2000 }, async () => {
  const clients: FakeClient[] = [];
  let onListen: (() => void) | undefined;
  class FakeClient extends EventEmitter {
    ended = false;
    constructor() { super(); clients.push(this); }
    async connect() {}
    async query(sql: string) { assert.equal(sql, 'LISTEN swarmaa_events'); onListen?.(); }
    async end() { this.ended = true; this.emit('end'); }
  }
  const replacement = mock.method(pg, 'Client', function () { return new FakeClient(); } as any);
  let stopA: (() => void) | undefined, stopB: (() => void) | undefined;
  try {
    const pool = { options: {} } as Pool;
    const hub = eventWakeup(pool);
    assert.equal(eventWakeup(pool), hub);
    let a = 0, b = 0;
    [stopA, stopB] = await Promise.all([hub.subscribe(() => a++), hub.subscribe(() => b++)]);
    assert.equal(clients.length, 1);
    a = b = 0;
    clients[0]!.emit('notification', { channel: 'unrelated' });
    assert.equal(a + b, 0);
    clients[0]!.emit('notification', { channel: 'swarmaa_events' });
    assert.equal(a, 1); assert.equal(b, 1);
    const reconnected = new Promise<void>(r => { onListen = r; });
    clients[0]!.emit('error', new Error('connection lost'));
    await reconnected;
    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.ended, true);
    stopA();
    assert.equal(clients[1]!.ended, false);
    const before = b;
    clients[1]!.emit('notification', { channel: 'swarmaa_events' });
    assert.equal(b, before + 1);
    stopB();
    assert.equal(clients[1]!.ended, true);
  } finally { stopA?.(); stopB?.(); replacement.mock.restore(); }
});
