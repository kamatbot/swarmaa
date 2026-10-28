import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botPolicy, nextCronRun, quotaLeft, routingNow, type BotRoutingRow } from '../src/core/bot-routing.js';
import { DEFAULT_POLICY, type UsageRow } from '../src/core/routing.js';
import type { Db } from '../src/core/shared.js';
const next = (cron:string,date:string) => nextCronRun(cron,new Date(date)).toISOString();
test('cron steps, ranges, lists and Sunday alias', () => {
  assert.equal(next('1-10/3 8,12 * * 1-5','2026-10-28T08:01:00Z'),'2026-10-28T08:04:00.000Z');
  assert.equal(next('0 0 * * 7','2026-10-30T23:59:00Z'),'2026-11-01T00:00:00.000Z');
  assert.equal(next('*/15 * * * *','2026-10-28T08:01:30Z'),'2026-10-28T08:15:00.000Z');
  assert.equal(next('0 0 1 11 *','2026-10-31T23:59:00Z'),'2026-11-01T00:00:00.000Z');
});
test('cron day-of-month and weekday use POSIX OR for restricted fields', () => {
  assert.equal(next('0 0 1 * 1','2026-10-27T00:00:00Z'),'2026-11-01T00:00:00.000Z');
  assert.equal(next('0 0 1 * 1','2026-11-01T00:00:00Z'),'2026-11-02T00:00:00.000Z');
});
test('cron CRON_TZ honours local offsets and DST missing and repeated hours', () => {
  assert.equal(next('CRON_TZ=Asia/Bangkok 0 9 * * *','2026-10-28T01:59:00Z'),'2026-10-28T02:00:00.000Z');
  assert.equal(next('CRON_TZ=America/New_York 30 2 * * *','2026-03-08T06:59:00Z'),'2026-03-09T06:30:00.000Z');
  assert.equal(next('CRON_TZ=America/New_York 30 1 * * *','2026-11-01T05:30:00Z'),'2026-11-01T06:30:00.000Z');
});
test('cron rejects invalid fields, steps, ranges and time zones', () => {
  for (const c of ['* * * *','60 * * * *','*/0 * * * *','9-1 * * * *','* * * 13 *','CRON_TZ=Nope * * * * *']) assert.throws(() => next(c,'2026-01-01T00:00:00Z'));
});
const usage = (provider:string,five:number,week:number):UsageRow => ({provider,ok:true,fresh:true,live:true,headroom:100-Math.max(five,week),windows:[{name:'5h',used_percent:five},{name:'weekly',used_percent:week}]});
test('bot floor uses most-used window, accepts exact floor and zero at 99, preserves global maxima', () => {
  assert.equal(quotaLeft(usage('codex',2,86).windows),14);
  const policy = structuredClone(DEFAULT_POLICY);
  policy.providers.forEach(p => {p.max_five_hour_pct=100;p.max_weekly_pct=100;});
  assert.deepEqual(botPolicy(policy,[usage('claude',85,1)],15).providers.map(p => p.provider),['claude']);
  assert.equal(botPolicy(policy,[usage('claude',86,1)],15).providers.length,0);
  assert.ok(botPolicy(policy,[usage('codex',99,99)],0).providers.some(p => p.provider==='codex'));
  assert.ok(!botPolicy(DEFAULT_POLICY,[usage('codex',99,99)],0).providers.some(p => p.provider==='codex'));
});
test('routingNow reasons cover named runner, floor, quota and different author', async () => {
  const rows = [usage('claude',90,90),usage('codex',20,20)];
  const db = {query:async (sql:string) => ({rows:sql.includes('routing_policies') ? [] : rows.map(u => ({...u,windows:{windows:u.windows}}))})} as unknown as Db;
  const bot = {scope:'project:a',routing:{patch:{provider:'claude'},review:{mode:'different_from_author'}},rules:{quota_floor_pct:15}} as BotRoutingRow;
  const result = await routingNow(db,'tenant',bot);
  assert.equal(result.patch.reason,'named runner');
  assert.equal(result.review.reason,'different from the author');
  assert.equal(result.research.reason,'Claude below the 15% floor');
  assert.equal(result.research.provider_now,'codex');
  bot.rules.quota_floor_pct=0;
  assert.equal((await routingNow(db,'tenant',bot)).research.reason,'most quota left');
});
