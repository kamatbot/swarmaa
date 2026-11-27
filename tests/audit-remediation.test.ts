import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import {
  clearInboxDirtyFlag,
  INBOX_FLAG_QUIET_MS,
  initInboxDirtyDir,
  touchInboxDirtyFlag,
} from '../src/core/inbox.js';
import {
  codingCliToolNames,
  TOOL_PERMISSIONS,
  TOOLS,
} from '../src/core/tools.js';
import { waitForInbox } from '../src/inbox-wait.js';
import { GRANTABLE_PERMISSIONS, requireScope, ROLE_PERMISSIONS } from '../src/policy.js';
import { RelayAgent } from '../src/relay-agent.js';
import type { Principal } from '../src/types.js';

const baseFrontend: Principal = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-audit',
  name: 'claude',
  role: 'frontend',
  scopes: ['project:demo'],
  permissions: [...ROLE_PERMISSIONS.frontend],
};

const adminPrincipal: Principal = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: 'tenant-audit',
  name: 'owner',
  role: 'admin',
  scopes: ['*'],
  permissions: [...ROLE_PERMISSIONS.admin],
};

test('frontend default profile trims MCP tool exposure and matches codingCliToolNames()', () => {
  assert.ok(GRANTABLE_PERMISSIONS.includes('app:device'));
  for (const removed of ['agent:manage', 'agent:read', 'thread:read', 'thread:write'] as const) {
    assert.equal(ROLE_PERMISSIONS.frontend.includes(removed), false, `frontend must not include ${removed}`);
  }
  const core = new CoreService({} as Pool);
  const visible = core.listTools(baseFrontend).map(t => t.name).sort();
  const expected = [...codingCliToolNames()].sort();
  assert.deepEqual(visible, expected);
  assert.ok(visible.length < TOOLS.length / 2, `coding-CLI tool count (${visible.length}) must be under half of total tools (${TOOLS.length})`);
  for (const hidden of ['agent_create', 'bot_create', 'thread_read', 'push_register', 'voice_intent', 'watch_memo_put', 'section_set', 'local_action_run', 'attention_list', 'question_list']) {
    assert.equal(visible.includes(hidden), false, `${hidden} must not be exposed to default frontend`);
  }
});

test('personal/device/app tools require app:device permission and remain accessible to admin', () => {
  const deviceTools = [
    'push_register', 'push_unregister',
    'watch_memo_put', 'watch_memo_status', 'watch_memo_delete',
    'watch_transaction_preview', 'watch_transaction_confirm', 'watch_transaction_get',
    'voice_intent', 'voice_warm',
    'local_action_check', 'local_action_run', 'local_action_undo',
    'local_action_report', 'local_action_pending', 'local_action_list',
    'section_set', 'section_list',
  ];
  for (const name of deviceTools) {
    assert.equal(TOOL_PERMISSIONS[name], 'app:device', `${name} must be gated on app:device`);
  }
  const core = new CoreService({} as Pool);
  const adminNames = new Set(core.listTools(adminPrincipal).map(t => t.name));
  for (const name of deviceTools) {
    assert.equal(adminNames.has(name), true, `admin must still see ${name}`);
  }
  const withDevice = new Set(core.listTools({ ...baseFrontend, permissions: ['app:device', 'thread:read'] }).map(t => t.name));
  for (const name of deviceTools) {
    assert.equal(withDevice.has(name), true, `principal with app:device + thread:read must see ${name}`);
  }
});

