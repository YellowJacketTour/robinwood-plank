import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { hasPostgresConfig, postgresPool, closePostgres } from '../../lib/postgres';
// @ts-expect-error standalone deployment module
import { OPTIONAL_LOCKED_TABLE_MIGRATIONS } from '../../scripts/notification-migration-policy.mjs';
const exec=promisify(execFile);

test('real blocked migrations roll back, remain pending, permit required schema, then install on retry', {skip:!hasPostgresConfig(),timeout:60000},async()=>{
 const suffix=String(Date.now()); const db=`notify_compat_${suffix}`;const role=`notify_lock_${suffix}`;
 const admin=new Client(postgresPool().options);let inspect:Client|undefined;let blocker:Client|undefined;
 const workRoot=path.resolve('work');await mkdir(workRoot,{recursive:true});const root=await mkdtemp(path.join(workRoot,'notify-compat-'));
 const scripts=path.join(root,'scripts'),migrations=path.join(root,'deploy/inmotion/postgres/migrations');
 await Promise.all([mkdir(scripts,{recursive:true}),mkdir(migrations,{recursive:true})]);
 for(const file of ['migrate-postgres.mjs','market-migration-drain.mjs','notification-migration-policy.mjs'])await copyFile(path.join('scripts',file),path.join(scripts,file));
 const all=(await readdir('deploy/inmotion/postgres/migrations')).filter(f=>/^\d.*\.sql$/.test(f)).sort();
 for(const file of all.filter(f=>parseInt(f,10)<110))await copyFile(path.join('deploy/inmotion/postgres/migrations',file),path.join(migrations,file));
 await admin.connect();
 try {
  await admin.query(`CREATE DATABASE "${db}"`);
  const env={...process.env,PGDATABASE:db};
  const run=(args:string[]=[])=>exec(process.execPath,[path.join(scripts,'migrate-postgres.mjs'),...args],{env,timeout:45000,maxBuffer:2*1024*1024,windowsHide:true});
  await run();
  inspect=new Client({...postgresPool().options,database:db});await inspect.connect();
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-compatibility-test'`);
  await inspect.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await inspect.query(`GRANT ALL ON plank_market_events TO "${role}"`);
  blocker=new Client({...postgresPool().options,database:db,user:role,password:'local-compatibility-test'});await blocker.connect();
  await blocker.query('BEGIN');await blocker.query('LOCK TABLE plank_market_events IN SHARE UPDATE EXCLUSIVE MODE');
  for(const file of all.filter(f=>parseInt(f,10)>=110))await copyFile(path.join('deploy/inmotion/postgres/migrations',file),path.join(migrations,file));
  const result=await run(['--defer-locked-notifications']);
  assert.match(result.stdout,/required schema ready; optional migrations PENDING/);
  const applied=(await inspect.query('SELECT version FROM plank_schema_migrations')).rows.map(r=>r.version);
  // Every deferrable migration must actually be exercised here: it exists on
  // disk, was reported PENDING by name, and was not recorded as applied. A
  // hash pinned to a file that is not shipped would be a dead entry.
  const optional=Object.keys(OPTIONAL_LOCKED_TABLE_MIGRATIONS as Record<string,string>);
  assert.ok(optional.length>=2,'policy lists 110 and 149');
  for(const file of optional){
    assert.ok(all.includes(file),`${file} is shipped`);
    assert.ok(result.stdout.includes(`PENDING ${file}:`)||result.stderr.includes(`PENDING ${file}:`),`${file} reported PENDING by name`);
    assert.equal(applied.includes(file),false,`${file} deferred, not recorded`);
  }
  // Every other migration after 110 -- 148's fill-table indexes included --
  // installs behind the lock. This is the assertion that forced 148 to leave
  // plank_market_events alone and 149 to exist.
  for(const file of all.filter(f=>parseInt(f,10)>110&&!optional.includes(f)))assert.ok(applied.includes(file),`${file} required, applied`);
  assert.equal((await inspect.query("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='plank_market_events' AND indexname LIKE '%_feed_idx'")).rows[0].n,0,'failed transaction leaves no partially built feed index');
  // --check with ONLY optional migrations pending exits 0 (no backup gate)
  // and names them; add one required migration and it exits 3 naming that
  // one -- the exact decision the deploy's pre-migration backup keys on.
  const check=await run(['--check']);
  assert.match(check.stdout,/check: required schema is current; 2 optional pending \(deferrable, additive, no backup gate\): 110_market_change_notifications\.sql, 149_market_events_feed_indexes\.sql/);
  await writeFile(path.join(migrations,'998_zz_required_probe.sql'),'SELECT 1;\n');
  const gated=await run(['--check']).then(()=>null,(e:{code?:number;stdout?:string})=>e);
  assert.ok(gated,'a required pending migration must make --check exit non-zero');
  assert.equal(gated!.code,3);
  assert.match(gated!.stdout??'',/check: 1 pending: 998_zz_required_probe\.sql \(plus 2 optional: 110_market_change_notifications\.sql, 149_market_events_feed_indexes\.sql\)/);
  await rm(path.join(migrations,'998_zz_required_probe.sql'));
  assert.equal((await inspect.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'plank_changes_%'")).rows[0].n,0,'failed transaction leaves no partially installed triggers');
  assert.equal((await blocker.query('SELECT 1 AS alive')).rows[0].alive,1,'maintenance session is never terminated');
  await blocker.query('ROLLBACK');
  await run();
  assert.equal((await inspect.query("SELECT count(*)::int AS n FROM plank_schema_migrations WHERE version='110_market_change_notifications.sql'")).rows[0].n,1);
  assert.ok((await inspect.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'plank_changes_%'")).rows[0].n>=27);
  for(const file of optional)assert.equal((await inspect.query("SELECT count(*)::int AS n FROM plank_schema_migrations WHERE version=$1",[file])).rows[0].n,1,`${file} installed on retry`);
  assert.deepEqual((await inspect.query("SELECT indexname FROM pg_indexes WHERE tablename='plank_market_events' AND indexname LIKE '%_feed_idx' ORDER BY 1")).rows.map(r=>r.indexname),['plank_market_events_stream_feed_idx','plank_market_events_transfer_feed_idx']);
 } finally {
  await blocker?.end().catch(()=>{});await inspect?.end().catch(()=>{});
  await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(()=>{});await admin.end();await closePostgres();
  assert.ok(path.resolve(root).startsWith(workRoot+path.sep));await rm(root,{recursive:true,force:true});
 }
});
