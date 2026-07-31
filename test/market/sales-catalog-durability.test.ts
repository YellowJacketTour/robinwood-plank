import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression tests for the reported "secondary NFT data isn't being displayed
 * or recorded" bug.
 *
 * Three independent faults combined to blank out Highest sale / volume /
 * sale history a week after the last manual seed:
 *   1. writeSalesCatalog set a 7-day TTL,
 *   2. readSalesCatalog had no rebuild-on-miss branch, and
 *   3. the only writer was a legacy seed script that wrote to a datastore the
 *      app no longer reads.
 *
 * These pin 1 and 2. Fault 3 was fixed by deleting those scripts outright;
 * scripts/refresh-market-data.ts writes through the same durable-kv the app
 * reads, so it cannot drift that way again.
 */

type SetCall = { key: string; value: unknown; options?: { ex?: number } };

function loadCatalog(store: Map<string, unknown>, setCalls: SetCall[]) {
  // PostgreSQL is the only datastore. These env vars satisfy the config check;
  // the durableKv methods are replaced below, so no server is contacted.
  process.env.DURABLE_KV_BACKEND = "postgres";
  process.env.PGHOST = "durability-test.invalid";
  process.env.PGDATABASE = "durability-test";
  process.env.PGUSER = "durability-test";
  process.env.PGPASSWORD = "durability-test";

  return async () => {
    const kvModule = await import("../../lib/market/durable-kv");
    const kv = kvModule.durableKv as unknown as Record<string, unknown>;
    kv.get = async (key: string) => store.get(key) ?? null;
    kv.set = async (key: string, value: unknown, options?: { ex?: number }) => {
      setCalls.push({ key, value, options });
      store.set(key, value);
      return "OK";
    };
    return import("../../lib/market/sales-catalog");
  };
}

test("the sales catalog is stored without a TTL", async () => {
  const store = new Map<string, unknown>();
  const setCalls: SetCall[] = [];
  const { writeSalesCatalog, SALES_KV_KEY } = await loadCatalog(store, setCalls)();

  await writeSalesCatalog({
    version: 2,
    sales: [
      {
        txHash: `0x${"1".repeat(64)}`,
        tokenId: "1467",
        priceWei: "33333333333333333",
        royaltyWei: "2700000000000000",
        platform: "seaport",
        timestamp: null,
        blockNumber: 23_808_181,
      },
    ],
    updatedAt: 1,
  });

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].key, SALES_KV_KEY);
  // An `ex` here is the bug: it silently blanks every sale surface on expiry,
  // with nothing in the request path to rebuild it.
  assert.equal(
    setCalls[0].options?.ex,
    undefined,
    "sales catalog must not be written with a TTL"
  );
});

test("a stored catalog is served without touching upstream", async () => {
  const store = new Map<string, unknown>();
  const setCalls: SetCall[] = [];
  const { readSalesCatalog, SALES_KV_KEY } = await loadCatalog(store, setCalls)();

  store.set(SALES_KV_KEY, {
    version: 2,
    updatedAt: 1,
    sales: [
      {
        txHash: `0x${"2".repeat(64)}`,
        tokenId: "7",
        priceWei: "1000000000000000000",
        royaltyWei: "81000000000000000",
        platform: "seaport",
        timestamp: null,
        blockNumber: 100,
      },
    ],
  });

  const catalog = await readSalesCatalog();
  assert.equal(catalog?.sales.length, 1);
  assert.equal(catalog?.sales[0].tokenId, "7");
  assert.equal(setCalls.length, 0, "a cache hit must not rewrite the catalog");
});

test("a short rebuild cannot delete sales the stored catalog already has", async () => {
  const { mergeSalesCatalogs } = await loadCatalog(new Map(), [])();

  const sale = (tokenId: string, priceWei: string, timestamp: string | null = null) => ({
    txHash: `0x${tokenId.padStart(64, "0")}`,
    tokenId,
    priceWei,
    royaltyWei: "0",
    platform: "seaport",
    timestamp,
    blockNumber: Number(tokenId),
  });

  const stored = {
    version: 2 as const,
    updatedAt: 1,
    sales: [sale("3", "3000000000000000000"), sale("2", "2000000000000000000"), sale("1", "1000000000000000000")],
  };
  // Blockscout 500'd partway, so this walk only saw one old sale and one new one.
  const partialRebuild = {
    version: 2 as const,
    updatedAt: 2,
    sales: [sale("4", "4000000000000000000"), sale("1", "1000000000000000000")],
  };

  const merged = mergeSalesCatalogs(stored, partialRebuild);

  assert.equal(merged.sales.length, 4, "no stored sale may be dropped");
  assert.deepEqual(
    merged.sales.map((s) => s.tokenId),
    ["4", "3", "2", "1"],
    "sorted by price, highest first"
  );
});

test("merging prefers the record that carries a timestamp", async () => {
  const { mergeSalesCatalogs } = await loadCatalog(new Map(), [])();
  const base = {
    txHash: `0x${"a".repeat(64)}`,
    tokenId: "9",
    priceWei: "1000000000000000000",
    royaltyWei: "0",
    platform: "seaport",
    blockNumber: 5,
  };

  const merged = mergeSalesCatalogs(
    { version: 2, updatedAt: 1, sales: [{ ...base, timestamp: null }] },
    { version: 2, updatedAt: 2, sales: [{ ...base, timestamp: "2026-07-31T02:11:36Z" }] }
  );

  assert.equal(merged.sales.length, 1, "same tx+token is one sale");
  assert.equal(merged.sales[0].timestamp, "2026-07-31T02:11:36Z");
});

test("statsFromCatalog reports nothing rather than guessing when empty", async () => {
  const { statsFromCatalog } = await loadCatalog(new Map(), [])();

  const empty = statsFromCatalog(null);
  assert.equal(empty.saleCount, 0);
  assert.equal(empty.highestWei, null);
  assert.equal(empty.totalVolumeWei, null);

  const populated = statsFromCatalog({
    version: 2,
    updatedAt: 1,
    sales: [
      {
        txHash: `0x${"3".repeat(64)}`,
        tokenId: "1",
        priceWei: "2000000000000000000",
        royaltyWei: "162000000000000000",
        platform: "seaport",
        timestamp: null,
        blockNumber: 10,
      },
      {
        txHash: `0x${"4".repeat(64)}`,
        tokenId: "2",
        priceWei: "1000000000000000000",
        royaltyWei: "81000000000000000",
        platform: "seaport",
        timestamp: null,
        blockNumber: 11,
      },
    ],
  });
  assert.equal(populated.saleCount, 2);
  assert.equal(populated.highestWei, "2000000000000000000");
  assert.equal(populated.highestTokenId, "1");
  assert.equal(populated.totalVolumeWei, "3000000000000000000");
  assert.equal(populated.royaltyPaidCount, 2);
});
