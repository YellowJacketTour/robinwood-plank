import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {mutateYard,parseYardAction,readYard} from "../../lib/charmville/store";
import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";

test("in-game garden intents reuse server plot state, ignore reward claims and enforce helper access",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString});const schema=`intent_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","105_charmville_layout.sql","106_charmville_home_access.sql","107_charmville_grain_reserve.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  for(let i=1;i<=2;i++){const wallet=`0x${String(i).repeat(40)}`;await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved')",[wallet,`garden${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(String(i).repeat(64)).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);await mutateYard(pool,`garden${i}`,String(i).repeat(64),{action:"claim",requestId:randomUUID()});}
  const owner="1".repeat(64),helper="2".repeat(64);
  const initial=await readYard(pool,"garden1",owner);const plot=initial.plots[0];
  const intent=parseYardAction({action:"resolve",requestId:randomUUID(),plotIndex:plot.plotIndex,revision:plot.revision,quantity:999999,grain:999999,completedAt:0});
  assert.equal("quantity" in intent,false);assert.equal("grain" in intent,false);
  const result=await mutateYard(pool,"garden1",owner,intent);assert.equal(result.qty,3);assert.equal(result.inventory.grain,"3");assert.deepEqual(await mutateYard(pool,"garden1",owner,intent),result);
  await assert.rejects(mutateYard(pool,"garden1",owner,{...intent,requestId:randomUUID()}),/changed/);
  const updated=await readYard(pool,"garden1",owner);
  const plant=parseYardAction({action:"plant",requestId:randomUUID(),plotIndex:0,revision:updated.plots[0].revision,face:"stalk",ripeAt:"2000-01-01",growthSeconds:0});
  await mutateYard(pool,"garden1",owner,plant);
  const growing=await readYard(pool,"garden1",owner);assert.ok(Date.parse(growing.plots[0].ripeAt!)>Date.now()+3*3600000);
  await assert.rejects(mutateYard(pool,"garden1",owner,{action:"resolve",requestId:randomUUID(),plotIndex:0,revision:growing.plots[0].revision}),/growing/);
  const tend={action:"tend" as const,requestId:randomUUID(),plotIndex:0,revision:growing.plots[0].revision};
  await assert.rejects(mutateYard(pool,"garden1",helper,tend),/permission/);
  await homeAccess(pool,"garden1",owner,parseHomeGrant({visitor:"garden2",revoke:false,revision:"0",rights:["visit","help"],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  await homeAccess(pool,"garden1",owner,parseHomeGrant({visitor:"garden2",revoke:true,revision:"1"}));
  await assert.rejects(mutateYard(pool,"garden1",helper,tend),/permission/);
  const guest=await readYard(pool,"garden1",helper);assert.equal(guest.inventory,null);assert.equal(guest.compartments,null);
  const supply=await pool.query("SELECT (grain+COALESCE((SELECT sum(grain) FROM charmville_yards),0))::text AS total FROM charmville_grain_reserve WHERE id=1");assert.equal(supply.rows[0].total,"1000000");
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
