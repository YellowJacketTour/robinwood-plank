import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { readGameSession } from "../../lib/charmville/account-session";
import { createGameAccountClient } from "../../lib/charmville/account-client";

test("game account client never puts credentials in URLs and prevents redirects", async () => {
  const client = createGameAccountClient(async (input, init) => {
    assert.equal(input, "/api/charmville/session");
    assert.equal(init?.mode, "same-origin"); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json({ profileId: "1", handle: "owner", expiresAt: new Date().toISOString() });
  });
  assert.equal((await client.connect("a".repeat(64))).profileId, "1");
  await assert.rejects(client.connect("bad"));
});

test("game account client rejects delayed results after disconnect even if transport ignores abort", async () => {
  let complete!: (response: Response) => void;
  const client = createGameAccountClient(() => new Promise(resolve => { complete = resolve; }));
  const result = client.connect("a".repeat(64));
  client.disconnect();
  complete(Response.json({ profileId: "1", handle: "owner", expiresAt: new Date().toISOString() }));
  await assert.rejects(result, /Account changed/);
});

test("old account failure cannot invalidate a newer account response", async () => {
  const replies: Array<(response: Response) => void> = [];
  const client = createGameAccountClient(() => new Promise(resolve => { replies.push(resolve); }));
  const old = client.connect("a".repeat(64));
  const current = client.connect("b".repeat(64));
  const oldRejected = assert.rejects(old);
  replies[0](new Response(null, { status: 401 }));
  await oldRejected;
  replies[1](Response.json({ profileId: "2", handle: "friend", expiresAt: new Date().toISOString() }));
  assert.equal((await current).profileId, "2");
});

test("game identity resolves approved profile and rejects expired, revoked and unapproved sessions", { skip: !process.env.CHARMVILLE_TEST_DATABASE_URL }, async () => {
  const connectionString = process.env.CHARMVILLE_TEST_DATABASE_URL!;
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname));
  const admin = new Pool({ connectionString });
  const schema = `game_session_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await pool.query(await readFile("deploy/inmotion/postgres/migrations/090_plankspace_native.sql", "utf8"));
    const token = "c".repeat(64), wallet = "0x" + "4".repeat(40);
    const profile = await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'session_owner','Owner','approved') RETURNING id::text", [wallet]);
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)", [createHash("sha256").update(token).digest("hex"), wallet, new Date(Date.now() + 3600000).toISOString()]);
    assert.equal((await readGameSession(pool, token)).profileId, profile.rows[0].id);
    assert.deepEqual(Object.keys(await readGameSession(pool, token)).sort(), ["expiresAt", "handle", "profileId"]);
    await assert.rejects(readGameSession(pool, "bad"));
    await pool.query("UPDATE plankspace_profiles SET moderation_status='pending' WHERE wallet=$1", [wallet]);
    await assert.rejects(readGameSession(pool, token));
    await pool.query("UPDATE plankspace_profiles SET moderation_status='approved' WHERE wallet=$1", [wallet]);
    await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01T00:00:00Z' WHERE wallet=$1", [wallet]);
    await assert.rejects(readGameSession(pool, token));
    await pool.query("DELETE FROM plankspace_wallet_sessions WHERE wallet=$1", [wallet]);
    await assert.rejects(readGameSession(pool, token));
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
