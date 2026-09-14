import assert from "node:assert/strict";
import test, { after } from "node:test";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { upsertTrackedCollection, writeSnapshot } from "../../lib/market/multichain/store";
import { observedFloorChanges24h, floorSubjectKey, type FloorSubject } from "../../lib/market/multichain/observed-floor-change";
import { floorChangeStatusFor, changeHoleKindFor } from "../../lib/market/multichain/window-activity";

const SKIP = { skip: !hasPostgresConfig() };

async function track(chainSlug: string, tag: string): Promise<{ id: number; key: string }> {
  const key = `zztest-${tag}-${chainSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = await upsertTrackedCollection({ chainSlug, chainId: null, contractAddress: key, adapter: "test" });
  return { id, key };
}
async function cleanup(ids: number[]) {
  await postgresQuery(`DELETE FROM plank_collection_floor_observations WHERE collection_id=ANY($1::bigint[])`, [ids]);
  await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id=ANY($1::bigint[])`, [ids]);
  await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=ANY($1::bigint[])`, [ids]);
}

test("a 24h change compares the displayed floor with the same venue/currency observation at least 24h old, across chains", SKIP, async () => {
  const ids: number[] = [];
  try {
    const subjects: FloorSubject[] = [];
    for (const chainSlug of ["eth-mainnet", "solana-mainnet", "bitcoin-mainnet"]) {
      const { id, key } = await track(chainSlug, "floor-history"); ids.push(id);
      await postgresQuery(`INSERT INTO plank_collection_floor_observations(collection_id,price_atomic,currency,marketplace,source,observed_at,observation_bucket) VALUES
        ($1,90,'NATIVE','venue','test',NOW()-INTERVAL '30 hours',NOW()-INTERVAL '30 hours'),
        ($1,100,'NATIVE','venue','test',NOW()-INTERVAL '24 hours 10 minutes',NOW()-INTERVAL '24 hours 10 minutes'),
        ($1,110,'NATIVE','venue','test',NOW()-INTERVAL '23 hours',NOW()-INTERVAL '23 hours'),
        ($1,1,'OTHER','venue','test',NOW()-INTERVAL '24 hours 5 minutes',NOW()-INTERVAL '24 hours 5 minutes'),
        ($1,2,'NATIVE','other-venue','test',NOW()-INTERVAL '24 hours 1 minute',NOW()-INTERVAL '24 hours 1 minute')`, [id]);
      subjects.push({ chainSlug, collectionKey: key, marketplace: "venue", currency: "NATIVE", currentPriceAtomic: "120" });
    }
    const result = await observedFloorChanges24h(subjects);
    assert.equal(result.size, 3);
    for (const subject of subjects) {
      const r = result.get(floorSubjectKey(subject))!;
      // The LATEST observation that is at least 24h old (100), not the oldest
      // (90) and not the 23h one (110); same venue and currency only.
      assert.equal(r.comparisonPriceAtomic, "100");
      assert.equal(r.changePct, 20);
      assert.equal(r.basis, "24h");
      assert.equal(r.currentPriceAtomic, "120", "the current endpoint is the displayed floor itself");
    }
    // The displayed floor is the current endpoint: a different displayed
    // floor gives a different, still-real change.
    const moved = await observedFloorChanges24h(subjects.map((s) => ({ ...s, currentPriceAtomic: "50" })));
    assert.equal(moved.get(floorSubjectKey(subjects[0]))?.changePct, -50);
    // No venue / no currency / no floor: nothing to compare, no row.
    assert.equal((await observedFloorChanges24h(subjects.map((s) => ({ ...s, marketplace: null })))).size, 0);
    assert.equal((await observedFloorChanges24h(subjects.map((s) => ({ ...s, currentPriceAtomic: null })))).size, 0);
    assert.equal((await observedFloorChanges24h(subjects.map((s) => ({ ...s, currentPriceAtomic: "0" })))).size, 0);
  } finally { await cleanup(ids); }
});

test("younger than 24h: the change closes instantly from the FIRST observation and says so", SKIP, async () => {
  const ids: number[] = [];
  try {
    const { id, key } = await track("eth-mainnet", "since-first"); ids.push(id);
    await postgresQuery(`INSERT INTO plank_collection_floor_observations(collection_id,price_atomic,currency,marketplace,source,observed_at,observation_bucket) VALUES
      ($1,200,'ETH','opensea','test',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '3 hours'),
      ($1,180,'ETH','opensea','test',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour')`, [id]);
    const subject = { chainSlug: "eth-mainnet", collectionKey: key, marketplace: "opensea", currency: "ETH", currentPriceAtomic: "150" };
    const r = (await observedFloorChanges24h([subject])).get(floorSubjectKey(subject))!;
    assert.ok(r, "a change exists after one observation, not after a day");
    assert.equal(r.basis, "first-observation");
    assert.equal(r.comparisonPriceAtomic, "200", "the EARLIEST observation, not the latest");
    assert.equal(r.changePct, -25);
    assert.ok(Date.parse(r.comparisonObservedAt) < Date.now() - 2.9 * 3600_000, "the span is the real one");
    assert.equal(floorChangeStatusFor(r, true), "observed-since-first");
    assert.equal(changeHoleKindFor({ floorChangeStatus: "observed-since-first", rawChangePct: 0, sales: 0 }), "none");

    // The moment a 24h-old observation exists, the basis flips to 24h -- and
    // the first-observation fallback never masks it.
    await postgresQuery(`INSERT INTO plank_collection_floor_observations(collection_id,price_atomic,currency,marketplace,source,observed_at,observation_bucket) VALUES
      ($1,100,'ETH','opensea','test',NOW()-INTERVAL '25 hours',NOW()-INTERVAL '25 hours')`, [id]);
    const day = (await observedFloorChanges24h([subject])).get(floorSubjectKey(subject))!;
    assert.equal(day.basis, "24h");
    assert.equal(day.comparisonPriceAtomic, "100");
    assert.equal(day.changePct, 50);
    assert.equal(floorChangeStatusFor(day, true), "observed-24h");
  } finally { await cleanup(ids); }
});

