import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {worldPresence} from '../../lib/charmville/world-presence';
import {homeAccess,parseHomeGrant} from '../../lib/charmville/home-access-store';

test('four admitted profiles share a hub, visit one home and return without exchanging custody', {skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const url=process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname));
 const previousMode=process.env.CHARMVILLE_ACCESS_MODE,previousWallets=process.env.CHARMVILLE_ALLOWED_WALLETS;
 process.env.CHARMVILLE_ACCESS_MODE='private';
 process.env.CHARMVILLE_ALLOWED_WALLETS='0x1111111111111111111111111111111111111111';
 const admin=new Pool({connectionString:url}),schema=`four_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
 try {
  for(const file of ['090_plankspace_native.sql','116_charmville_soil.sql','118_charmville_home_access.sql','120_charmville_world_presence.sql','144_charmville_private_admission.sql'])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,'utf8'));
  const ids:string[]=[],tokens=Array.from({length:4},(_,i)=>String(i+1).repeat(64));
  for(let i=0;i<4;i++){
   const wallet=`0x${String(i+1).repeat(40)}`;
   ids.push((await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`friend${i}`])).rows[0].id);
   await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash('sha256').update(tokens[i]).digest('hex'),wallet]);
   await pool.query('INSERT INTO charmville_yards(profile_id,grain) VALUES($1,$2)',[ids[i],i+10]);
   if(i)await pool.query("INSERT INTO charmville_admission_grants(profile_id,granted_by_profile_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[ids[i],ids[0]]);
  }
  const balances=async()=>(await pool.query('SELECT profile_id::text,grain FROM charmville_yards ORDER BY profile_id')).rows;
  const before=await balances();
  await Promise.all(tokens.map(token=>worldPresence(pool,token,{destination:'public',revision:'0'})));
  for(let i=0;i<4;i++){
   const state=await worldPresence(pool,tokens[i]);
   assert.equal(state.regionId,'public:meadow');
   assert.deepEqual(state.peers.map(p=>p.profileId).sort(),ids.filter(id=>id!==ids[i]).sort());
  }
  for(let i=1;i<4;i++)await homeAccess(pool,'friend0',tokens[0],parseHomeGrant({visitor:`friend${i}`,revoke:false,revision:'0',rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");
  await Promise.all(tokens.map(token=>worldPresence(pool,token,{destination:'home',handle:'friend0',revision:'1'})));
  for(const token of tokens){const state=await worldPresence(pool,token);assert.equal(state.regionId,`home:${ids[0]}`);assert.equal(state.peers.length,3);}
  await homeAccess(pool,'friend0',tokens[0],parseHomeGrant({visitor:'friend3',revoke:true,revision:'1'}));
  assert.equal((await worldPresence(pool,tokens[0])).peers.length,2);
  const revoked=await worldPresence(pool,tokens[3]);assert.equal(revoked.active,false);assert.equal(revoked.reason,'permission-revoked');
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");
  for(let i=1;i<4;i++){
   const state=await worldPresence(pool,tokens[i]);
   const home=await worldPresence(pool,tokens[i],{destination:'home',handle:`friend${i}`,revision:state.revision});
   assert.equal(home.regionId,`home:${ids[i]}`);assert.equal(home.peers.length,0);
  }
  assert.equal((await worldPresence(pool,tokens[0])).peers.length,0);
  assert.deepEqual(await balances(),before);
 } finally {
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  if(previousMode===undefined)delete process.env.CHARMVILLE_ACCESS_MODE;else process.env.CHARMVILLE_ACCESS_MODE=previousMode;
  if(previousWallets===undefined)delete process.env.CHARMVILLE_ALLOWED_WALLETS;else process.env.CHARMVILLE_ALLOWED_WALLETS=previousWallets;
 }
});

