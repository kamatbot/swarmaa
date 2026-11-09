import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { sweepRetention } from '../src/core/retention.js';
import { loadConfig } from '../src/config.js';

// Needs a disposable PostgreSQL database via TEST_DATABASE_URL.
test('indexes, lesson full-text search and retention', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `idx_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const f of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(f, dir), 'utf8'));

  await t.test('037 creates the task indexes', async () => {
    const r = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='tasks'`, [schema]);
    const names = r.rows.map(x => x.indexname);
    assert.ok(names.includes('tasks_running_lease_owner_idx') && names.includes('tasks_tenant_updated_idx'));
  });

  const tenant = 'idx-t';
  const principal = (await pool.query(`INSERT INTO principals (id,tenant_id,name,role,scopes,permissions,token_hash) VALUES ($1,$2,'p','frontend','{project:a}','{}',$3) RETURNING id`, [randomUUID(), tenant, randomUUID()])).rows[0].id;

  await t.test('lesson search uses the GIN index', async () => {
    const ins = (title: string, body: string) => pool.query(`INSERT INTO lessons (id,tenant_id,scope,kind,title,applicability,body,state,source,proposed_by)
      VALUES ($1,$2,'project:a','gotcha',$3,'when x',$4,'approved','agent',$5)`, [`lesson_${randomBytes(32).toString('hex')}`, tenant, title, body, principal]);
    await ins('Run migrate first', 'Always migrate before restart.');
    await ins('Pin node', 'Use node 24 for tsx.');
    await pool.query(`INSERT INTO lessons (id,tenant_id,scope,kind,title,applicability,body,state,source,proposed_by)
      SELECT 'lesson_'||md5(g::text)||md5(g::text),$1,'project:z','gotcha','filler '||g,'a','b '||g,'approved','agent',$2 FROM generate_series(1,2000) g`, [tenant, principal]);
    await pool.query('ANALYZE lessons');
    const { LessonService } = await import('../src/core/lessons.js');
    const svc = new LessonService(pool);
    const p = { id: principal, tenantId: tenant, name: 'p', role: 'frontend', scopes: ['project:a'], credentialVersion: 1 } as any;
    const hit = async (q: string) => ((await svc.search(p, { scope: 'project:a', q })) as any).lessons.map((l: any) => l.title);
    assert.deepEqual(await hit('migrate'), ['Run migrate first']);
    assert.deepEqual(await hit('node tsx'), ['Pin node']);
    assert.deepEqual(await hit('migrate node'), []);
    const plan = await pool.query(`EXPLAIN SELECT * FROM lessons l WHERE to_tsvector('simple', l.title || ' ' || l.applicability || ' ' || l.body) @@ to_tsquery('simple','filler & 17')`);
    assert.match(plan.rows.map(r => r['QUERY PLAN']).join('\n'), /lessons_search_idx/);
  });

  await t.test('retention deletes only old rows in batches and is off by default', async () => {
    const base = { PUBLIC_URL: 'https://example.test' };
    assert.equal(loadConfig(base).retentionDays, undefined);
    assert.equal(loadConfig({ ...base, RETENTION_DAYS: '30' }).retentionDays, 30);
    assert.throws(() => loadConfig({ ...base, RETENTION_DAYS: '-1' }));
    await pool.query(`INSERT INTO events (id,tenant_id,scope,name,subject_id,created_at)
      SELECT gen_random_uuid(),$1,'project:a','task.updated',g::text, CASE WHEN g<=6000 THEN now()-interval '40 days' ELSE now() END FROM generate_series(1,6010) g`, [tenant]);
    await pool.query(`INSERT INTO audit_log (id,tenant_id,actor_id,operation,subject_id,created_at) VALUES
      (gen_random_uuid(),$1,$2,'x','old',now()-interval '40 days'),(gen_random_uuid(),$1,$2,'x','new',now())`, [tenant, principal]);
    // Push cursor has consumed everything.
    await pool.query(`UPDATE push_cursor SET last_xid=(SELECT max(xid) FROM events), last_seq=(SELECT max(seq) FROM events) WHERE id=1`);
    const cnt = async (t: string) => Number((await pool.query(`SELECT count(*) FROM ${t} WHERE tenant_id=$1`, [tenant])).rows[0].count);
    // A client holding a cursor older than everything must still get all surviving events.
    const after = () => pool.query(`SELECT count(*)::int AS n FROM events WHERE tenant_id=$1 AND (xid,seq)>('0'::xid8,0)`, [tenant]);
    assert.equal((await after()).rows[0].n, 6010);
    const r = await sweepRetention(pool, 30);
    assert.deepEqual([r.events, r.audit_log], [6000, 1]);
    assert.equal(await cnt('events'), 10);
    assert.equal((await after()).rows[0].n, 10);
    assert.equal(await cnt('audit_log'), 1);
    assert.deepEqual(await sweepRetention(pool, 30), { event_deliveries: 0, events: 0, audit_log: 0 });
  });
});
