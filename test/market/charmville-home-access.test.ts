import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {homeAccess,parseHomeGrant,requireHomeRight} from "../../lib/charmville/home-access-store";
test("home grant validation requires explicit scoped permissions",()=>{
 assert.throws(()=>parseHomeGrant({visitor:"friend",revoke:false,revision:"0",rights:["harvest"],expiresAt:new Date().toISOString()}));
 assert.throws(()=>parseHomeGrant({visitor:"friend",revoke:false,revision:"0",rights:["visit","storage"],containers:[],expiresAt:new Date().toISOString()}));
 assert.deepEqual(parseHomeGrant({visitor:"friend",revoke:true,revision:"1"}).rights,[]);
});
test("durable home permissions enforce owner, privacy, revision, expiry, revocation and container scope",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}); const schema=`home_${randomUUID().replaceAll("-","")}`;
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try {
  for(const file of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql"]) await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,"utf8"));
  await pool.query(await readFile("deploy/inmotion/postgres/migrations/106_charmville_home_access.sql","utf8"));
  const ids:string[]=[];
  for(let i=0;i<3;i++) {
   const wallet=`0x${String(i+1).repeat(40)}`,token=String(i+1).repeat(64);
   const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`player${i}`]);ids.push(p.rows[0].id);
   await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(token).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);
  }
  await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[ids[0]]);
  const owner="1".repeat(64),friend="2".repeat(64),stranger="3".repeat(64);
  const input=parseHomeGrant({visitor:"player1",revoke:false,revision:"0",rights:["visit","help","storage"],containers:["chest_a"],expiresAt:new Date(Date.now()+3600000).toISOString()});
  await assert.rejects(homeAccess(pool,"player0",friend,input),/Only the owner/);
  await homeAccess(pool,"player0",owner,input);
  assert.equal((await homeAccess(pool,"player0",stranger)).grants.length,0);
  assert.equal((await homeAccess(pool,"player0",friend)).grants.length,1);
  await assert.rejects(homeAccess(pool,"player0",owner,input),/changed/);
  const check=async(right:"visit"|"help"|"harvest"|"storage",container?:string)=>{
   const client=await pool.connect();try{await client.query("BEGIN");await requireHomeRight(client,ids[0],ids[1],right,container);await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  };
  await check("visit");await check("help");await check("storage","chest_a");
  await assert.rejects(check("storage","chest_b")); await assert.rejects(check("harvest"));
  await homeAccess(pool,"player0",owner,parseHomeGrant({visitor:"player1",revoke:true,revision:"1"}));
  await assert.rejects(check("visit"));
  await homeAccess(pool,"player0",owner,{...input,revision:"2"});
  await pool.query("UPDATE charmville_home_grants SET expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(check("visit"));
  assert.equal((await homeAccess(pool,"player0",friend)).grants[0].active,false);
  await assert.rejects(homeAccess(pool,"player0","bad"));
  await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01T00:00:00Z'");
  await assert.rejects(homeAccess(pool,"player0",owner));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
