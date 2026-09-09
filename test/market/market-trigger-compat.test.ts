import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { hasPostgresConfig, postgresPool, closePostgres } from "../../lib/postgres";

// Exercise both actual trigger implementations on isolated copies of the schema.
// Forced legacy mode tests execution semantics on CI's modern PostgreSQL; it is
// not a claim that CI runs PostgreSQL 9.6. Production reports its numeric version.
test("notification and rank migrations preserve exact changes on modern and legacy trigger paths", { skip: !hasPostgresConfig() }, async () => {
  const writer = new Client(postgresPool().options);
  const listener = new Client(postgresPool().options);
  await writer.connect();
  await listener.connect();
  const tables = ["plank_collection_tokens", "plank_collection_token_projections", "plank_foreign_rarity",
    "plank_foreign_rarity_collections", "plank_collection_cells", "plank_market_live_orders",
    "plank_market_events", "plank_multichain_collections", "plank_multichain_snapshots", "plank_market_hub_rank"];
  const schema = `compat_${process.pid}_${Date.now()}`;
  const events: { changedRows: number; omittedScopes: number; scopes: {collectionKey: string}[] }[] = [];
  listener.on("notification", message => { if (message.channel === schema && message.payload) events.push(JSON.parse(message.payload)); });
  await listener.query(`LISTEN ${schema}`);
  const waitFor = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (events.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, count);
  };
  try {
    const version = Number((await writer.query("SHOW server_version_num")).rows[0].server_version_num);
    for (const legacy of version >= 100000 ? [false, true] : [true]) {
      await writer.query(`CREATE SCHEMA ${schema}`);
      await writer.query(`SET search_path TO ${schema}, public`);
      for (const table of tables) await writer.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
      for (const name of ["110_market_change_notifications.sql", "111_market_hub_rank_delivery.sql"]) {
        let sql = await readFile(`deploy/inmotion/postgres/migrations/${name}`, "utf8");
        if (legacy) sql = sql.replaceAll("current_setting('server_version_num')::integer >= 100000", "false");
        await writer.query(sql.replaceAll("'plank_market_changes'", `'${schema}'`));
      }
      events.length = 0;
      await writer.query("BEGIN");
      await writer.query("INSERT INTO plank_collection_tokens(chain_slug,collection_slug,token_id,source_observed_at) VALUES ('solana-mainnet','rollback','1',NOW())");
      await writer.query("ROLLBACK");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(events.length, 0);
      await writer.query("INSERT INTO plank_collection_tokens(chain_slug,collection_slug,token_id,source_observed_at) SELECT 'solana-mainnet','AbC', n::text,NOW() FROM generate_series(1,3) n");
      await waitFor(1);
      assert.equal(events[0]?.changedRows, 3);
      assert.deepEqual(events[0]?.scopes, [{chainSlug: "solana-mainnet", collectionKey: "AbC"}]);
      await writer.query("UPDATE plank_collection_tokens SET collection_slug='abc'");
      await waitFor(2);
      assert.equal(events[1]?.changedRows, 6, "both old and new row images counted");
      assert.equal(events[1]?.scopes.length, 2, "case-distinct identities preserved");
      await writer.query("INSERT INTO plank_collection_tokens(chain_slug,collection_slug,token_id,source_observed_at) VALUES ('solana-mainnet','abc','1',NOW()),('solana-mainnet','abc','4',NOW()) ON CONFLICT(chain_slug,collection_slug,token_id) DO UPDATE SET source_observed_at=NOW()");
      // Modern transition tables publish INSERT and UPDATE separately; legacy
      // accumulation combines the statement. Both must account for three images.
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(events.slice(2).reduce((sum, event) => sum + event.changedRows, 0), 3);
      const beforeOverflow = events.length;
      await writer.query("INSERT INTO plank_collection_tokens(chain_slug,collection_slug,token_id,source_observed_at) SELECT 'solana-mainnet','overflow-' || n::text,'1',NOW() FROM generate_series(1,33) n");
      await waitFor(beforeOverflow + 1);
      assert.equal(events.at(-1)?.changedRows, 33);
      assert.equal(events.at(-1)?.omittedScopes, 33);
      await writer.query("INSERT INTO plank_multichain_collections(chain_slug,contract_address,adapter) VALUES ('solana-mainnet','fresh','test')");
      const id = (await writer.query("SELECT id FROM plank_multichain_collections")).rows[0].id;
      assert.equal((await writer.query("SELECT count(*)::int AS n FROM plank_market_hub_rank")).rows[0].n, 1);
      await writer.query("INSERT INTO plank_multichain_snapshots(collection_id,floor_price_wei) VALUES ($1,100)", [id]);
      assert.equal((await writer.query("SELECT floor_price_wei::text AS p FROM plank_market_hub_rank")).rows[0].p, "100");
      await writer.query("DELETE FROM plank_multichain_snapshots");
      assert.equal((await writer.query("SELECT floor_price_wei FROM plank_market_hub_rank")).rows[0].floor_price_wei, null);
      await writer.query(`DROP SCHEMA ${schema} CASCADE`);
      // Empty notifications before exercising the other implementation.
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  } finally {
    await writer.query("ROLLBACK");
    await writer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await writer.end();
    await listener.end();
    await closePostgres();
  }
});

