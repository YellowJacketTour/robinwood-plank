import {test} from "node:test";import assert from "node:assert/strict";import {randomUUID,createHash} from "node:crypto";import {readFile} from "node:fs/promises";import {Pool} from "pg";
import {creatureRoster,parseRoster} from "../../lib/charmville/creature-roster";
test("roster requires six distinct slots",()=>{assert.throws(()=>parseRoster({revision:"0",slots:[]}));const id=randomUUID();assert.throws(()=>parseRoster({revision:"0",slots:[id,id,null,null,null,null]}));});
test("PostgreSQL roster preserves starter and supports six actually owned fixtures",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["localhost","127.0.0.1"].includes(new URL(connectionString).hostname));const admin=new Pool({connectionString});const schema=`roster_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","110_charmville_companions.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const ids:string[]=[];for(let i=1;i<=2;i++){const wallet=`0x${String(i).repeat(40)}`;const r=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`p${i}`]);ids.push(r.rows[0].id);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[ids[i-1]]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(String(i).repeat(64)).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);}
  const starter=randomUUID();await pool.query("INSERT INTO charmville_companions(id,owner_profile_id,source_species_id,nickname) VALUES($1,$2,277,'TREECKO')",[starter,ids[0]]);
  const migration=await readFile("deploy/inmotion/postgres/migrations/112_charmville_creature_roster.sql","utf8");await pool.query(migration);await pool.query(migration);
  for(const f of ['111_charmville_companion_following.sql','122_charmville_individual_following.sql'])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,'utf8'));
  const token="1".repeat(64);const first=await creatureRoster(pool,token);assert.equal(first.slots[0].id,starter);assert.equal(first.owned.length,1);assert.equal(first.slots.filter(Boolean).length,1);assert.equal((await creatureRoster(pool,"2".repeat(64))).owned.length,0);
  const secondStarter=randomUUID();await pool.query("INSERT INTO charmville_companions(id,owner_profile_id,source_species_id,nickname) VALUES($1,$2,280,'TORCHIC')",[secondStarter,ids[1]]);
  const second=await creatureRoster(pool,"2".repeat(64));assert.equal(second.slots[0].id,secondStarter,"first import fills previously empty initial roster");
  await creatureRoster(pool,"2".repeat(64),{revision:second.revision,slots:[null,null,null,null,null,null]});
  assert.equal((await creatureRoster(pool,"2".repeat(64))).slots.filter(Boolean).length,0);
  const roster=[starter];for(let i=0;i<5;i++){const id=randomUUID();roster.push(id);await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,$3,'fixture','capture')",[id,ids[0],i+1]);}
  const command={revision:first.revision,slots:roster};const full=await creatureRoster(pool,token,command);assert.equal(full.slots.filter(Boolean).length,6);assert.deepEqual(await creatureRoster(pool,token,command),full);
  await assert.rejects(creatureRoster(pool,"2".repeat(64),{revision:"1",slots:roster}),/own/);
  await assert.rejects(creatureRoster(pool,token,{revision:"0",slots:[null,null,null,null,null,null]}),/changed/);
  const following=await creatureRoster(pool,token,{action:'following',revision:full.revision,creatureId:roster[1],following:true});
  assert.equal(following.slots[1].following,true);assert.equal(following.slots[0].following,false);assert.equal(following.owned.filter(e=>e.following).length,1);
  assert.deepEqual(await creatureRoster(pool,token,{action:'following',revision:full.revision,creatureId:roster[1],following:true}),following);
  await assert.rejects(creatureRoster(pool,token,{action:'following',revision:full.revision,creatureId:roster[2],following:true}),/changed/);
  await assert.rejects(creatureRoster(pool,"2".repeat(64),{action:'following',revision:'1',creatureId:roster[1],following:false}),/own/);
  assert.equal((await creatureRoster(pool,token)).slots[1].following,true);
  await pool.query('UPDATE charmville_companions SET following=true WHERE id=$1',[starter]);
  const legacy=await creatureRoster(pool,token);assert.equal(legacy.slots[0].following,true);assert.equal(legacy.slots[1].following,true);assert.equal(legacy.slots[2].following,false);
  const stopped=await creatureRoster(pool,token,{action:'following',creatureId:starter,following:false,revision:legacy.revision});assert.equal((await pool.query('SELECT following FROM charmville_companions WHERE id=$1',[starter])).rows[0].following,false);assert.equal(stopped.slots[1].following,true);
  await pool.query(await readFile('deploy/inmotion/postgres/migrations/122_charmville_individual_following.sql','utf8'));assert.equal((await creatureRoster(pool,token)).slots[1].following,true,'migration rerun preserves independent preference');
  const cleared=await creatureRoster(pool,token,{revision:stopped.revision,slots:[null,null,null,null,null,null]});assert.equal(cleared.owned.length,6);assert.equal((await creatureRoster(pool,token)).slots.filter(Boolean).length,0,"cleared roster is not repopulated by reads");
  assert.equal((await pool.query("SELECT count(*) FROM charmville_companions")).rows[0].count,"2");assert.equal((await pool.query("SELECT count(*) FROM charmville_creature_entities WHERE acquisition_kind='starter'")).rows[0].count,"2");
  await assert.rejects(pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,280,'bad','starter')",[randomUUID(),ids[0]]));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
