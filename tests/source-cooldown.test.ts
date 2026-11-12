import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRecoveryDelivery, RECOVERY_RE, processOneDelivery, SourceService } from '../src/core/sources.js';
import type { Principal } from '../src/types.js';

const encKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const owner: Principal = {
  id: '00000000-0000-0000-0000-000000000001',
  tenantId: 'tenant-1',
  name: 'owner',
  role: 'admin',
  scopes: ['project:demo'],
  permissions: ['routing:manage', 'task:read', 'task:submit']
};

describe('source cooldown unit tests', () => {
  describe('validation of cooldown_seconds', () => {
    it('out-of-range values are rejected on create', async () => {
      const mockPool: any = {
        query: async () => ({ rows: [], rowCount: 0 }),
      };
      const service = new SourceService(mockPool);

      // Negative value
      await assert.rejects(
        async () => await service.createSource(owner, {
          scope: 'project:demo',
          repo_full_name: 'owner/repo',
          cooldown_seconds: -1,
        }, encKey),
        { code: 'invalid_arguments' }
      );

      // Value exceeding 86400 (1 day)
      await assert.rejects(
        async () => await service.createSource(owner, {
          scope: 'project:demo',
          repo_full_name: 'owner/repo',
          cooldown_seconds: 86401,
        }, encKey),
        { code: 'invalid_arguments' }
      );

      // Non-integer float
      await assert.rejects(
        async () => await service.createSource(owner, {
          scope: 'project:demo',
          repo_full_name: 'owner/repo',
          cooldown_seconds: 12.5,
        }, encKey),
        { code: 'invalid_arguments' }
      );

      // String value
      await assert.rejects(
        async () => await service.createSource(owner, {
          scope: 'project:demo',
          repo_full_name: 'owner/repo',
          cooldown_seconds: '60',
        }, encKey),
        { code: 'invalid_arguments' }
      );
    });

    it('valid cooldown_seconds values are accepted on create (0, 60, 86400)', async () => {
      let insertedCooldown: number | undefined;
      const mockPool: any = {
        query: async (sql: string, params: any[]) => {
          if (sql.includes('INSERT INTO sources')) {
            insertedCooldown = params[9];
          }
          return { rows: [], rowCount: 1 };
        },
      };
      const service = new SourceService(mockPool);

      const res0 = await service.createSource(owner, {
        scope: 'project:demo',
        repo_full_name: 'owner/repo',
        cooldown_seconds: 0,
      }, encKey);
      assert.equal(res0.cooldown_seconds, 0);
      assert.equal(insertedCooldown, 0);

      const res60 = await service.createSource(owner, {
        scope: 'project:demo',
        repo_full_name: 'owner/repo',
        cooldown_seconds: 60,
      }, encKey);
      assert.equal(res60.cooldown_seconds, 60);
      assert.equal(insertedCooldown, 60);

      const resMax = await service.createSource(owner, {
        scope: 'project:demo',
        repo_full_name: 'owner/repo',
        cooldown_seconds: 86400,
      }, encKey);
      assert.equal(resMax.cooldown_seconds, 86400);
      assert.equal(insertedCooldown, 86400);

      // Omitted defaults to 0
      const resDef = await service.createSource(owner, {
        scope: 'project:demo',
        repo_full_name: 'owner/repo',
      }, encKey);
      assert.equal(resDef.cooldown_seconds, 0);
      assert.equal(insertedCooldown, 0);
    });

    it('out-of-range values are rejected on update', async () => {
      const existingSource = {
        id: '10000000-0000-0000-0000-000000000001',
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        kind: 'github',
        name: 'repo',
        repo_full_name: 'owner/repo',
        secret_ciphertext: 'abc',
        accept_mode: 'observe',
        rules: {},
        bot_id: null,
        cooldown_seconds: 0,
        created_by: owner.id,
        version: 1,
        archived: false,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockClient = {
        query: async (sql: string) => {
          if (sql.includes('SELECT * FROM sources')) {
            return { rows: [existingSource] };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      };
      const mockPool: any = {
        connect: async () => mockClient,
      };
      const service = new SourceService(mockPool);

      await assert.rejects(
        async () => await service.update(owner, {
          source_id: existingSource.id,
          expected_version: 1,
          cooldown_seconds: -5,
        }),
        { code: 'invalid_arguments' }
      );

      await assert.rejects(
        async () => await service.update(owner, {
          source_id: existingSource.id,
          expected_version: 1,
          cooldown_seconds: 100000,
        }),
        { code: 'invalid_arguments' }
      );
    });
  });

  describe('recovery bypass pattern matching', () => {
    it('matches recovery keywords: resolved, recovered, closed, back to normal, ok', () => {
      assert.equal(RECOVERY_RE.test('resolved'), true);
      assert.equal(RECOVERY_RE.test('Issue is resolved'), true);
      assert.equal(RECOVERY_RE.test('RECOVERED: service up'), true);
      assert.equal(RECOVERY_RE.test('Incident closed'), true);
      assert.equal(RECOVERY_RE.test('System is back to normal now'), true);
      assert.equal(RECOVERY_RE.test('Everything is ok'), true);
      assert.equal(RECOVERY_RE.test('status: OK'), true);
      assert.equal(RECOVERY_RE.test('[OK] all checks pass'), true);
    });

    it('rejects non-recovery phrases and substrings', () => {
      assert.equal(RECOVERY_RE.test('High CPU alert firing'), false);
      assert.equal(RECOVERY_RE.test('token refreshed'), false); // contains 'ok' inside 'token'
      assert.equal(RECOVERY_RE.test('smoke test running'), false); // contains 'ok' inside 'smoke'
      assert.equal(RECOVERY_RE.test('unresolved error'), false); // not \bresolved\b
      assert.equal(RECOVERY_RE.test('database broken'), false);
    });

    it('isRecoveryDelivery inspects digest title, body_excerpt, and action', () => {
      assert.equal(isRecoveryDelivery({ digest: { title: 'Alert resolved' } }), true);
      assert.equal(isRecoveryDelivery({ digest: { body_excerpt: 'All systems back to normal' } }), true);
      assert.equal(isRecoveryDelivery({ action: 'closed' }), true);
      assert.equal(isRecoveryDelivery({ digest: { body_excerpt: 'Critical error 500' } }), false);
      assert.equal(isRecoveryDelivery({}), false);
    });
  });

  describe('delivery cooldown behaviour in processOneDelivery', () => {
    function setupDeliveryState(opts: {
      cooldownSeconds: number;
      priorDispatchedProcessedAt?: Date | null;
    }) {
      const sourceId = '10000000-0000-0000-0000-000000000001';
      const botId = '20000000-0000-0000-0000-000000000001';
      const threadId = '30000000-0000-0000-0000-000000000001';
      const agentId = '40000000-0000-0000-0000-000000000001';

      const source = {
        id: sourceId,
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        kind: 'github',
        name: 'repo',
        repo_full_name: 'owner/repo',
        secret_ciphertext: 'abc',
        accept_mode: 'auto',
        rules: { allow_authors: ['tester'] },
        bot_id: botId,
        cooldown_seconds: opts.cooldownSeconds,
        created_by: owner.id,
        version: 1,
        archived: false,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const deliveries: Record<string, any> = {};
      let turnTasksQueued = 0;
      let messagesInserted = 0;

      if (opts.priorDispatchedProcessedAt) {
        const priorId = 'd0000000-0000-0000-0000-000000000001';
        deliveries[priorId] = {
          id: priorId,
          tenant_id: 'tenant-1',
          scope: 'project:demo',
          source_id: sourceId,
          delivery_id: 'prior-delivery',
          event_type: 'issue_comment',
          action: 'created',
          body_sha256: 'sha-prior',
          digest: { body_excerpt: 'First alert' },
          classification: 'explicit',
          reason: 'mention',
          mode_at_receipt: 'auto',
          attempts: 0,
          status: 'dispatched',
          processed_at: opts.priorDispatchedProcessedAt,
        };
      }

      const mockClient = {
        query: async (sql: string, params: any[] = []) => {
          try {
            if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql)) {
              return { rows: [], rowCount: 1 };
            }
            if (/FROM\s+source_deliveries/i.test(sql) && /WHERE\s+id\s*=\s*\$1/i.test(sql)) {
              const d = deliveries[params[0]];
              return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
            }
            if (/FROM\s+sources/i.test(sql) && /WHERE\s+id\s*=\s*\$1/i.test(sql)) {
              return { rows: [source], rowCount: 1 };
            }
            if (/SELECT\s+id\s+FROM\s+source_deliveries/i.test(sql) && sql.includes('interval')) {
              // Check for recent dispatched explicit run from the same source
              const found = Object.values(deliveries).find(d =>
                d.source_id === params[0] &&
                d.id !== params[1] &&
                d.status === 'dispatched' &&
                d.classification === 'explicit' &&
                d.processed_at
              );
              return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
            }
            if (/FROM\s+threads/i.test(sql)) {
            return { rows: [{ id: params[1] }], rowCount: 1 };
          }
          if (/FROM\s+bots\s+b/i.test(sql) && /JOIN\s+agents\s+a/i.test(sql)) {
              return {
                rows: [{
                  bot_id: botId,
                  thread_id: threadId,
                  routing: {},
                  rules: {},
                  lead_agent_id: agentId,
                  lead_name: 'LeadBot',
                  lead_scope: 'project:demo',
                  lead_edits: false,
                  lead_runner: { provider: 'claude', fast: false },
                }],
                rowCount: 1,
              };
            }
            if (/coalesce\(max\(seq\)/i.test(sql)) {
              return { rows: [{ next_seq: 1 }], rowCount: 1 };
            }
            if (/INSERT\s+INTO\s+messages/i.test(sql)) {
              messagesInserted++;
              return { rows: [], rowCount: 1 };
            }
            if (/INSERT\s+INTO\s+events/i.test(sql) || /pg_notify/i.test(sql)) {
              return { rows: [], rowCount: 1 };
            }
            if (/SELECT\s+id,\s*context_versions\s+FROM\s+tasks/i.test(sql)) {
              return { rows: [], rowCount: 0 };
            }
            if (/INSERT\s+INTO\s+tasks/i.test(sql)) {
              turnTasksQueued++;
              return { rows: [], rowCount: 1 };
            }
            if (/INSERT\s+INTO\s+audit_log/i.test(sql)) {
              return { rows: [], rowCount: 1 };
            }
            if (/UPDATE\s+source_deliveries/i.test(sql) && sql.includes("'cooldown'")) {
              const deliveryId = params[0];
              if (deliveries[deliveryId]) {
                deliveries[deliveryId].status = 'ignored';
                deliveries[deliveryId].reason = 'cooldown';
                deliveries[deliveryId].processed_at = new Date();
              }
              return { rows: [], rowCount: 1 };
            }
            if (/UPDATE\s+source_deliveries/i.test(sql) && sql.includes("'dispatched'")) {
              const deliveryId = params[0];
              if (deliveries[deliveryId]) {
                deliveries[deliveryId].status = 'dispatched';
                deliveries[deliveryId].message_id = params[1];
                deliveries[deliveryId].task_id = params[2];
                deliveries[deliveryId].processed_at = new Date();
              }
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          } catch (e) {
            console.error('QUERY HANDLER ERROR:', e);
            throw e;
          }
        },
        release: () => {},
      };

      const mockPool: any = {
        connect: async () => mockClient,
      };

      return {
        sourceId,
        deliveries,
        mockPool,
        getTurnTasksQueued: () => turnTasksQueued,
        getMessagesInserted: () => messagesInserted,
      };
    }

    it('cooldown_seconds 0 changes nothing: consecutive deliveries both start tasks', async () => {
      const state = setupDeliveryState({ cooldownSeconds: 0 });
      const deliv1Id = 'd0000000-0000-0000-0000-000000000010';
      state.deliveries[deliv1Id] = {
        id: deliv1Id,
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        source_id: state.sourceId,
        delivery_id: 'deliv-1',
        event_type: 'issue_comment',
        action: 'created',
        body_sha256: 'sha1',
        digest: { body_excerpt: 'Alert firing: disk 90% @swarmaa' },
        classification: 'explicit',
        reason: 'mention',
        mode_at_receipt: 'auto',
        attempts: 0,
        status: 'received',
      };

      await processOneDelivery(state.mockPool, deliv1Id);
      assert.equal(state.deliveries[deliv1Id].status, 'dispatched');
      assert.equal(state.getTurnTasksQueued(), 1);

      // Second delivery arriving right after
      const deliv2Id = 'd0000000-0000-0000-0000-000000000011';
      state.deliveries[deliv2Id] = {
        id: deliv2Id,
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        source_id: state.sourceId,
        delivery_id: 'deliv-2',
        event_type: 'issue_comment',
        action: 'created',
        body_sha256: 'sha2',
        digest: { body_excerpt: 'Alert firing: disk 91% @swarmaa' },
        classification: 'explicit',
        reason: 'mention',
        mode_at_receipt: 'auto',
        attempts: 0,
        status: 'received',
      };

      await processOneDelivery(state.mockPool, deliv2Id);
      assert.equal(state.deliveries[deliv2Id].status, 'dispatched');
      assert.equal(state.getTurnTasksQueued(), 2);
    });

    it('a second delivery inside cooldown is recorded as cooldown and starts no task', async () => {
      // Prior delivery was dispatched 10 seconds ago, cooldown is 60s
      const tenSecsAgo = new Date(Date.now() - 10_000);
      const state = setupDeliveryState({
        cooldownSeconds: 60,
        priorDispatchedProcessedAt: tenSecsAgo,
      });

      const secondDeliveryId = 'd0000000-0000-0000-0000-000000000020';
      state.deliveries[secondDeliveryId] = {
        id: secondDeliveryId,
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        source_id: state.sourceId,
        delivery_id: 'deliv-retry',
        event_type: 'issue_comment',
        action: 'created',
        body_sha256: 'sha-retry',
        digest: { body_excerpt: 'Noisy retry: CPU still high @swarmaa' },
        classification: 'explicit',
        reason: 'mention',
        mode_at_receipt: 'auto',
        attempts: 0,
        status: 'received',
      };

      await processOneDelivery(state.mockPool, secondDeliveryId);

      // Recorded with status ignored and reason cooldown
      assert.equal(state.deliveries[secondDeliveryId].status, 'ignored');
      assert.equal(state.deliveries[secondDeliveryId].reason, 'cooldown');

      // Starts NO task and inserts no message into the thread
      assert.equal(state.getTurnTasksQueued(), 0);
      assert.equal(state.getMessagesInserted(), 0);
    });

    it("a delivery containing 'resolved' inside cooldown starts a task (recovery bypass)", async () => {
      // Prior delivery was dispatched 10 seconds ago, cooldown is 60s
      const tenSecsAgo = new Date(Date.now() - 10_000);
      const state = setupDeliveryState({
        cooldownSeconds: 60,
        priorDispatchedProcessedAt: tenSecsAgo,
      });

      const recoveryDeliveryId = 'd0000000-0000-0000-0000-000000000030';
      state.deliveries[recoveryDeliveryId] = {
        id: recoveryDeliveryId,
        tenant_id: 'tenant-1',
        scope: 'project:demo',
        source_id: state.sourceId,
        delivery_id: 'deliv-resolved',
        event_type: 'issue_comment',
        action: 'created',
        body_sha256: 'sha-resolved',
        digest: { body_excerpt: 'Alert resolved: CPU is back to normal @swarmaa' },
        classification: 'explicit',
        reason: 'mention',
        mode_at_receipt: 'auto',
        attempts: 0,
        status: 'received',
      };

      await processOneDelivery(state.mockPool, recoveryDeliveryId);

      // Bypasses cooldown and starts a task!
      assert.equal(state.deliveries[recoveryDeliveryId].status, 'dispatched');
      assert.equal(state.getTurnTasksQueued(), 1);
      assert.equal(state.getMessagesInserted(), 1);
    });
  });
});
