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
    [stopA, stopB] = await Promise.all([hub.subscribe(() => a++, 'tenant-a'), hub.subscribe(() => b++, 'tenant-a')]);
    assert.equal(clients.length, 1);
    a = b = 0;
    clients[0]!.emit('notification', { channel: 'unrelated' });
    assert.equal(a + b, 0);
    clients[0]!.emit('notification', { channel: 'swarmaa_events', payload: 'tenant-a' });
    assert.equal(a, 1); assert.equal(b, 1);
    const reconnected = new Promise<void>(r => { onListen = r; });
    clients[0]!.emit('error', new Error('connection lost'));
    await reconnected;
    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.ended, true);
    stopA();
    assert.equal(clients[1]!.ended, false);
    const before = b;
    clients[1]!.emit('notification', { channel: 'swarmaa_events', payload: 'tenant-a' });
    assert.equal(b, before + 1);
    stopB();
    assert.equal(clients[1]!.ended, true);
  } finally { stopA?.(); stopB?.(); replacement.mock.restore(); }
});


test('unsubscribe during reconnect then subscribe establishes a fresh live listener', { timeout: 2000 }, async () => {
  const clients: FakeClient[] = [];
  let rejectConnect!: (error: Error) => void;
  const connecting = new Promise<void>((_, reject) => { rejectConnect = reject; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  class FakeClient extends EventEmitter {
    ended = false;
    listening = false;
    constructor() { super(); clients.push(this); }
    async connect() {
      if (clients.indexOf(this) === 1) { markStarted(); await connecting; }
    }
    async query() { assert.equal(this.ended, false); this.listening = true; }
    async end() { this.ended = true; this.emit('end'); }
  }
  const replacement = mock.method(pg, 'Client', function () { return new FakeClient(); } as any);
  let stop: (() => void) | undefined;
  try {
    const hub = eventWakeup({ options: {} } as Pool);
    stop = await hub.subscribe(() => {}, 'tenant-a');
    clients[0]!.emit('error', new Error('connection lost'));
    await started;
    stop();
    let wakes = 0;
    const subscribed = hub.subscribe(() => wakes++, 'tenant-a');
    rejectConnect(new Error('closed during connect'));
    stop = await subscribed;
    // Allow the normal 100 ms retry too; a stale promise must not strand subscribers.
    await new Promise(r => setTimeout(r, 150));
    const live = clients.filter(c => c.listening && !c.ended);
    assert.equal(live.length, 1);
    wakes = 0;
    live[0]!.emit('notification', { channel: 'swarmaa_events', payload: 'tenant-a' });
    assert.equal(wakes, 1);
  } finally { stop?.(); replacement.mock.restore(); }
});