test("floorChangeStatusFor: collecting-baseline only when a floor exists with no observation at all", () => {
  assert.equal(floorChangeStatusFor(null, true), "collecting-baseline");
  assert.equal(floorChangeStatusFor(null, false), null);
  assert.equal(floorChangeStatusFor({ basis: "24h" }, true), "observed-24h");
  assert.equal(floorChangeStatusFor({ basis: "first-observation" }, true), "observed-since-first");
});

test("writeSnapshot records the floor it stored as an observation, in the same statement", SKIP, async () => {
  const ids: number[] = [];
  try {
    const { id } = await track("eth-mainnet", "write-observes"); ids.push(id);
    const base = { name: null, imageUrl: null, externalUrl: null, totalSupply: null, listedCount: 7, holderCount: null };
    await writeSnapshot(id, { ...base, floorPriceWei: "123000000000000000", floorPriceCurrency: "ETH", floorPriceMarketplace: "opensea" });
    let rows = await postgresQuery<{ price_atomic: string; currency: string; marketplace: string; source: string; listed_count: number }>(
      `SELECT price_atomic::text, currency, marketplace, source, listed_count FROM plank_collection_floor_observations WHERE collection_id=$1 ORDER BY observed_at`, [id]);
    assert.deepEqual(rows.rows, [{ price_atomic: "123000000000000000", currency: "ETH", marketplace: "opensea", source: "write-snapshot", listed_count: 7 }]);

    // The observation is of the floor AS STORED. A null floor from the same
    // venue is a miss, not a clear (first miss): the stored floor survives
    // and no new observation is written for a write that carried no floor.
    await writeSnapshot(id, { ...base, floorPriceWei: null, floorPriceCurrency: null, floorPriceMarketplace: "opensea" });
    rows = await postgresQuery(`SELECT price_atomic::text, currency, marketplace, source, listed_count FROM plank_collection_floor_observations WHERE collection_id=$1`, [id]);
    assert.equal(rows.rows.length, 1, "a floorless write records nothing");

    // A floor without units or venue is not an observation.
    const { id: anon } = await track("eth-mainnet", "write-anon"); ids.push(anon);
    await writeSnapshot(anon, { ...base, floorPriceWei: "5", floorPriceCurrency: null, floorPriceMarketplace: null });
    const none = await postgresQuery(`SELECT 1 FROM plank_collection_floor_observations WHERE collection_id=$1`, [anon]);
    assert.equal(none.rows.length, 0);

    // And the change closes from it right away: the next write, one minute
    // later in bucket terms, is comparable to the first.
    await postgresQuery(`UPDATE plank_collection_floor_observations SET observed_at=NOW()-INTERVAL '10 minutes', observation_bucket=date_trunc('minute', NOW()-INTERVAL '10 minutes') WHERE collection_id=$1`, [id]);
    await writeSnapshot(id, { ...base, floorPriceWei: "246000000000000000", floorPriceCurrency: "ETH", floorPriceMarketplace: "opensea" });
    const subject = { chainSlug: "eth-mainnet", collectionKey: (await postgresQuery<{ contract_address: string }>(`SELECT contract_address FROM plank_multichain_collections WHERE id=$1`, [id])).rows[0].contract_address, marketplace: "opensea", currency: "ETH", currentPriceAtomic: "246000000000000000" };
    const r = (await observedFloorChanges24h([subject])).get(floorSubjectKey(subject))!;
    assert.equal(r?.basis, "first-observation");
    assert.equal(r?.changePct, 100);
  } finally { await cleanup(ids); }
});

after(closePostgres);
