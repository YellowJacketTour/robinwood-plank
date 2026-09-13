import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {exchangeCommand,parseExchangeCommand,readExchange} from '../../lib/charmville/exchange';
test('exchange quantities are exact bounded positive integers',()=>{
 for(const quantity of ['0','-1','1.1','1e3','1000001',1])assert.throws(()=>parseExchangeCommand({kind:'create',requestId:randomUUID(),side:'buy',face:'stalk',quantity,price:'1'}));
});
test('real PostgreSQL escrow preserves supply under partial fills, retries, races and cancellation',{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(['localhost','127.0.0.1'].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`exchange_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const file of ['090_plankspace_native.sql','104_charmville_soil.sql','109_charmville_exchange.sql'])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,'utf8'));
  const ids:string[]=[];
  for(let i=1;i<=3;i++){
   const wallet='0x'+String(i).repeat(40),token=String(i).repeat(64);
   const r=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`trader${i}`]);ids.push(r.rows[0].id);
   await pool.query('INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),wallet,new Date(Date.now()+3600000).toISOString()]);
   await pool.query('INSERT INTO charmville_yards(profile_id,grain) VALUES($1,100)',[ids[i-1]]);
   await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'stalk',10)",[ids[i-1]]);
  }
  await pool.query(await readFile('deploy/inmotion/postgres/migrations/107_charmville_grain_reserve.sql','utf8'));
  const supply=async()=>{const r=await pool.query(`SELECT
   ((SELECT sum(grain) FROM charmville_yards)+COALESCE((SELECT sum(price*remaining) FROM charmville_offers WHERE side='buy' AND state='open'),0))::text AS grain,
   ((SELECT sum(qty) FROM charmville_stacks)+COALESCE((SELECT sum(remaining) FROM charmville_offers WHERE side='sell' AND state='open'),0))::text AS charms`);assert.deepEqual(r.rows[0],{grain:'300',charms:'30'});};
  const command=(who:number,input:Record<string,unknown>)=>exchangeCommand(pool,String(who).repeat(64),{requestId:randomUUID(),...input});
  const create={kind:'create',side:'sell',face:'stalk',price:'2',quantity:'5',requestId:randomUUID()};
  const offered=await command(1,create);assert.deepEqual(await command(1,create),offered);await supply();
  await assert.rejects(command(1,{kind:'fill',offerId:offered.offerId,quantity:'1'}));
  const fill={kind:'fill',offerId:offered.offerId,quantity:'2',requestId:randomUUID()};
  const filled=await command(2,fill);assert.deepEqual(await command(2,fill),filled);await supply();
  assert.equal((await readExchange(pool)).offers[0].remaining,'3');
  const races=await Promise.allSettled([command(2,{kind:'fill',offerId:offered.offerId,quantity:'3'}),command(3,{kind:'fill',offerId:offered.offerId,quantity:'3'})]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);await supply();
  const buy=await command(2,{kind:'create',side:'buy',face:'stalk',price:'3',quantity:'4'});await supply();
  const reported=(await readExchange(pool)).grainSupply;
  assert.equal(reported.escrow,'12');
  assert.equal(BigInt(reported.reserve)+BigInt(reported.circulating)+BigInt(reported.escrow),BigInt(reported.openingSupply));
  await command(1,{kind:'fill',offerId:buy.offerId,quantity:'1'});await supply();
  await assert.rejects(command(3,{kind:'cancel',offerId:buy.offerId}),/owner/);
  const cancel={kind:'cancel',offerId:buy.offerId,requestId:randomUUID()};
  const cancelled=await command(2,cancel);assert.deepEqual(await command(2,cancel),cancelled);await supply();
  await assert.rejects(command(3,{kind:'create',side:'buy',face:'stalk',price:'1000',quantity:'1'}));await supply();
  assert.equal((await readExchange(pool)).offers.length,0);
  await assert.rejects(command(1,{...create,price:'9'}),/already used/);
  await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01T00:00:00Z'");await assert.rejects(command(1,create),/Sign in/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
