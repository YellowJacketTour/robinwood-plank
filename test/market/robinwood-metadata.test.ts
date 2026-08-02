import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRobinwoodMetadataComplete,
  ROBINWOOD_SUPPLY,
  type RobinwoodMetadataEntry,
} from "../../lib/market/robinwood-metadata";

/**
 * Canonical IPFS-sourced RobinWood metadata store — pure-logic coverage.
 *
 * The bug this whole module exists to fix: Blockscout served a pre-reveal
 * stub — [{ trait_type: "Status", value: "Unrevealed" }] — for planks #1-180
 * long after reveal, and the old code judged "loaded" by attrs.length > 0,
 * which a Status-only stub satisfies. That let the stub become the
 * permanent, cached truth. isRobinwoodMetadataComplete is the guard against
 * that shipping again: it must reject any entry that doesn't carry a real
 * canonical trait (Base/Background/Holographic), stub or not.
 */

function entry(tokenId: number, overrides?: Partial<RobinwoodMetadataEntry>): RobinwoodMetadataEntry {
  return {
    tokenId,
    name: `Plank #${tokenId}`,
    description: "",
    imageUri: `ipfs://bafybeicid/${tokenId}.png`,
    attributes: [
      { trait_type: "Base", value: "Is This Art" },
      { trait_type: "Background", value: "Rare" },
      { trait_type: "Holographic", value: "No" },
    ],
    ...overrides,
  };
}

function fullMap(totalSupply: number, mutate?: (id: number, e: RobinwoodMetadataEntry) => RobinwoodMetadataEntry): Map<number, RobinwoodMetadataEntry> {
  const map = new Map<number, RobinwoodMetadataEntry>();
  for (let id = 1; id <= totalSupply; id += 1) {
    const e = entry(id);
    map.set(id, mutate ? mutate(id, e) : e);
  }
  return map;
}

test("robinwood-metadata: empty map is never complete", () => {
  assert.equal(isRobinwoodMetadataComplete(new Map(), 5), false);
});

test("robinwood-metadata: a small, fully-canonical map is complete", () => {
  const map = fullMap(5);
  assert.equal(isRobinwoodMetadataComplete(map, 5), true);
});

test("robinwood-metadata: a map missing any token id is incomplete", () => {
  const map = fullMap(5);
  map.delete(3);
  assert.equal(isRobinwoodMetadataComplete(map, 5), false);
});

test("robinwood-metadata: a pre-reveal Status-only stub is never treated as complete", () => {
  // This is the exact shape Blockscout served for planks #1-180: one real
  // attribute entry, non-empty, but not a canonical trait.
  const map = fullMap(5, (id, e) =>
    id === 2 ? { ...e, attributes: [{ trait_type: "Status", value: "Unrevealed" }] } : e
  );
  assert.equal(isRobinwoodMetadataComplete(map, 5), false);
});

test("robinwood-metadata: an entry with zero attributes is never treated as complete", () => {
  const map = fullMap(5, (id, e) => (id === 4 ? { ...e, attributes: [] } : e));
  assert.equal(isRobinwoodMetadataComplete(map, 5), false);
});

test("robinwood-metadata: one canonical trait present is enough (Base/Background/Holographic, not all three required)", () => {
  const map = fullMap(5, (id, e) =>
    id === 1 ? { ...e, attributes: [{ trait_type: "Base", value: "Is This Art" }] } : e
  );
  assert.equal(isRobinwoodMetadataComplete(map, 5), true);
});

test("ROBINWOOD_SUPPLY matches the fixed, fully-minted collection size", () => {
  assert.equal(ROBINWOOD_SUPPLY, 1542);
});
