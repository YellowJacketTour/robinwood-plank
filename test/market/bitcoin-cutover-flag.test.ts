import assert from "node:assert/strict";
import test from "node:test";
import {
  MESH_LANES,
  BITCOIN_CATALOG_LANES,
  activeMeshLanes,
  bitcoinHoseOwnsExistence,
} from "../../lib/market/multichain/mesh/matrix";

/**
 * Cutover step 3: the one flag that stops the Bitcoin catalog pagers.
 *
 * The order is not negotiable. Migration first, then the hose running on the
 * production database and surviving a restart, and ONLY THEN this flag. Set
 * it early and Bitcoin has no writer at all -- strictly worse than a pager
 * wasting turns, which is what the dead-zone fix already addressed.
 *
 * So the default matters as much as the behaviour: off unless someone
 * deliberately turns it on.
 */

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.AKASHA_HOSE_OWNS_BITCOIN;
  if (value === undefined) delete process.env.AKASHA_HOSE_OWNS_BITCOIN;
  else process.env.AKASHA_HOSE_OWNS_BITCOIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AKASHA_HOSE_OWNS_BITCOIN;
    else process.env.AKASHA_HOSE_OWNS_BITCOIN = prev;
  }
}

test("the flag is OFF unless explicitly set to 1", () => {
  withFlag(undefined, () => assert.equal(bitcoinHoseOwnsExistence(), false));
  withFlag("", () => assert.equal(bitcoinHoseOwnsExistence(), false));
  withFlag("0", () => assert.equal(bitcoinHoseOwnsExistence(), false));
  withFlag("true", () => assert.equal(bitcoinHoseOwnsExistence(), false, "only the literal 1 arms it"));
  withFlag("1", () => assert.equal(bitcoinHoseOwnsExistence(), true));
});

test("with the flag off, every lane runs exactly as before", () => {
  withFlag(undefined, () => {
    assert.equal(activeMeshLanes().length, MESH_LANES.length);
    assert.deepEqual(
      activeMeshLanes().map((l) => l.id),
      MESH_LANES.map((l) => l.id),
      "the default path must be byte-identical to today",
    );
  });
});

test("with the flag on, ONLY the Bitcoin catalog pagers stop", () => {
  withFlag("1", () => {
    const active = activeMeshLanes();
    const removed = MESH_LANES.filter((l) => !active.some((a) => a.id === l.id));

    assert.ok(removed.length > 0, "the flag must actually remove something");
    for (const lane of removed) {
      assert.equal(lane.chainSlug, "bitcoin-mainnet", `removed a non-Bitcoin lane: ${lane.id}`);
      assert.ok(
        BITCOIN_CATALOG_LANES.includes(lane.source),
        `removed a Bitcoin lane that is not a catalog pager: ${lane.id}`,
      );
    }
  });
});

test("rarity and metadata lanes keep running: the hose does not answer those yet", () => {
  withFlag("1", () => {
    const active = activeMeshLanes();
    const survivors = active.filter((l) => l.chainSlug === "bitcoin-mainnet");
    assert.ok(
      survivors.length > 0,
      "Bitcoin must not go dark: existence moves to the hose, everything else stays",
    );
    // Rarity is a different question from existence. Switching it off would
    // blank real cells for no gain.
    assert.ok(
      survivors.some((l) => l.cells.includes("rarity")),
      "a Bitcoin rarity lane must survive the cutover",
    );
  });
});

test("no other chain is touched", () => {
  withFlag("1", () => {
    const active = activeMeshLanes();
    const before = MESH_LANES.filter((l) => l.chainSlug !== "bitcoin-mainnet");
    const after = active.filter((l) => l.chainSlug !== "bitcoin-mainnet");
    assert.deepEqual(
      after.map((l) => l.id),
      before.map((l) => l.id),
      "one family at a time: Solana, EVM and Robinhood lanes are untouched",
    );
  });
});

test("the catalog set names real sources that exist in the matrix", () => {
  // A flag that filters on a typo removes nothing and reports success.
  for (const source of BITCOIN_CATALOG_LANES) {
    assert.ok(
      MESH_LANES.some((l) => l.source === source),
      `${source} is not a real lane source -- the filter would silently no-op`,
    );
  }
});
