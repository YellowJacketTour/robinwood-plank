import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { hasPostgresConfig, postgresPool, closePostgres } from '../../lib/postgres';
const exec=promisify(execFile);

test('real blocked migration rolls back, remains pending, permits required schema, then installs on retry', {skip:!hasPostgresConfig(),timeout:60000},async()=>{
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
  assert.match(result.stdout,/required schema ready; optional notifications PENDING/);
  const applied=(await inspect.query('SELECT version FROM plank_schema_migrations')).rows.map(r=>r.version);
  assert.equal(applied.includes('110_market_change_notifications.sql'),false);
  for(const file of all.filter(f=>parseInt(f,10)>110))assert.ok(applied.includes(file));
  assert.equal((await inspect.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'plank_changes_%'")).rows[0].n,0,'failed transaction leaves no partially installed triggers');
  assert.equal((await blocker.query('SELECT 1 AS alive')).rows[0].alive,1,'maintenance session is never terminated');
  await blocker.query('ROLLBACK');
  await run();
  assert.equal((await inspect.query("SELECT count(*)::int AS n FROM plank_schema_migrations WHERE version='110_market_change_notifications.sql'")).rows[0].n,1);
  assert.ok((await inspect.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'plank_changes_%'")).rows[0].n>=27);
 } finally {
  await blocker?.end().catch(()=>{});await inspect?.end().catch(()=>{});
  await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(()=>{});await admin.end();await closePostgres();
  assert.ok(path.resolve(root).startsWith(workRoot+path.sep));await rm(root,{recursive:true,force:true});
 }
});