test('tool schemas and annotations: question_answer, starred on bot_create/update, destructiveHint, scope_forbidden hint', () => {
  assert.equal(TOOL_PERMISSIONS.question_answer, 'answer_questions');

  for (const toolName of ['bot_create', 'bot_update']) {
    const def = TOOLS.find(t => t.name === toolName);
    assert.ok(def, `${toolName} exists`);
    const props = (def.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(props.starred, { type: 'boolean' });
  }

  for (const name of [
    'swarm_cancel', 'flow_cancel', 'watch_memo_delete', 'message_dismiss',
    'agent_archive', 'bot_archive', 'local_action_run', 'local_action_undo',
  ]) {
    const def = TOOLS.find(t => t.name === name);
    assert.ok(def, `${name} exists`);
    assert.equal(def.annotations?.destructiveHint, true, `${name} must have destructiveHint: true`);
  }

  assert.throws(
    () => requireScope(baseFrontend, 'project:other'),
    (err: any) => err.code === 'scope_forbidden' && /swarm_status/.test(err.message),
  );
});

test('non-admin cannot set rules.dispatch_all_projects or rules.local_actions on bot_create', async () => {
  let sqlCalls = 0;
  const pool = {
    query: async () => { sqlCalls++; return { rows: [] }; },
    connect: async () => ({ query: async () => { sqlCalls++; return { rows: [] }; }, release() {} }),
  } as unknown as Pool;
  const core = new CoreService(pool);
  const manager: Principal = {
    ...baseFrontend,
    permissions: [...ROLE_PERMISSIONS.frontend, 'agent:manage', 'agent:read', 'thread:read', 'thread:write'],
  };
  for (const rules of [{ dispatch_all_projects: true }, { local_actions: true }, { dispatch_all_projects: false }]) {
    await assert.rejects(
      core.call(manager, 'bot_create', {
        name: 'Sneaky',
        job: 'Help',
        scope: 'project:demo',
        lead_agent_id: '33333333-3333-4333-8333-333333333333',
        member_agent_ids: [],
        rules,
      }),
      { code: 'owner_required', status: 403 },
    );
  }
  assert.equal(sqlCalls, 0);
});

test('inbox dirty flag lifecycle creates .active, touches/clears flag, and tolerates unwritable paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-inbox-dirty-'));
  const prev = process.env.SWARMAA_INBOX_DIRTY_DIR;
  try {
    const dirtyDir = join(dir, 'dirty');
    process.env.SWARMAA_INBOX_DIRTY_DIR = dirtyDir;
    initInboxDirtyDir();
    assert.equal(existsSync(join(dirtyDir, '.active')), true);
    assert.equal(statSync(dirtyDir).mode & 0o777, 0o700);

    const pid = '11111111-1111-4111-8111-111111111111';
    touchInboxDirtyFlag(pid);
    assert.equal(existsSync(join(dirtyDir, `${pid}.flag`)), true);

    // A flag touched recently may belong to a write that has not committed yet: it stays.
    clearInboxDirtyFlag(pid);
    assert.equal(existsSync(join(dirtyDir, `${pid}.flag`)), true, 'recently touched flag is kept');
    clearInboxDirtyFlag(pid, dirtyDir, Date.now() + INBOX_FLAG_QUIET_MS + 1000);
    assert.equal(existsSync(join(dirtyDir, `${pid}.flag`)), false, 'quiet flag is cleared');
    // Clearing again when absent is a no-op
    clearInboxDirtyFlag(pid);

    // Invalid / unwritable path must never throw
    process.env.SWARMAA_INBOX_DIRTY_DIR = join(dirtyDir, '.active', 'impossible');
    assert.doesNotThrow(() => {
      initInboxDirtyDir();
      touchInboxDirtyFlag(pid);
      clearInboxDirtyFlag(pid);
    });
  } finally {
    if (prev === undefined) delete process.env.SWARMAA_INBOX_DIRTY_DIR;
    else process.env.SWARMAA_INBOX_DIRTY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForInbox uses standalone pg.Client (never pool.connect) and evicts hub immediately on error', { timeout: 2000 }, async () => {
  const clients: FakeClient[] = [];
  class FakeClient extends EventEmitter {
    ended = false;
    constructor() { super(); clients.push(this); }
    async connect() {}
    async query(sql: string) { assert.equal(sql, 'LISTEN swarmaa_inbox'); }
    async end() { this.ended = true; this.emit('end'); }
  }
  const clientMock = mock.method(pg, 'Client', function () { return new FakeClient(); } as any);
  try {
    const pool = {
      options: {},
      connect() { throw new Error('waitForInbox must not borrow from pool.connect()'); },
    } as unknown as Pool;
    let pollCalls = 0;
    const core = {
      listTools: () => [],
      call: async () => ({ items: pollCalls++ === 2 ? [{ id: 'm1' }] : [] }),
    };

    const ac1 = new AbortController();
    const p1 = waitForInbox(pool, core, baseFrontend, 'claude:sess-1', 2, ac1.signal, async () => baseFrontend);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(clients.length, 1);

    // Triggering error on the LISTEN client must reject with 503 inbox_unavailable and evict the broken hub
    clients[0]!.emit('error', new Error('pg lost'));
    await assert.rejects(p1, { code: 'inbox_unavailable', status: 503 });

    // A subsequent waitForInbox must create a fresh standalone pg.Client (not reuse dead hub)
    const ac2 = new AbortController();
    const p2 = waitForInbox(pool, core, baseFrontend, 'claude:sess-1', 2, ac2.signal, async () => baseFrontend);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(clients.length, 2);
    clients[1]!.emit('notification', { channel: 'swarmaa_inbox', payload: baseFrontend.id });
    const res2 = await p2 as { items: unknown[] };
    assert.equal(res2.items.length, 1);
  } finally {
    clientMock.mock.restore();
  }
});

test('RelayAgent ignores close events from a stale replaced WebSocket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-relay-stale-'));
  const origWs = globalThis.WebSocket;
  const sockets: FakeWs[] = [];
  class FakeWs extends EventTarget {
    readyState = 1;
    send() {}
    close() { this.readyState = 3; }
    constructor(_url: string) { super(); sockets.push(this); }
  }
  try {
    (globalThis as any).WebSocket = FakeWs;
    const agent = new RelayAgent({
      relayUrl: 'ws://127.0.0.1:1',
      publicUrl: 'https://public.example',
      host: '127.0.0.1',
      port: 1,
      directory: dir,
      provision: async () => 'tok',
      reconnectMinMs: 60_000,
    });
    agent.start();
    assert.equal(sockets.length, 1);
    const oldSocket = sockets[0]!;
    // Trigger a second connect() replacing the active socket before oldSocket fires close
    (agent as any).connect();
    assert.equal(sockets.length, 2);
    const activeSocket = sockets[1]!;
    assert.equal((agent as any).socket, activeSocket);

    oldSocket.dispatchEvent(new Event('close'));
    assert.equal((agent as any).socket, activeSocket, 'stale socket close must not clobber active socket');
    agent.stop();
  } finally {
    globalThis.WebSocket = origWs;
    rmSync(dir, { recursive: true, force: true });
  }
});
