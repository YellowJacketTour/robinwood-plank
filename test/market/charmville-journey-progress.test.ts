import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {journeyProgress} from '../../lib/charmville/journey-progress';

test('journey uses authenticated, committed own-home history and survives spending',{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(['localhost','127.0.0.1'].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema='journey_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const file of ['090_plankspace_native.sql','116_charmville_soil.sql','121_charmville_exchange.sql','122_charmville_companions.sql','126_charmville_native_resources.sql','141_charmville_native_crop_identity.sql','147_charmville_burning_heart_foundation.sql'])
   await pool.query(await readFile('deploy/inmotion/postgres/migrations/'+file,'utf8'));
  const tokens=['a'.repeat(64),'b'.repeat(64)],ids:string[]=[];
  for(let i=0;i<2;i++){
   const wallet='0x'+String(i+1).repeat(40);
   ids.push((await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,'journey'+i])).rows[0].id);
   await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash('sha256').update(tokens[i]).digest('hex'),wallet]);
   await pool.query('INSERT INTO charmville_yards(profile_id) VALUES($1)',[ids[i]]);
  }
  await assert.rejects(journeyProgress(pool,''),/Sign in/);
  assert.deepEqual(await journeyProgress(pool,tokens[0]),{version:1,completed:[]});
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',10)",[ids[0]]);
  assert.deepEqual((await journeyProgress(pool,tokens[0])).completed,[],'purchased inventory and implicit yard are not progress');
  const action=async(actor:string,region:string,kind:string,status='committed',yieldValue:unknown=null,crop='oran-berry')=>{
   await pool.query('INSERT INTO charmville_native_resources(region_id,bed_id) VALUES($1,0) ON CONFLICT DO NOTHING',[region]);
   await pool.query("INSERT INTO charmville_native_actions(profile_id,request_id,payload_hash,region_id,bed_id,kind,resource_revision,region_epoch,sequence,contact_at,expires_at,status,result,crop_id) VALUES($1,$2,'fixture',$3,0,$4,0,0,0,clock_timestamp(),clock_timestamp()+interval '1 minute',$5,$6::jsonb,$7)",[actor,randomUUID(),region,kind,status,JSON.stringify({yield:yieldValue}),crop]);
  };
  const home='home:'+ids[0];
  await action(ids[0],home,'plant','pending');
  await action(ids[0],home,'water','cancelled');
  await action(ids[1],home,'water');
  await action(ids[0],'home:'+ids[1],'harvest','committed',{face:'oran-berry',quantity:1});
  await action(ids[0],'public:meadow','till');
  for(const value of [null,{face:'oran-berry',quantity:0},{face:'oran-berry',quantity:'1'},{face:'stalk',quantity:1}])await action(ids[0],home,'harvest','committed',value);
  assert.deepEqual((await journeyProgress(pool,tokens[0])).completed,[],'pending, cancelled, foreign, helper and invalid yield excluded');
  await pool.query("INSERT INTO charmville_receipts(id,profile_id,action,request_id,payload_hash,actor_profile_id,actor_wallet,session_hash,result) VALUES($1,$2,'claim',$3,$4,$2,'test-only',$4,'{}')",[randomUUID(),ids[0],randomUUID(),'a'.repeat(64)]);
  await pool.query("INSERT INTO charmville_companions(id,owner_profile_id,source_species_id,nickname) VALUES($1,$2,277,'Partner')",[randomUUID(),ids[0]]);
  for(const kind of ['till','plant','water','harvest'])await action(ids[0],home,kind,'committed',kind==='harvest'?{face:'oran-berry',quantity:1}:null);
  const expected=['home.claimed','partner.chosen','home.soil.tilled','home.oran.planted','home.oran.watered','home.oran.harvested','home.crop.planted','home.crop.watered','home.crop.harvested'];
  assert.deepEqual((await journeyProgress(pool,tokens[0])).completed,expected);
  await pool.query('DELETE FROM charmville_stacks WHERE profile_id=$1',[ids[0]]);
  assert.deepEqual((await journeyProgress(pool,tokens[0])).completed,expected,'spending cannot erase accomplishments');
  assert.deepEqual((await journeyProgress(pool,tokens[1])).completed,[],'account switch isolates facts');
  const heartHome='home:'+ids[1];
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'burning-heart',10)",[ids[1]]);
  await action(ids[1],heartHome,'harvest','committed',{face:'oran-berry',quantity:1},'burning-heart');
  await action(ids[1],heartHome,'plant','pending',null,'burning-heart');
  assert.deepEqual((await journeyProgress(pool,tokens[1])).completed,[],'heart balance and mismatched yield do not count');
  for(const kind of ['plant','water','harvest'])await action(ids[1],heartHome,kind,'committed',kind==='harvest'?{face:'burning-heart',quantity:1}:null,'burning-heart');
  const heartExpected=['home.crop.planted','home.crop.watered','home.crop.harvested'];
  assert.deepEqual((await journeyProgress(pool,tokens[1])).completed,heartExpected,'heart lessons do not fabricate Oran lessons');
  await pool.query('DELETE FROM charmville_stacks WHERE profile_id=$1',[ids[1]]);
  assert.deepEqual((await journeyProgress(pool,tokens[1])).completed,heartExpected,'pinning the final heart cannot erase the lesson');
  await pool.query("UPDATE plankspace_wallet_sessions SET expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(journeyProgress(pool,tokens[0]),/expired/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
