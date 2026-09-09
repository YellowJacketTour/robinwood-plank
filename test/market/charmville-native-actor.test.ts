import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {nativeActor,actorGeometry} from "../../lib/charmville/native-actor";
import {worldPresence} from "../../lib/charmville/world-presence";
import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";
test("persistent movement isolates identities, replays, collision, renewal and region admission",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","113_charmville_native_actor.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}
  const a=await nativeActor(pool,tokens[0]),b=await nativeActor(pool,tokens[1]);assert.notEqual(a.profileId,b.profileId);assert.deepEqual((await nativeActor(pool,tokens[0])).peers?.map(p=>p.profileId),[b.profileId]);
  const next=[{x:a.cell.x+1,y:a.cell.y},{x:a.cell.x-1,y:a.cell.y},{x:a.cell.x,y:a.cell.y+1},{x:a.cell.x,y:a.cell.y-1}].find(p=>p.x>=0&&p.y>=0&&!actorGeometry.blocked.has(`${p.x},${p.y}`))!;assert.ok(next);
  const move={...next,sequence:1,regionEpoch:a.regionEpoch,presenceRevision:a.presenceRevision,geometryId:a.geometryId};
  await pool.query("UPDATE charmville_native_actors SET last_move_at=last_move_at-1000");
  const results=await Promise.all([nativeActor(pool,tokens[0],move),nativeActor(pool,tokens[0],move)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].version,1);assert.deepEqual((await nativeActor(pool,tokens[1])).cell,b.cell);
  await assert.rejects(nativeActor(pool,tokens[0],{...move,sequence:2,x:0,y:0}),/Blocked/);
  await assert.rejects(nativeActor(pool,tokens[0],{...move,geometryId:"invented"}),/Unsupported/);
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");
  const renewed=await worldPresence(pool,tokens[0],{destination:"public",revision:a.presenceRevision});const after=await nativeActor(pool,tokens[0]);assert.equal(after.regionEpoch,a.regionEpoch);assert.deepEqual(after.cell,next);
  await assert.rejects(nativeActor(pool,tokens[0],move),/admission changed/);
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");await worldPresence(pool,tokens[0],{destination:"home",handle:"p0",revision:renewed.revision});const home=await nativeActor(pool,tokens[0]);assert.equal(home.regionEpoch,a.regionEpoch+1);assert.equal(home.sequence,0);assert.deepEqual(home.cell,a.cell);
  assert.deepEqual(home.peers,[]);assert.deepEqual((await nativeActor(pool,tokens[1])).peers,[]);
  await homeAccess(pool,"p0",tokens[0],parseHomeGrant({visitor:"p1",revision:"0",revoke:false,rights:["visit"],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  await worldPresence(pool,tokens[1],{destination:"home",handle:"p0",revision:b.presenceRevision});await nativeActor(pool,tokens[1]);
  assert.equal((await nativeActor(pool,tokens[0])).peers?.[0].handle,"p1");
  await pool.query("UPDATE charmville_native_actors SET geometry_revision='old' WHERE profile_id=$1",[b.profileId]);assert.deepEqual((await nativeActor(pool,tokens[0])).peers,[]);await nativeActor(pool,tokens[1]);
  await homeAccess(pool,"p0",tokens[0],parseHomeGrant({visitor:"p1",revision:"1",revoke:true}));assert.deepEqual((await nativeActor(pool,tokens[0])).peers,[]);await assert.rejects(nativeActor(pool,tokens[1]),/permission/);
  await homeAccess(pool,"p0",tokens[0],parseHomeGrant({visitor:"p1",revision:"2",revoke:false,rights:["visit"],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  await pool.query("UPDATE charmville_world_presence SET expires_at=clock_timestamp()-interval '1 second' WHERE profile_id=$1",[b.profileId]);assert.deepEqual((await nativeActor(pool,tokens[0])).peers,[]);
  await pool.query("UPDATE charmville_world_presence SET expires_at=clock_timestamp()-interval '1 second'");await assert.rejects(nativeActor(pool,tokens[0]),/Enter the world/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

