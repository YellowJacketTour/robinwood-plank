import assert from "node:assert/strict";
import test from "node:test";

/**
 * salesStatsFromLedger (lib/market/chain-events.ts) is a direct SQL
 * aggregate — no pure logic to unit test in isolation beyond its
 * no-store-configured fail-safe path. The live query itself (MAX/SUM over
 * real rows, matching sales-catalog.ts's statsFromCatalog output shape) was
 * verified by hand against the real local Docker Postgres instance while
 * building this fix: inserted three synthetic sale rows (0.05, 0.11, 0.02
 * ETH), confirmed highestWei/highestTokenId picked the 0.11 row and
 * totalVolumeWei summed to 0.18 ETH, then deleted the synthetic rows.
 */

test("salesStatsFromLedger returns the empty shape when no Postgres store is configured", async () => {
  const originalHost = process.env.PGHOST;
  const originalConn = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  try {
    const { salesStatsFromLedger } = await import("../../lib/market/chain-events");
    const stats = await salesStatsFromLedger();
    assert.deepEqual(stats, {
      saleCount: 0,
      highestWei: null,
      highestTokenId: null,
      highestTxHash: null,
      highestPlatform: null,
      totalVolumeWei: null,
      royaltyPaidCount: 0,
    });
  } finally {
    if (originalHost !== undefined) process.env.PGHOST = originalHost;
    if (originalConn !== undefined) process.env.POSTGRES_URL = originalConn;
  }
});
