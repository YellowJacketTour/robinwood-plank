import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {acceptFamilySeeds,familyGiftStatus} from "../../lib/charmville/family-entitlement";
import {requireNativeCrop} from "../../lib/charmville/native-crops";

test("Heart definitions need explicit server activation; old callers remain Oran-only", async () => {
  assert.throws(() => requireNativeCrop("burning-heart"), /unavailable/);
  for (const id of ["toString","__proto__","", "BURNING-HEART"]) assert.throws(() => requireNativeCrop(id,{burningHeartEnabled:true}), /unavailable/);
  const heart=requireNativeCrop("burning-heart",{burningHeartEnabled:true});
  assert.equal(heart.growthSeconds,30); assert.equal(heart.produceFace,"burning-heart"); assert.ok(Object.isFrozen(heart));
  assert.equal(requireNativeCrop("oran-berry").seedFace,"oran-berry");
  await assert.rejects(acceptFamilySeeds({} as Pool,"irrelevant"), /not available/);
});

test("family source is atomic, replay-stable and separate from Oran custody", {skip:!process.env.CHARMVILLE_TEST_DATABASE_URL}, async () => {
  const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;
  assert.ok(["localhost","127.0.0.1"].includes(new URL(connectionString).hostname));
  const admin=new Pool({connectionString}), schema=`family_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
  const wallet=`0x${"3".repeat(40)}`, token="c".repeat(64);
  const oldMode=process.env.CHARMVILLE_ACCESS_MODE,oldWallets=process.env.CHARMVILLE_ADMIN_WALLETS;
  process.env.CHARMVILLE_ACCESS_MODE="private";process.env.CHARMVILLE_ADMIN_WALLETS=wallet;
  try {
    for(const file of ["090_plankspace_native.sql","116_charmville_soil.sql","121_charmville_exchange.sql","126_charmville_native_resources.sql","141_charmville_native_crop_identity.sql"])
      await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,"utf8"));
    const id=(await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'family_test','Family','approved') RETURNING id",[wallet])).rows[0].id;
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(token).digest("hex"),wallet]);
    await pool.query("INSERT INTO charmville_yards(profile_id,grain) VALUES($1,17)",[id]);
    await pool.query("INSERT INTO charmville_native_seed_grants(profile_id) VALUES($1)",[id]);
    await pool.query("INSERT INTO charmville_seeds(profile_id,face_id,qty) VALUES($1,'oran-berry',7)",[id]);
    await pool.query("INSERT INTO charmville_native_resources(region_id,bed_id,stage) VALUES('public:meadow',0,2)");
    await pool.query(await readFile("deploy/inmotion/postgres/migrations/147_charmville_burning_heart_foundation.sql","utf8"));
    assert.equal((await pool.query("SELECT crop_id FROM charmville_native_resources")).rows[0].crop_id,"oran-berry");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM charmville_family_entitlements")).rows[0].n,0);
    const unopened=await familyGiftStatus(pool,token);
    assert.deepEqual(await familyGiftStatus(pool,token),unopened);
    assert.equal(unopened.available&&unopened.accepted,false);
    assert.equal(unopened.available&&unopened.seeds,"0");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM charmville_family_entitlements")).rows[0].n,0);
    // Force the credit to fail after entitlement insertion: both must roll back.
    await pool.query("ALTER TABLE charmville_seeds ADD CONSTRAINT test_block_heart CHECK(face_id <> 'burning-heart')");
    await assert.rejects(acceptFamilySeeds(pool,token,{enabled:true}), /test_block_heart/);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM charmville_family_entitlements")).rows[0].n,0);
    await pool.query("ALTER TABLE charmville_seeds DROP CONSTRAINT test_block_heart");
    const results=await Promise.all(Array.from({length:8},()=>acceptFamilySeeds(pool,token,{enabled:true})));
    for(const result of results) assert.deepEqual(result,results[0]);
    assert.equal(results[0].seedQuantity,3);
    const opened=await familyGiftStatus(pool,token);
    assert.equal(opened.available&&opened.accepted,true);
    assert.equal(opened.available&&opened.acceptedAt,results[0].acceptedAt);
    assert.equal((await pool.query("SELECT qty::text FROM charmville_seeds WHERE face_id='burning-heart'")).rows[0].qty,"3");
    // Spending later cannot make a replay mint again or rewrite the source receipt.
    await pool.query("UPDATE charmville_seeds SET qty=0 WHERE face_id='burning-heart'");
    assert.deepEqual(await acceptFamilySeeds(pool,token,{enabled:true}),results[0]);
    assert.equal((await pool.query("SELECT qty::text FROM charmville_seeds WHERE face_id='burning-heart'")).rows[0].qty,"0");
    assert.equal((await pool.query("SELECT qty::text FROM charmville_seeds WHERE face_id='oran-berry'")).rows[0].qty,"7");
    assert.equal((await pool.query("SELECT grain::text FROM charmville_yards")).rows[0].grain,"17");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM charmville_native_seed_grants")).rows[0].n,1);
    await pool.query("UPDATE plankspace_wallet_sessions SET expires_at=clock_timestamp()-interval '1 second'");
    await assert.rejects(acceptFamilySeeds(pool,token,{enabled:true}),/expired/);
    await assert.rejects(familyGiftStatus(pool,token),/expired/);
  } finally {
    if(oldMode===undefined)delete process.env.CHARMVILLE_ACCESS_MODE;else process.env.CHARMVILLE_ACCESS_MODE=oldMode;
    if(oldWallets===undefined)delete process.env.CHARMVILLE_ADMIN_WALLETS;else process.env.CHARMVILLE_ADMIN_WALLETS=oldWallets;
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});

