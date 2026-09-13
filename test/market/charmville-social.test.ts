import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { charmSocial, parseSocialPin } from "../../lib/charmville/social";

test("social pins accept only explicit Oran identity and stable IDs", () => {
  const pin={face:"oran-berry",postId:"42",requestId:randomUUID()};
  assert.deepEqual(parseSocialPin(pin),pin);
  for (const bad of [null,{}, {...pin,face:"stalk"},{...pin,postId:"-1"},{...pin,requestId:"retry"}])
    assert.throws(()=>parseSocialPin(bad));
});

test("Oran pins conserve custody, replay safely, reject blocks and serialize last-item races",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
  const url=new URL(process.env.CHARMVILLE_TEST_DATABASE_URL!);
  assert.ok(["localhost","127.0.0.1"].includes(url.hostname));
  const admin=new Pool({connectionString:url.href});
  const schema=`social_test_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:6});
  try {
    for(const file of ["090_plankspace_native.sql","116_charmville_soil.sql","143_charmville_oran_social.sql"])
      await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`,"utf8"));
    await pool.query("ALTER TABLE charmville_stacks DROP CONSTRAINT charmville_stacks_face_id_check");
    const token="c".repeat(64),wallet="0x"+"c".repeat(40),other="0x"+"d".repeat(40);
    const actor=(await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'pin_sender','Sender','approved') RETURNING id",[wallet])).rows[0].id;
    await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'pin_friend','Friend','approved')",[other]);
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(token).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);
    await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[actor]);
    await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',2)",[actor]);
    const postId=(await pool.query("INSERT INTO plankspace_posts(author_wallet,body) VALUES($1,'A friend’s harvest') RETURNING id::text",[other])).rows[0].id;
    const pin={face:"oran-berry",postId,requestId:randomUUID()};
    const result=await charmSocial(pool,token,pin);
    assert.deepEqual(await charmSocial(pool,token,pin),result);
    await assert.rejects(charmSocial(pool,token,{...pin,postId:"999999"}),/already used/);
    const races=await Promise.allSettled([1,2].map(()=>charmSocial(pool,token,{...pin,requestId:randomUUID()})));
    assert.equal(races.filter(r=>r.status==="fulfilled").length,1);
    const total=(await pool.query("SELECT (SELECT qty FROM charmville_stacks WHERE profile_id=$1)+(SELECT sum(qty) FROM charmville_stamps WHERE profile_id=$1) AS total",[actor])).rows[0].total;
    assert.equal(String(total),"2");
    await pool.query("INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind) VALUES($1,'pin_sender','block')",[other]);
    await assert.rejects(charmSocial(pool,token,{...pin,requestId:randomUUID()}),/unavailable/);
    const feed=await charmSocial(pool,token);
    assert.ok("posts" in feed && !feed.posts.some((p:{id:string})=>p.id===postId));
    // Retrying an accepted receipt returns its own result, never writes again,
    // even if the post becomes unavailable afterwards.
    assert.deepEqual(await charmSocial(pool,token,pin),result);
    await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01'");
    await assert.rejects(charmSocial(pool,token,pin),/expired/);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
