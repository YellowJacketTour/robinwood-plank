import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence,requireWorldHome,parseWorldEntry} from "../../lib/charmville/world-presence";
import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";
test("world destination rejects arbitrary regions and pose claims",()=>{
 assert.throws(()=>parseWorldEntry({destination:"galaxy",revision:"0"}));
 assert.throws(()=>parseWorldEntry({destination:"home",handle:"../admin",revision:"0"}));
 assert.deepEqual(parseWorldEntry({destination:"public",revision:"0",reward:999,pose:{x:1}}),{destination:"public",revision:"0"});
});
test("PostgreSQL world admission isolates homes, rejects stale travel, expires and revokes visitors",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString});const schema=`world_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const file of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,"utf8"));
  const ids:string[]=[];const tokens=["1".repeat(64),"2".repeat(64),"3".repeat(64)];
  for(let i=0;i<3;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`p${i}`]);ids.push(p.rows[0].id);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(tokens[i]).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[ids[i]]);}
  const own=await worldPresence(pool,tokens[0],{destination:"home",handle:"p0",revision:"0"});assert.equal(own.regionId,`home:${ids[0]}`);
  await assert.rejects(worldPresence(pool,tokens[1],{destination:"home",handle:"p0",revision:"0"}),/permission/);
  await homeAccess(pool,"p0",tokens[0],parseHomeGrant({visitor:"p1",revoke:false,revision:"0",rights:["visit","help"],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  let friend=await worldPresence(pool,tokens[1],{destination:"home",handle:"p0",revision:"0"});assert.equal(friend.peers[0].handle,"p0");
  assert.equal((await worldPresence(pool,tokens[2],{destination:"home",handle:"p2",revision:"0"})).peers.length,0);
  await assert.rejects(worldPresence(pool,tokens[1],{destination:"public",revision:"0"}),/changed/);
  await assert.rejects(worldPresence(pool,tokens[1],{destination:"public",revision:friend.revision}),/wait/);
  const action=async()=>{const c=await pool.connect();try{await c.query("BEGIN");await requireWorldHome(c,ids[1],ids[0],"help");await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}};
  await action();
  await homeAccess(pool,"p0",tokens[0],parseHomeGrant({visitor:"p1",revoke:true,revision:"1"}));
  await assert.rejects(action(),/permission/);
  assert.equal((await worldPresence(pool,tokens[0])).peers.length,0,"revoked visitors disappear before their next poll");
  friend=await worldPresence(pool,tokens[1]);assert.equal(friend.regionId,"public:meadow");assert.equal(friend.reason,"permission-revoked");assert.equal(friend.active,false);
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");
  const publicState=await worldPresence(pool,tokens[1],{destination:"public",revision:friend.revision});assert.equal(publicState.active,true);
  await pool.query("UPDATE charmville_world_presence SET expires_at=clock_timestamp()-interval '1 second'");
  assert.equal((await worldPresence(pool,tokens[0])).reason,"expired");
  await assert.rejects(action());
  await assert.rejects(worldPresence(pool,"invalid"));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
