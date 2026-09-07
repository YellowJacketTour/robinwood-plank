import assert from "node:assert/strict";
import test from "node:test";
import { okxCredentialState, readOkxCollectionStats, readOkxOrdinalsListings } from "../../lib/market/multichain/discovery/bitcoin-okx-listings";
import {
  bestInSlotCredentialState,
  parseBestInSlotCollectionInfo,
  parseBestInSlotListings,
  readBestInSlotCollectionStats,
  readBestInSlotListings,
  runBestInSlotStatsLane,
  satsToPriceWei,
  verifyBestInSlotCredentials,
} from "../../lib/market/multichain/discovery/bitcoin-bestinslot";
import { summarizeLaneHealthByChain } from "../../lib/market/multichain/mesh/lane-health";

/**
 * E4-bitcoin: the OKX / BestInSlot readers must say `credential-missing`
 * (not "no listings") when keys are absent, and must never touch the
 * network in that state. The listings route copies these states verbatim
 * into bookCoverage.sources.
 */
const KEYS = ["OKX_API_KEY", "OKX_API_SECRET", "OKX_API_PASSPHRASE", "BESTINSLOT_API_KEY"] as const;

async function withoutKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network must not be touched without credentials");
  }) as typeof fetch;
  try {
    const out = await fn();
    assert.equal(fetches, 0, "no fetch may happen in credential-missing state");
    return out;
  } finally {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("OKX readers: missing any of key/secret/passphrase -> credential-missing, empty result, no network", async () => {
  await withoutKeys(async () => {
    assert.equal(okxCredentialState(), "credential-missing");
    assert.deepEqual(await readOkxOrdinalsListings("bitcoin-frogs", 10), { state: "credential-missing", listings: [] });
    assert.deepEqual(await readOkxCollectionStats("bitcoin-frogs"), { state: "credential-missing", stats: null });
  });
  assert.equal(okxCredentialState({ OKX_API_KEY: "k", OKX_API_SECRET: "s" } as NodeJS.ProcessEnv), "credential-missing", "passphrase alone missing is still missing");
  assert.equal(okxCredentialState({ OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_API_PASSPHRASE: "p" } as NodeJS.ProcessEnv), "ready");
});

test("BestInSlot readers + lane: no BESTINSLOT_API_KEY -> credential-missing everywhere, no network, lane is a clean no-op", async () => {
  await withoutKeys(async () => {
    assert.equal(bestInSlotCredentialState(), "credential-missing");
    assert.deepEqual(await readBestInSlotListings("bitcoin-frogs", 10), { state: "credential-missing", listings: [] });
    assert.deepEqual(await readBestInSlotCollectionStats("bitcoin-frogs"), { state: "credential-missing", stats: null });
    assert.deepEqual(await verifyBestInSlotCredentials(), { ok: false, state: "credential-missing" });
    const lane = await runBestInSlotStatsLane(5);
    assert.equal(lane.state, "credential-missing");
    assert.equal(lane.candidates, 0);
    assert.equal(lane.updated, 0);
  });
});

test("BestInSlot parsers: documented names first, variants second, nothing fabricated", () => {
  const info = parseBestInSlotCollectionInfo(
    { data: { name: "Bitcoin Frogs", supply: "10000", floor_price: 1_250_000, listed_count: 42, holder_count: 3_100, volume_24h: 5_000_000, sales_24h: 4 } },
    "bitcoin-frogs"
  );
  assert.ok(info);
  assert.equal(info.floorPriceSats, 1_250_000);
  assert.equal(info.totalSupply, 10_000);
  assert.equal(info.listedCount, 42);
  assert.equal(info.holderCount, 3_100);
  assert.equal(info.volume24hSats, 5_000_000);
  assert.equal(info.sales24h, 4);
  const zeroFloor = parseBestInSlotCollectionInfo({ name: "x", floor_price: 0, listed: 0 }, "x");
  assert.ok(zeroFloor);
  assert.equal(zeroFloor.floorPriceSats, null, "a 0 floor is unknown, never a real floor");
  assert.equal(zeroFloor.listedCount, 0, "0 listed is a real count");
  assert.equal(parseBestInSlotCollectionInfo({ data: {} }, "x"), null);
  assert.equal(parseBestInSlotCollectionInfo(null, "x"), null);
  assert.equal(parseBestInSlotCollectionInfo("nope", "x"), null);

  const listings = parseBestInSlotListings(
    {
      data: [
        { inscription_id: "abc0", price: 100, seller: "bc1qseller", marketplace: "unisat", inscription_number: 7 },
        { inscription_id: "abc1", price: 0 },
        { inscription_id: "", price: 50 },
        { inscriptionId: "abc2", priceSats: "75" },
        { inscription_id: "abc3", price: 10 },
      ],
    },
    2
  );
  assert.deepEqual(
    listings.map((l) => l.inscriptionId),
    ["abc0", "abc2"],
    "zero price / empty id dropped; limit honored"
  );
  assert.equal(listings[0].marketplace, "unisat");
  assert.equal(listings[0].inscriptionNumber, 7);
  assert.equal(listings[1].priceSats, 75);
  assert.deepEqual(parseBestInSlotListings({ listings: [] }, 5), []);
  assert.equal(satsToPriceWei(1), "10000000000");
  assert.equal(satsToPriceWei(100_000_000), "1000000000000000000", "1 BTC = 1e18 atomic");
});

test("summarizeLaneHealthByChain: banner-worthy lanes report down/since honestly; never-claimed lanes are not 'down since'", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const out = summarizeLaneHealthByChain(
    [
      { laneKey: "bestinslot-stats:bitcoin-mainnet", lastClaimAt: iso(60_000), lastSuccessAt: null, status: "backoff" },
      { laneKey: "magiceden-alias:solana-mainnet", lastClaimAt: iso(60_000), lastSuccessAt: iso(5 * 3_600_000), status: "ok" },
      { laneKey: "magiceden-catalog:solana-mainnet", lastClaimAt: iso(60_000), lastSuccessAt: iso(60_000), status: "ok" },
      { laneKey: "helius-discovery:solana-mainnet", lastClaimAt: null, lastSuccessAt: null, status: "ok" },
      { laneKey: "seaport-fills:eth-mainnet", lastClaimAt: iso(60_000), lastSuccessAt: null, status: "backoff" },
    ],
    { now }
  );
  assert.deepEqual(
    out["bitcoin-mainnet"].down.map((d) => [d.source, d.reason]),
    [["bestinslot-stats", "backoff"]]
  );
  assert.deepEqual(
    out["solana-mainnet"].down.map((d) => [d.source, d.reason]),
    [["magiceden-alias", "no-success"]]
  );
  assert.equal(out["solana-mainnet"].lanes.length, 3, "never-claimed lanes are listed but never reported down");
  assert.equal(out["eth-mainnet"], undefined, "fill lanes are not banner sources");
});
