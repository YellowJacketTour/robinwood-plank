import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mutateYard, readYard, type YardAction } from "../../lib/charmville/store";

test("Charmville PostgreSQL lifecycle, authorization, retries and races", { skip: !process.env.CHARMVILLE_TEST_DATABASE_URL }, async () => {
  const connectionString = process.env.CHARMVILLE_TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "Use an isolated local database");
  const admin = new Pool({ connectionString });
  const schema = `charmville_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await pool.query(await readFile("deploy/inmotion/postgres/migrations/090_plankspace_native.sql", "utf8"));
    const sql = await readFile("deploy/inmotion/postgres/migrations/104_charmville_soil.sql", "utf8");
    await pool.query(sql); await pool.query(sql);
    await pool.query(await readFile("deploy/inmotion/postgres/migrations/105_charmville_layout.sql","utf8"));
    const token = "a".repeat(64), otherToken = "b".repeat(64);
    const wallet = "0x" + "1".repeat(40), otherWallet = "0x" + "2".repeat(40);
    for (const [handle, key, session] of [["soil_owner",wallet,token],["soil_friend",otherWallet,otherToken]]) {
      await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved')", [key,handle]);
      await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)", [createHash("sha256").update(session).digest("hex"),key,new Date(Date.now()+3600000).toISOString()]);
    }
    const act = (a: Omit<YardAction,"requestId">, handle="soil_owner", session=token) => mutateYard(pool,handle,session,{...a,requestId:randomUUID()});
    const claim: YardAction = {action:"claim",requestId:randomUUID()};
    const claimed = await mutateYard(pool,"soil_owner",token,claim);
    assert.deepEqual(await mutateYard(pool,"soil_owner",token,claim), claimed);
    assert.equal(claimed.plots.length,6);
    assert.equal(claimed.plots.filter((p: {crop:string})=>p.crop==="stalk").length,2);
    assert.equal((await readYard(pool,"soil_owner")).inventory,null);
    await assert.rejects(act({action:"resolve",plotIndex:0,revision:"0"},"soil_owner",otherToken));
    const outcomes = await Promise.allSettled([act({action:"resolve",plotIndex:0,revision:"0"}),act({action:"resolve",plotIndex:0,revision:"0"})]);
    assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
    let state = await readYard(pool,"soil_owner",token);
    assert.equal(state.inventory!.faces[0].qty,"3");
    assert.equal(state.inventory!.seeds.find((s:{face:string})=>s.face==="stalk").qty,"3");
    await pool.query("UPDATE charmville_yards SET grain=0");
    await act({action:"plant",plotIndex:0,revision:"1",face:"stalk"});
    await assert.rejects(act({action:"plant",plotIndex:2,revision:"0",face:"splinter"}));
    state = await readYard(pool,"soil_owner",token);
    assert.equal(state.inventory!.seeds.find((s:{face:string})=>s.face==="splinter").qty,"1", "failed plant rolls seed debit back");
    await pool.query("UPDATE charmville_plots SET planted_at=planted_at-INTERVAL '60 hours',ripe_at=ripe_at-INTERVAL '60 hours',compost_after=compost_after-INTERVAL '60 hours' WHERE plot_index=0");
    const compost = await act({action:"resolve",plotIndex:0,revision:"2"});
    assert.equal(compost.action,"compost"); assert.equal(compost.qty,0);
    await act({action:"plant",plotIndex:0,revision:"3",face:"stalk"});
    await act({action:"claim"},"soil_friend",otherToken);
    await act({action:"tend",plotIndex:0,revision:"4"},"soil_owner",otherToken);
    await assert.rejects(act({action:"tend",plotIndex:0,revision:"4"},"soil_owner",otherToken));
    const post = await pool.query("INSERT INTO plankspace_posts(author_wallet,body) VALUES($1,'A pine from home') RETURNING id::text",[wallet]);
    await act({action:"stamp",postId:post.rows[0].id});
    assert.equal((await readYard(pool,"soil_owner",token)).inventory!.faces[0].qty,"2");
    await assert.rejects(pool.query("UPDATE charmville_seeds SET qty=-1"));
    await assert.rejects(pool.query("UPDATE charmville_plots SET tilled=false WHERE plot_index=0"));
    await assert.rejects(mutateYard(pool,"soil_owner",token,{...claim,action:"stamp",postId:post.rows[0].id}));
    const beforeLayout=await readYard(pool,"soil_owner",token);
    const moved=beforeLayout.decorations.map((item:{id:number;x:number;y:number})=>item.id===0?{...item,x:0,y:1}:item);
    const layout: YardAction={action:"layout",requestId:randomUUID(),revision:beforeLayout.layoutRevision,decorations:moved};
    const saved=await mutateYard(pool,"soil_owner",token,layout);
    assert.deepEqual(await mutateYard(pool,"soil_owner",token,layout),saved,"layout retry replays");
    assert.deepEqual(saved.inventory,beforeLayout.inventory,"scenery never changes balances");
    assert.deepEqual(saved.plots,beforeLayout.plots,"scenery never moves crops");
    await assert.rejects(act({action:"layout",revision:beforeLayout.layoutRevision,decorations:moved}),/another device/);
    await assert.rejects(act({action:"layout",revision:saved.layoutRevision,decorations:moved.map((item:{id:number;x:number;y:number})=>item.id===0?{...item,x:2,y:3}:item)}));
    await assert.rejects(act({action:"layout",revision:saved.layoutRevision,decorations:moved},"soil_owner",otherToken));
    assert.deepEqual((await readYard(pool,"soil_owner")).decorations,moved,"saved layout is public");
    await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01T00:00:00Z'");
    await assert.rejects(act({action:"resolve",plotIndex:1,revision:"0"}));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
