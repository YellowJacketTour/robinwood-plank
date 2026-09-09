import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {companions,parseCompanionChoice,COMPANION_CHOICES} from "../../lib/charmville/companions";
test("starter species come from Emerald source IDs",()=>{assert.deepEqual(COMPANION_CHOICES.map(c=>c.speciesId),[277,280,283]);assert.throws(()=>parseCompanionChoice({speciesId:1}));});
test("PostgreSQL companion selection persists once, isolates owners and rejects replacement",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));const admin=new Pool({connectionString});const schema=`companion_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const file of ["090_plankspace_native.sql","104_charmville_soil.sql","110_charmville_companions.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,"utf8"));
  const ids:string[]=[];for(let i=1;i<=2;i++){const wallet=`0x${String(i).repeat(40)}`;const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`p${i}`]);ids.push(p.rows[0].id);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(String(i).repeat(64)).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);}
  const owner="1".repeat(64),other="2".repeat(64);assert.equal((await companions(pool,owner)).companion,null);await assert.rejects(companions(pool,owner,277),/Claim/);
  await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[ids[0]]);
  const results=await Promise.all([companions(pool,owner,277),companions(pool,owner,277)]);assert.equal(results[0].companion.id,results[1].companion.id);assert.equal(results[0].companion.sourceName,"TREECKO");
  assert.equal((await companions(pool,owner)).companion.id,results[0].companion.id);assert.equal((await companions(pool,other)).companion,null);await assert.rejects(companions(pool,owner,280),/already/);
  assert.equal((await pool.query("SELECT count(*) FROM charmville_companions")).rows[0].count,"1");await assert.rejects(companions(pool,"bad"));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
