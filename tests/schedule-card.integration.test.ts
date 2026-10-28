import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, {type Pool} from 'pg';
import { CoreService } from '../src/core/index.js';
import { tickBotSchedules } from '../src/core/bot-routing.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';
const connectionString = process.env.TEST_DATABASE_URL;

describe('schedule cards', {skip:!connectionString}, () => {
  const schema = `schedule_${randomUUID().replaceAll('-','')}`;
  let control:Pool, pool:Pool, core:CoreService;
  before(async () => {
    control=new pg.Pool({connectionString,max:1});
    await control.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema},public`});
    for (const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
      await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    core=new CoreService(pool);
  });
  after(async () => { await pool?.end(); if(control) { await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end(); } });
  it('create/replay/edit/pause/resume/clear keep one card and ticker respects pause', async () => {
    const p:Principal={id:randomUUID(),tenantId:randomUUID(),name:'test',role:'frontend',scopes:['project:a'],permissions:[...ROLE_PERMISSIONS.frontend]};
    await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    const call=async(name:string,input:Record<string,unknown>)=>await core.call(p,name,input) as any;
    const {agent}=await call('agent_create',{name:'Lead',role:'Lead',instructions:'Help',scope:'project:a',runner:{mode:'auto'}});
    const input={name:'Bot',job:'Help',scope:'project:a',lead_agent_id:agent.id,member_agent_ids:[],schedule:'* * * * *',idempotency_key:'create'};
    let {bot}=await call('bot_create',input);
    const card=async()=> (await pool.query("SELECT * FROM messages WHERE thread_id=$1 AND kind='schedule'",[bot.thread_id])).rows;
    const original=(await card())[0];
    assert.equal((await card()).length,1); assert.equal(original.ref.next_runs.length,3);
    assert.ok(new Date(bot.next_run_at)>new Date());
    await call('bot_create',input); assert.equal((await card()).length,1);
    const update=async(patch:Record<string,unknown>)=> { ({bot}=await call('bot_update',{bot_id:bot.id,expected_version:bot.version,...patch})); };
    await update({schedule:'CRON_TZ=Asia/Bangkok 0 9 * * 1-5'});
    assert.equal((await card())[0].ref.timezone,'Asia/Bangkok');
    await update({rules:{schedule_paused:true}});
    assert.equal(bot.next_run_at,null); assert.equal((await card())[0].ref.paused,true);
    await pool.query("UPDATE bots SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[bot.id]);
    await tickBotSchedules(pool);
    assert.equal((await pool.query('SELECT 1 FROM tasks WHERE bot_id=$1',[bot.id])).rowCount,0);
    await update({rules:{schedule_paused:false}});
    assert.ok(new Date(bot.next_run_at)>new Date()); assert.equal((await card())[0].ref.next_runs.length,3);
    await pool.query("UPDATE bots SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[bot.id]);
    await Promise.all([tickBotSchedules(pool),tickBotSchedules(pool)]);
    assert.equal((await pool.query('SELECT 1 FROM tasks WHERE bot_id=$1',[bot.id])).rowCount,1);
    await update({schedule:null});
    const cleared=(await card())[0];
    assert.equal((await card()).length,1); assert.equal(cleared.id,original.id); assert.equal(cleared.seq,original.seq);
    assert.equal(cleared.ref.cron,null); assert.deepEqual(cleared.ref.next_runs,[]);
    assert.ok((await pool.query("SELECT 1 FROM events WHERE subject_id=$1 AND name='message.updated'",[original.id])).rowCount!>0);
    await assert.rejects(core.call({...p,scopes:['project:other']},'bot_update',{bot_id:bot.id,expected_version:bot.version,rules:{schedule_paused:true}}));
    await assert.rejects(call('bot_update',{bot_id:bot.id,expected_version:1,rules:{schedule_paused:true}}));
    assert.equal((await card())[0].ref.cron,null);
  });
});
