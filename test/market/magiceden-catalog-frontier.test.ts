import assert from "node:assert/strict";
import test from "node:test";
import { durableKv } from "../../lib/market/durable-kv";
import { closePostgres, hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { runMagicEdenCatalogScan } from "../../lib/market/multichain/discovery/magiceden-catalog-scan";

const key = "plank:market:magiceden-catalog-scan-cursor";
test("catalog preserves completed pages and parks an incomplete provider frontier", { skip: !hasPostgresConfig() }, async () => {
  const previous = await durableKv.get(key);
  const originalFetch = globalThis.fetch;
  const symbol = `catalog-frontier-test-${process.pid}`;
  let requests = 0;
  try {
    await durableKv.set(key, { offset: 0, done: false });
    globalThis.fetch = async (input) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("limit"), "500");
      if (url.searchParams.get("offset") === "500") return new Response("unavailable", { status: 503 });
      return Response.json([{ symbol }, ...Array.from({ length: 499 }, () => ({}))]);
    };
    await assert.rejects(runMagicEdenCatalogScan({ maxPages: 2 }), /HTTP 503/);
    assert.equal((await durableKv.get<{ offset: number }>(key))?.offset, 500);
    assert.equal((await postgresQuery("SELECT 1 FROM plank_multichain_collections WHERE chain_slug='solana-mainnet' AND contract_address=$1", [symbol])).rowCount, 1);

    // A deployed 20-row cursor must revisit, not skip, the larger tail page.
    await durableKv.set(key, { offset: 30020, done: false });
    globalThis.fetch = async (input) => {
      requests++;
      const offset = new URL(String(input)).searchParams.get("offset");
      if (offset === "30000") return Response.json(Array.from({ length: 500 }, () => ({})), { headers: { "ME-Pub-API-Metadata": '{"paging":{"total":37941}}' } });
      assert.equal(offset, "30500");
      return Response.json({ msg: "offset and limit must be a multiple of 20, offset must be a multiple of the limit" }, { status: 400 });
    };
    const frontier = await runMagicEdenCatalogScan({ maxPages: 2 });
    assert.equal(frontier.done, false);
    assert.equal(frontier.pagesWalked, 1);
    assert.equal(frontier.advertisedTotal, 37941);
    assert.equal(frontier.blockedOffset, 30500);
    assert.ok(frontier.retryAt && frontier.retryAt > Date.now());
    const before = requests;
    const parked = await runMagicEdenCatalogScan();
    assert.equal(requests, before, "paused source must not hammer the rejected page");
    assert.equal(parked.done, false);
    const stored = await durableKv.get<Record<string, unknown>>(key);
    await durableKv.set(key, { ...stored, retryAt: Date.now() - 1 });
    globalThis.fetch = async (input) => {
      assert.equal(new URL(String(input)).searchParams.get("offset"), "0");
      return Response.json([]);
    };
    assert.equal((await runMagicEdenCatalogScan()).done, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous !== null) await durableKv.set(key, previous);
    else await postgresQuery("DELETE FROM plank_kv_values WHERE key_name=$1", [key]);
    await postgresQuery("DELETE FROM plank_multichain_collections WHERE chain_slug='solana-mainnet' AND contract_address=$1", [symbol]);
    await closePostgres();
  }
});
