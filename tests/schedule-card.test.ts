import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRules } from '../src/core/bots.js';

test('schedule pause survives partial rule updates and rejects non-booleans', () => {
  assert.equal(validateRules({schedule_paused:true}).schedule_paused, true);
  assert.equal(validateRules({require_tests:true}, {schedule_paused:true}).schedule_paused, true);
  assert.equal(validateRules({schedule_paused:false}, {schedule_paused:true}).schedule_paused, false);
  assert.throws(() => validateRules({schedule_paused:'true'}));
});

import { describeSchedule, scheduleCard } from '../src/core/bot-routing.js';
import { TOOLS } from '../src/core/tools.js';

test('common schedules have accurate descriptions; irregular intervals retain cron', () => {
  for (const [cron, description] of [
    ['* * * * *', 'Every minute'], ['*/15 * * * *', 'Every 15 minutes'],
    ['0 */6 * * *', 'Every 6 hours'], ['0 * * * *', 'Every hour'],
    ['30 9 * * *', 'Daily at 09:30'], ['0 9 * * 1-5', 'Weekdays at 09:00'],
    ['5 14 * * 7', 'Weekly on Sunday at 14:05'],
    ['*/7 * * * *', '*/7 * * * *'], ['0 */5 * * *', '0 */5 * * *'], ['0 9 1 * 1', '0 9 1 * 1']
  ]) assert.equal(describeSchedule(cron!), description);
});

test('card computes three real timezone-aware occurrences and handles pause/clear', () => {
  const now = new Date('2026-03-07T15:00:00Z');
  const cron = 'CRON_TZ=America/New_York 0 9 * * *';
  assert.deepEqual(scheduleCard(cron,false,now), {
    cron:'0 9 * * *', description:'Daily at 09:00', timezone:'America/New_York', paused:false,
    next_runs:['2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z','2026-03-10T13:00:00.000Z']
  });
  assert.deepEqual(scheduleCard(cron,true,now).next_runs, []);
  assert.deepEqual(scheduleCard(null,false,now), {cron:null,description:'Schedule cleared',timezone:'UTC',next_runs:[],paused:false});
});

test('tool schemas expose pause and nullable schedule', () => {
  for (const name of ['bot_create','bot_update']) {
    const properties = TOOLS.find(t => t.name===name)!.inputSchema.properties as any;
    assert.deepEqual(properties.schedule.type,['string','null']);
    assert.equal(properties.rules.properties.schedule_paused.type,'boolean');
  }
});
