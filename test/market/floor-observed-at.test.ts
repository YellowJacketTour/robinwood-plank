import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import {
  FLOOR_MISSES_TO_CLEAR,
  recordFloorSourceMiss,
  updateCollectionFloorOnly,
  updateCollectionSupplyFields,
  upsertTrackedCollection,
  writeSnapshot,
} from "../../lib/market/multichain/store";

/**
 * AUDIT lens 1 #8 / migration 102 (Batch E6), against the real local
 * Postgres: every floor write stamps floor_observed_at and resets
 * floor_miss_count; partial writers never bump floor_observed_at; two
 * consecutive misses from the source that owns the floor null it; a miss
 * from any other source is ignored.
 */
const CHAIN = "bitcoin-mainnet";

type Snap = {
  floor_price_wei: string | null;
  floor_price_marketplace: string | null;
  floor_observed_at: Date | null;
  floor_miss_count: number;
  synced_at: Date | null;
};
async function snap(id: number): Promise<Snap> {
  const r = await postgresQuery<Snap>(
    `SELECT floor_price_wei, floor_price_marketplace, floor_observed_at, floor_miss_count, synced_at FROM plank_multichain_snapshots WHERE collection_id = $1`,
    [id]
  );
  assert.ok(r.rows[0], "snapshot row must exist");
  return r.rows[0];
}
const ms = (d: Date | null) => (d ? new Date(d).getTime() : null);
async function seed(): Promise<{ id: number; address: string }> {
  const address = `zztest-floor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const id = await upsertTrackedCollection({ chainSlug: CHAIN, chainId: null, contractAddress: address, adapter: "test-floor" });
  return { id, address };
}
async function cleanup(id: number) {
  await postgresQuery(`DELETE FROM plank_collection_floor_observations WHERE collection_id = $1`, [id]);
  await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [id]);
  await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [id]);
}
const noFloor = { name: null, imageUrl: null, externalUrl: null, totalSupply: null, listedCount: null, floorPriceWei: null, floorPriceCurrency: null };

test(
  "writeSnapshot: a real floor stamps floor_observed_at; two consecutive misses from the owning source null it; other sources are ignored",
  { skip: !hasPostgresConfig() },
  async () => {
    assert.equal(FLOOR_MISSES_TO_CLEAR, 2);
    const { id } = await seed();
    try {
      await writeSnapshot(id, { ...noFloor, floorPriceWei: "1000", floorPriceCurrency: "BTC", floorPriceMarketplace: "bestinslot" });
      let s = await snap(id);
      assert.equal(s.floor_price_wei, "1000");
      assert.ok(s.floor_observed_at, "real floor must stamp floor_observed_at");
      assert.equal(s.floor_miss_count, 0);
      const observed1 = ms(s.floor_observed_at)!;

      // Miss from a source that does NOT own the floor: nothing changes.
      await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: "unisat", listedCount: 3 });
      s = await snap(id);
      assert.equal(s.floor_price_wei, "1000");
      assert.equal(s.floor_miss_count, 0, "a foreign source's miss says nothing about our floor");
      assert.equal(ms(s.floor_observed_at), observed1, "partial write must not bump floor_observed_at");

      // Null floor with no marketplace at all (DAS, supply-only adapter): ignored too.
      await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: null });
      s = await snap(id);
      assert.equal(s.floor_miss_count, 0);
      assert.equal(s.floor_price_wei, "1000");

      // First miss from the owning source: counted, floor kept.
      await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: "bestinslot" });
      s = await snap(id);
      assert.equal(s.floor_miss_count, 1);
      assert.equal(s.floor_price_wei, "1000", "one miss keeps the floor");
      assert.equal(ms(s.floor_observed_at), observed1);

      // Second consecutive miss: floor nulled.
      await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: "bestinslot" });
      s = await snap(id);
      assert.equal(s.floor_miss_count, 2);
      assert.equal(s.floor_price_wei, null, "second consecutive miss nulls the floor");
      assert.equal(s.floor_price_marketplace, null);

      // A real floor again resets the counter.
      await writeSnapshot(id, { ...noFloor, floorPriceWei: "2000", floorPriceCurrency: "BTC", floorPriceMarketplace: "bestinslot" });
      s = await snap(id);
      assert.equal(s.floor_price_wei, "2000");
      assert.equal(s.floor_miss_count, 0, "a real observation resets the miss counter");
      assert.ok(ms(s.floor_observed_at)! >= observed1);
    } finally {
      await cleanup(id);
    }
  }
);

test("a miss, then a real floor, then a miss never clears (misses must be consecutive)", { skip: !hasPostgresConfig() }, async () => {
  const { id } = await seed();
  try {
    await writeSnapshot(id, { ...noFloor, floorPriceWei: "1000", floorPriceCurrency: "BTC", floorPriceMarketplace: "magiceden" });
    await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: "magiceden" });
    assert.equal((await snap(id)).floor_miss_count, 1);
    await writeSnapshot(id, { ...noFloor, floorPriceWei: "1100", floorPriceCurrency: "BTC", floorPriceMarketplace: "magiceden" });
    assert.equal((await snap(id)).floor_miss_count, 0);
    await writeSnapshot(id, { ...noFloor, floorPriceMarketplace: "magiceden" });
    const s = await snap(id);
    assert.equal(s.floor_miss_count, 1);
    assert.equal(s.floor_price_wei, "1100");
  } finally {
    await cleanup(id);
  }
});

test(
  "updateCollectionFloorOnly stamps floor_observed_at + resets misses; updateCollectionSupplyFields bumps synced_at only; recordFloorSourceMiss clears on the second owning miss",
  { skip: !hasPostgresConfig() },
  async () => {
    const { id, address } = await seed();
    try {
      await updateCollectionFloorOnly(CHAIN, address, { floorPriceWei: "5000", floorPriceCurrency: "BTC", floorPriceMarketplace: "bestinslot" });
      let s = await snap(id);
      assert.equal(s.floor_price_wei, "5000");
      assert.ok(s.floor_observed_at, "floor-only writer must stamp floor_observed_at");
      assert.equal(s.floor_miss_count, 0);
      const observed = ms(s.floor_observed_at)!;

      await postgresQuery(`UPDATE plank_multichain_snapshots SET synced_at = NOW() - INTERVAL '1 day' WHERE collection_id = $1`, [id]);
      await updateCollectionSupplyFields(CHAIN, address, { listedCount: 7, totalSupply: 100 });
      s = await snap(id);
      assert.equal(ms(s.floor_observed_at), observed, "supply/holder writer must never bump floor_observed_at");
      assert.ok(s.synced_at && Date.now() - ms(s.synced_at)! < 60_000, "synced_at is bumped by the partial writer");

      // Miss from a non-owning marketplace: ignored.
      assert.deepEqual(await recordFloorSourceMiss(CHAIN, address, "okx"), { cleared: false, misses: 0 });
      assert.equal((await snap(id)).floor_miss_count, 0);

      let miss = await recordFloorSourceMiss(CHAIN, address, "bestinslot");
      assert.deepEqual(miss, { cleared: false, misses: 1 });
      assert.equal((await snap(id)).floor_price_wei, "5000");

      miss = await recordFloorSourceMiss(CHAIN, address, "bestinslot");
      assert.deepEqual(miss, { cleared: true, misses: 2 });
      s = await snap(id);
      assert.equal(s.floor_price_wei, null);
      assert.equal(s.floor_price_marketplace, null);

      // A currency-less floor from the floor-only writer is still stamped (must not depend on recordFloorObservation's currency guard).
      await updateCollectionFloorOnly(CHAIN, address, { floorPriceWei: "6000", floorPriceCurrency: null, floorPriceMarketplace: "bestinslot" });
      s = await snap(id);
      assert.equal(s.floor_price_wei, "6000");
      assert.equal(s.floor_miss_count, 0);
      assert.ok(ms(s.floor_observed_at)! >= observed);
    } finally {
      await cleanup(id);
    }
  }
);
