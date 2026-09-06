import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionTypeSignals, detectCollectionType, traitFrequencyTable, rarerThanPercent, rarityCoverage, floorsByTier,
  computeUniversalRaritySnapshot,
} from "../../lib/rarity-universal";
import type { GenericRarityInput } from "../../lib/rarity-generic";

function generative(n: number): GenericRarityInput[] {
  const bgs = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
  return Array.from({ length: n }, (_, i) => ({
    tokenId: String(i),
    name: `#${i}`,
    traits: [
      { traitType: "Background", value: bgs[Math.min(4, Math.floor(Math.log2(1 + (i % 32))))] },
      { traitType: "Hat", value: `hat-${i % 7}` },
      { traitType: "Eyes", value: `eyes-${i % 11}` },
      { traitType: "Mouth", value: `mouth-${i % 13}` },
    ],
  }));
}

test("detectCollectionType: generative 10k-style", () => {
  const items = generative(400);
  assert.equal(detectCollectionType(collectionTypeSignals(items, { totalSupply: 400 })), "generative");
});

test("detectCollectionType: editions (few trait sets, many copies) and open edition (one set)", () => {
  const editions: GenericRarityInput[] = Array.from({ length: 300 }, (_, i) => ({ tokenId: String(i), name: null, traits: [{ traitType: "Edition", value: `ed-${i % 5}` }, { traitType: "Artist", value: "x" }] }));
  assert.equal(detectCollectionType(collectionTypeSignals(editions, { standard: "erc1155" })), "editions");
  const open: GenericRarityInput[] = Array.from({ length: 50 }, (_, i) => ({ tokenId: String(i), name: null, traits: [{ traitType: "Drop", value: "genesis" }] }));
  assert.equal(detectCollectionType(collectionTypeSignals(open)), "open-edition");
});

test("detectCollectionType: 1/1s (no traits) and large registries (ENS-like) and ordinals by standard", () => {
  const ones: GenericRarityInput[] = Array.from({ length: 40 }, (_, i) => ({ tokenId: String(i), name: `piece ${i}`, traits: [] }));
  assert.equal(detectCollectionType(collectionTypeSignals(ones)), "open-edition");
  const registry: GenericRarityInput[] = Array.from({ length: 2000 }, (_, i) => ({ tokenId: String(i), name: `${i}.eth`, traits: [{ traitType: "Length", value: String(3 + (i % 10)) }, { traitType: "Name", value: `${i}.eth` }] }));
  assert.equal(detectCollectionType(collectionTypeSignals(registry, { totalSupply: 2_500_000 })), "large-registry");
  assert.equal(detectCollectionType(collectionTypeSignals(generative(10), { standard: "ordinals" })), "ordinals");
});

test("traitFrequencyTable counts only scored trait types and sums to the sample", () => {
  const items = generative(140);
  const table = traitFrequencyTable(items);
  assert.ok(table.Hat);
  const total = Object.values(table.Hat).reduce((n: number, c) => n + c.count, 0);
  assert.equal(total, 140);
  assert.ok(Math.abs(Object.values(table.Hat).reduce((n: number, c) => n + c.frequency, 0) - 1) < 1e-9);
});

test("rarityCoverage: partial until sample == supply; unknown supply is partial, never 100%", () => {
  assert.deepEqual(rarityCoverage(500, 1000), { sampleSize: 500, totalSupply: 1000, coverage: 0.5, partial: true });
  assert.deepEqual(rarityCoverage(1000, 1000), { sampleSize: 1000, totalSupply: 1000, coverage: 1, partial: false });
  assert.equal(rarityCoverage(1000, null).partial, true);
  assert.equal(rarityCoverage(1000, null).coverage, null);
});

test("rarerThanPercent clamps and rounds", () => {
  assert.equal(rarerThanPercent(99.96), 100);
  assert.equal(rarerThanPercent(12.345), 12.3);
  assert.equal(rarerThanPercent(-3), 0);
});

test("floorsByTier: cheapest real listing per tier, dash for tiers with no listing (never 0)", () => {
  const rarity = new Map([["1", { tier: "Legendary" }], ["2", { tier: "Common" }], ["3", { tier: "Common" }]]);
  const floors = floorsByTier(rarity, [{ tokenId: "1", priceWei: "5000" }, { tokenId: "2", priceWei: "900" }, { tokenId: "3", priceWei: "700" }, { tokenId: "9", priceWei: "1" }]);
  const byTier: Record<string, { floorWei: string | null; listed: number }> = Object.fromEntries(floors.map((f) => [f.tier, f]));
  assert.equal(byTier.Legendary.floorWei, "5000");
  assert.equal(byTier.Common.floorWei, "700");
  assert.equal(byTier.Common.listed, 2);
  assert.equal(byTier.Rare.floorWei, null);
  assert.equal(byTier.Rare.listed, 0);
});

test("computeUniversalRaritySnapshot: editions give every copy its edition's rank; generative keeps the canonical kernel; official tier detected", () => {
  const editions: GenericRarityInput[] = Array.from({ length: 120 }, (_, i) => ({ tokenId: String(i), name: null, traits: [{ traitType: "Edition", value: i < 100 ? "common-ed" : "rare-ed" }, { traitType: "Artist", value: "x" }] }));
  const snap = computeUniversalRaritySnapshot(editions, { standard: "erc1155", totalSupply: 120 });
  assert.equal(snap.collectionType, "editions");
  assert.equal(snap.partial, false);
  assert.equal(snap.byTokenId.get("0")!.rank, snap.byTokenId.get("50")!.rank, "copies of one edition share a rank");
  assert.ok(snap.byTokenId.get("110")!.rank < snap.byTokenId.get("0")!.rank, "the rarer edition ranks better");

  const gen = computeUniversalRaritySnapshot(generative(320), { totalSupply: 400 });
  assert.equal(gen.collectionType, "generative");
  assert.equal(gen.partial, true, "320 of 400 is partial");
  assert.equal(gen.coverage.coverage, 0.8);
  assert.equal(gen.officialTierTrait, "Background", "the RobinWood Background rule generalizes");
  assert.equal(gen.byTokenId.get("0")!.tier, "Common");
  assert.equal(gen.byTokenId.get("31")!.tier, "Legendary");
});
