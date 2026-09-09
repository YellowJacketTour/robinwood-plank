import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mutateYard } from "../../lib/charmville/store";
import { readPineReputation } from "../../lib/charmville/reputation-store";
import { parsePineSearch, searchPineReputation } from "../../lib/charmville/reputation-search";

test("reputation reads real accepted receipts, deduplicates concurrent retries and excludes moderated pines", { skip: !process.env.CHARMVILLE_TEST_DATABASE_URL }, async () => {
  const connectionString = process.env.CHARMVILLE_TEST_DATABASE_URL!;
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname));
  const schema = `reputation_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    for (const name of ["090_plankspace_native.sql", "104_charmville_soil.sql", "105_charmville_layout.sql", "107_charmville_grain_reserve.sql"]) await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${name}`, "utf8"));
    const token = "c".repeat(64), wallet = "0x" + "3".repeat(40);
    await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'reputation_owner','Owner','approved')", [wallet]);
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)", [createHash("sha256").update(token).digest("hex"), wallet, new Date(Date.now() + 3600000).toISOString()]);
    await mutateYard(pool, "reputation_owner", token, { action: "claim", requestId: randomUUID() });
    await mutateYard(pool, "reputation_owner", token, { action: "resolve", plotIndex: 0, revision: "0", requestId: randomUUID() });
    const post = await pool.query("INSERT INTO plankspace_posts(author_wallet,body) VALUES($1,'Reputation fixture') RETURNING id::text", [wallet]);
    const id = post.rows[0].id;
    const stamp = { action: "stamp" as const, postId: id, requestId: randomUUID() };
    await Promise.all([mutateYard(pool, "reputation_owner", token, stamp), mutateYard(pool, "reputation_owner", token, stamp)]);
    await mutateYard(pool, "reputation_owner", token, { ...stamp, requestId: randomUUID() });
    const snapshot = await readPineReputation(pool, [id]);
    assert.deepEqual(snapshot.rows[0].counts.stalk, { current: { totals: "2", supporters: "1" }, lifetime: { totals: "2", supporters: "1" } });
    assert.equal(snapshot.coverage.removals, "not-implemented");
    assert.deepEqual((await readPineReputation(pool, [])).rows, []);
    const search = parsePineSearch(new URLSearchParams("minimum=2"));
    assert.deepEqual((await searchPineReputation(pool, search)).items.map(item => [item.id, item.count]), [[id, "2"]]);
    assert.equal((await searchPineReputation(pool, { ...search, metric: "supporters" })).matched, 0);
    assert.equal((await searchPineReputation(pool, { ...search, filter: { op: "all", children: [
      { op: "between", face: "stalk", basis: "current", metric: "totals", min: "2", max: "2" },
      { op: "not", child: { op: "eq", face: "stalk", basis: "lifetime", metric: "supporters", value: "2" } },
    ] } })).matched, 1, "nested rules evaluate accepted receipts in the content snapshot");
    assert.equal((await searchPineReputation(pool, { ...search, q: "%" })).matched, 0, "text search treats wildcard characters literally");
    const visitorWallet = "0x" + "4".repeat(40), visitorToken = "d".repeat(64);
    await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'reputation_visitor','Visitor','approved')", [visitorWallet]);
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)", [createHash("sha256").update(visitorToken).digest("hex"), visitorWallet, new Date(Date.now() + 3600000).toISOString()]);
    await pool.query("INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind) VALUES($1,'reputation_owner','block')", [visitorWallet]);
    assert.equal((await searchPineReputation(pool, search, visitorToken)).matched, 0, "viewer block is respected");
    await pool.query("DELETE FROM plankspace_profile_relations WHERE owner_wallet=$1", [visitorWallet]);
    await pool.query("INSERT INTO plankspace_profile_relations(owner_wallet,target_handle,kind) VALUES($1,'reputation_visitor','block')", [wallet]);
    assert.equal((await searchPineReputation(pool, search, visitorToken)).matched, 0, "author block is respected");
    await assert.rejects(searchPineReputation(pool, search, "f".repeat(64)), /Sign in again/);
    await pool.query("UPDATE plankspace_posts SET moderation_status='rejected' WHERE id=$1", [id]);
    assert.equal((await searchPineReputation(pool, search)).matched, 0);
    assert.deepEqual((await readPineReputation(pool, [id])).rows, []);
    assert.equal(snapshot.rows[0].counts.stalk.current.totals, "2", "materialized result is stable");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
