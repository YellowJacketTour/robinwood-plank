import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { hasPostgresConfig, postgresPool, closePostgres } from '../../lib/postgres';
// @ts-expect-error standalone deployment module is JavaScript
import { withMarketMigrationDrain } from '../../scripts/market-migration-drain.mjs';

test('migration drain rolls back only an actual market DDL blocker and preserves other sessions', {skip: !hasPostgresConfig()}, async () => {
 const options=postgresPool().options;
 const blocker=new Client(options), reader=new Client(options), migration=new Client(options);
 blocker.on('error',()=>{});
 const marker=`migration-drain-test-${Date.now()}`;
 const logs:string[]=[];
 try {
  await Promise.all([blocker.connect(),reader.connect(),migration.connect()]);
  await blocker.query('BEGIN');
  await blocker.query("INSERT INTO plank_kv_values(key_name,value) VALUES ($1,'{}'::jsonb)",[marker]);
  await blocker.query('LOCK TABLE plank_market_events IN ROW EXCLUSIVE MODE');
  await reader.query('BEGIN');
  await reader.query('LOCK TABLE plank_market_events IN ACCESS SHARE MODE');
  await reader.query('LOCK TABLE plank_data_jobs IN ROW EXCLUSIVE MODE');
  await migration.query('BEGIN');
  await migration.query("SET LOCAL lock_timeout='3s'");
  await withMarketMigrationDrain(migration,options,()=>migration.query('LOCK TABLE plank_market_events IN SHARE ROW EXCLUSIVE MODE'),{graceMs:100,intervalMs:25,log:(s:string)=>logs.push(s)});
  await migration.query('COMMIT');
  assert.ok(logs.some(line=>line.includes('rolled_back=true')));
  assert.equal((await reader.query('SELECT 1 AS alive')).rows[0].alive,1);
  assert.equal((await migration.query('SELECT 1 FROM plank_kv_values WHERE key_name=$1',[marker])).rowCount,0,'uncommitted work rolls back; no partial publish');
 } finally {
  await reader.query('ROLLBACK').catch(()=>{});
  await migration.query('ROLLBACK').catch(()=>{});
  await Promise.allSettled([blocker.end(),reader.end(),migration.end()]);
  await closePostgres();
 }
});
