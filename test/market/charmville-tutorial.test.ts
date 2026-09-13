import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {parseTutorialPreference, tutorialPreference} from "../../lib/charmville/tutorial";

test("tutorial preference accepts only an explicit boolean with no target account", () => {
 for (const raw of [null, [], {}, {completed: "true"}, {completed: true, profileId: "other"}]) assert.throws(() => parseTutorialPreference(raw));
 assert.deepEqual(parseTutorialPreference({completed: false}), {completed: false});
});

test("tutorial completion persists per authenticated account and replay changes no gameplay state", {skip: !process.env.CHARMVILLE_TEST_DATABASE_URL}, async () => {
 const connectionString = process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname));
 const admin = new Pool({connectionString});
 const schema = `tutorial_${randomUUID().replaceAll("-", "")}`;
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool = new Pool({connectionString, options: `-c search_path=${schema}`});
 try {
  for (const file of ["090_plankspace_native.sql", "128_charmville_tutorial.sql", "128_charmville_tutorial.sql"]) await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${file}`, "utf8"));
  for (let i = 1; i <= 2; i++) {
   const wallet = `0x${String(i).repeat(40)}`;
   await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved')", [wallet, `player${i}`]);
   await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)", [createHash("sha256").update(String(i).repeat(64)).digest("hex"), wallet, new Date(Date.now() + 3600000).toISOString()]);
  }
  const first = "1".repeat(64), second = "2".repeat(64);
  assert.deepEqual(await tutorialPreference(pool, first), {completed: false});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM charmville_tutorial_preferences")).rows[0].n, 0);
  assert.deepEqual(await tutorialPreference(pool, first, {completed: true}), {completed: true});
  assert.deepEqual(await tutorialPreference(pool, first), {completed: true});
  assert.deepEqual(await tutorialPreference(pool, second), {completed: false});
  const before = (await pool.query("SELECT updated_at::text FROM charmville_tutorial_preferences")).rows;
  await tutorialPreference(pool, first, {completed: true});
  assert.deepEqual((await pool.query("SELECT updated_at::text FROM charmville_tutorial_preferences")).rows, before);
  assert.deepEqual(await tutorialPreference(pool, first, {completed: false}), {completed: false});
  await assert.rejects(tutorialPreference(pool, "bad", {completed: true}));
  await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01T00:00:00Z'");
  await assert.rejects(tutorialPreference(pool, first, {completed: true}));
  assert.equal((await pool.query("SELECT completed FROM charmville_tutorial_preferences")).rows[0].completed, false);
 } finally {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
 }
});
