import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  botCapability,
  validateRouting,
  validateRules,
  validateSchedule,
  formatTaskCardBody,
  DEFAULT_BOT_RULES
} from '../src/core/bots.js';

describe('bots unit tests', () => {
  describe('routing validation', () => {
    it('allows empty or omitted routing', () => {
      assert.deepEqual(validateRouting(undefined), {});
      assert.deepEqual(validateRouting(null), {});
      assert.deepEqual(validateRouting({}), {});
    });

    it('validates known providers and modes across all kinds', () => {
      const valid = {
        research: { mode: 'auto' },
        patch: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        review: { mode: 'different_from_author' },
        summary: { provider: 'antigravity', model: 'gemini-3.8-flash-high' }
      };
      const res = validateRouting(valid);
      assert.deepEqual(res, valid);
    });

    it('rejects unknown routing kinds', () => {
      assert.throws(() => validateRouting({ deploy: { mode: 'auto' } }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });

    it('rejects unknown providers', () => {
      assert.throws(() => validateRouting({ patch: { provider: 'openai' } }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });

    it('rejects different_from_author on kinds other than review', () => {
      assert.throws(() => validateRouting({ patch: { mode: 'different_from_author' } }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
      assert.throws(() => validateRouting({ research: { mode: 'different_from_author' } }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });

    it('rejects runner specifying both mode and provider', () => {
      assert.throws(() => validateRouting({ research: { mode: 'auto', provider: 'codex' } }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });
  });

  describe('rules validation', () => {
    it('defaults all rules when omitted', () => {
      assert.deepEqual(validateRules(undefined), DEFAULT_BOT_RULES);
      assert.deepEqual(validateRules(null), DEFAULT_BOT_RULES);
      assert.deepEqual(validateRules({}), DEFAULT_BOT_RULES);
    });

    it('validates rules within allowed boundaries', () => {
      const custom = {
        quota_floor_pct: 25,
        approve_public: false,
        review_edits: false,
        require_tests: true
      };
      assert.deepEqual(validateRules(custom), custom);
    });

    it('merges partial rules with existing rules', () => {
      const existing = {
        quota_floor_pct: 10,
        approve_public: false,
        review_edits: true,
        require_tests: true
      };
      const updated = validateRules({ quota_floor_pct: 30 }, existing);
      assert.deepEqual(updated, {
        quota_floor_pct: 30,
        approve_public: false,
        review_edits: true,
        require_tests: true
      });
    });

    it('rejects quota_floor_pct outside 0..50', () => {
      assert.throws(() => validateRules({ quota_floor_pct: -1 }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
      assert.throws(() => validateRules({ quota_floor_pct: 51 }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });

    it('rejects unknown rule keys', () => {
      assert.throws(() => validateRules({ unknown_rule: true }), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });
  });

  describe('schedule validation', () => {
    it('allows null or undefined schedule', () => {
      assert.equal(validateSchedule(undefined), null);
      assert.equal(validateSchedule(null), null);
    });

    it('accepts valid 5-field cron with and without CRON_TZ prefix', () => {
      assert.equal(validateSchedule('0 9 * * 1-5'), '0 9 * * 1-5');
      assert.equal(validateSchedule('*/15 0-23 * * *'), '*/15 0-23 * * *');
      assert.equal(
        validateSchedule('CRON_TZ=America/New_York 0 9 * * 1-5'),
        'CRON_TZ=America/New_York 0 9 * * 1-5'
      );
      assert.equal(
        validateSchedule('CRON_TZ=UTC 30 14 1 * *'),
        'CRON_TZ=UTC 30 14 1 * *'
      );
    });

    it('rejects invalid field counts and illegal characters', () => {
      // 4 fields
      assert.throws(() => validateSchedule('0 9 * *'), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
      // 6 fields without TZ
      assert.throws(() => validateSchedule('0 9 * * 1 2026'), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
      // too short
      assert.throws(() => validateSchedule('* * *'), {
        name: 'AppError',
        code: 'invalid_arguments'
      });
    });
  });

  describe('botCapability', () => {
    const bot = {
      routing: {
        research: { provider: 'codex' },
        patch: { provider: 'claude', model: 'claude-opus-5-5' },
        review: { mode: 'different_from_author' },
        summary: { mode: 'auto' }
      }
    };

    it('maps provider runner to <provider>.read and <provider>.patch', () => {
      assert.equal(botCapability(bot, 'patch', true), 'claude.patch');
      assert.equal(botCapability(bot, 'patch', false), 'claude.read');
      assert.equal(botCapability(bot, 'research', false), 'codex.read');
      assert.equal(botCapability(bot, 'research', true), 'codex.patch');
    });

    it('maps auto and different_from_author modes to auto.read and auto.patch', () => {
      assert.equal(botCapability(bot, 'review', false), 'auto.read');
      assert.equal(botCapability(bot, 'review', true), 'auto.patch');
      assert.equal(botCapability(bot, 'summary', false), 'auto.read');
      assert.equal(botCapability(bot, 'summary', true), 'auto.patch');
    });

    it('maps missing kinds and missing bot to auto.read and auto.patch', () => {
      assert.equal(botCapability(bot, 'unknown_kind', false), 'auto.read');
      assert.equal(botCapability(bot, 'unknown_kind', true), 'auto.patch');
      assert.equal(botCapability(null, 'patch', true), 'auto.patch');
      assert.equal(botCapability(undefined, 'research', false), 'auto.read');
    });
  });

  describe('formatTaskCardBody', () => {
    it('formats review-ready task card body matching brief spec', () => {
      const line = formatTaskCardBody(
        'Forge',
        'Bot',
        'the launch banner',
        'completed',
        { branch: 'swarmaa/claude/4f1e', changed_files: 7 }
      );
      assert.equal(line, 'Forge finished the launch banner · swarmaa/claude/4f1e · 7 files');
    });

    it('formats failed task card body matching brief spec', () => {
      const line = formatTaskCardBody(
        null,
        'Bot',
        'Task',
        'failed',
        { failure: { code: 'quota_exhausted' }, served: { provider: 'codex' } }
      );
      assert.equal(line, 'Failed · quota_exhausted on Codex');
    });
  });
});
