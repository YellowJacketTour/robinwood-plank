import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {broadcastAuthority} from '../../lib/charmville/broadcast-authority';

function database(authenticated=true,mode='allowlist'){
 const calls:string[]=[];
 const client={release(){calls.push('RELEASE');},async query(sql:string){
  calls.push(sql);
  if(sql.includes('plankspace_wallet_sessions'))return {rows:authenticated?[{id:'7'}]:[]};
  if(sql.includes('SELECT id FROM plankspace_profiles'))return {rows:[{id:'9'}],rowCount:1};
  if(sql.includes('charmville_spectator_settings'))return {rows:[{mode,allowed:['7'],revision:'4'}]};
  return {rows:[]};
 }};
 return {pool:{connect:async()=>client} as unknown as Pool,calls};
}
test('broadcast authority obtains identity and policy from current server records',async()=>{
 const db=database();
 assert.deepEqual(await broadcastAuthority(db.pool,'a'.repeat(64),'9'),{profileId:'7',ownerId:'9',mode:'allowlist',allowedIds:['7'],revision:'4'});
 assert.deepEqual(db.calls.slice(-2),['COMMIT','RELEASE']);
});
test('expired sessions cannot resolve broadcast authority and release transaction',async()=>{
 const db=database(false);
 await assert.rejects(broadcastAuthority(db.pool,'a'.repeat(64),'9'),/expired/);
 assert.deepEqual(db.calls.slice(-2),['ROLLBACK','RELEASE']);
 assert.equal(db.calls.some(sql=>sql.includes('charmville_spectator_settings')),false);
});
test('unknown policy fails closed instead of granting public viewing',async()=>{
 const db=database(true,'corrupt');
 await assert.rejects(broadcastAuthority(db.pool,'a'.repeat(64),'9'),/policy unavailable/);
 assert.deepEqual(db.calls.slice(-2),['ROLLBACK','RELEASE']);
});
