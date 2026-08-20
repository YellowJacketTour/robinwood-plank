import assert from "node:assert/strict";
import test from "node:test";
import {
  computeGenericRaritySnapshot,
  detectOfficialTierTrait,
  isSpamTraitType,
  scoreTokenAgainstTraitIndex,
} from "@/lib/rarity-generic";

test("official tier trait: Background with Legendary/Common maps like RobinWood", () => {
  const items = [
    { tokenId: "1", name: "A", traits: [{ traitType: "Background", value: "Legendary" }, { traitType: "Hat", value: "Cap" }] },
    { tokenId: "2", name: "B", traits: [{ traitType: "Background", value: "Common" }, { traitType: "Hat", value: "Cap" }] },
    { tokenId: "3", name: "C", traits: [{ traitType: "Background", value: "Epic" }, { traitType: "Hat", value: "Beret" }] },
    { tokenId: "4", name: "D", traits: [{ traitType: "Background", value: "Rare" }, { traitType: "Hat", value: "Cap" }] },
  ];
  assert.equal(detectOfficialTierTrait(items), "Background");
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("1")?.tier, "Legendary");
  assert.equal(snap.byTokenId.get("2")?.tier, "Common");
  assert.equal(snap.byTokenId.get("3")?.tier, "Epic");
});

test("spam sequential Token ID does not dominate scores", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    tokenId: String(i),
    name: null,
    traits: [
      { traitType: "Token ID", value: String(i) },
      { traitType: "Color", value: i < 2 ? "Gold" : "Gray" },
    ],
  }));
  assert.equal(isSpamTraitType("Token ID", items), true);
  assert.equal(isSpamTraitType("Color", items), false);
  const snap = computeGenericRaritySnapshot(items);
  assert.ok(!snap.scoredTraitTypes.includes("Token ID"));
  const gold = snap.byTokenId.get("0")!;
  const gray = snap.byTokenId.get("5")!;
  assert.ok(gold.rank < gray.rank, "rarer Color=Gold should outrank common Gray");
});

test("empty trait lists all share rank 1 and Common fallback", () => {
  const items = [
    { tokenId: "1", name: null, traits: [] },
    { tokenId: "2", name: null, traits: [] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("1")?.rank, 1);
  assert.equal(snap.byTokenId.get("2")?.rank, 1);
  assert.equal(snap.byTokenId.get("1")?.tier, "Common");
});

test("RareGraded Background maps to Rare, not Uncommon", () => {
  const items = [
    { tokenId: "1", name: null, traits: [{ traitType: "Background", value: "RareGraded" }] },
    { tokenId: "2", name: null, traits: [{ traitType: "Background", value: "Common" }] },
    { tokenId: "3", name: null, traits: [{ traitType: "Background", value: "Common" }] },
    { tokenId: "4", name: null, traits: [{ traitType: "Background", value: "Common" }] },
  ];
  assert.equal(computeGenericRaritySnapshot(items).byTokenId.get("1")?.tier, "Rare");
});

test("1-of-N unique cosmetic outranks the rest without exploding vs empty", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    tokenId: String(i),
    name: null,
    traits: [{ traitType: "Hat", value: i === 0 ? "Crown" : "None" }],
  }));
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("0")?.rank, 1);
  assert.ok((snap.byTokenId.get("0")?.score ?? 0) > (snap.byTokenId.get("1")?.score ?? 0));
});

test("no official tier uses percentile bands only", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    tokenId: String(i),
    name: null,
    traits: [{ traitType: "Fur", value: i === 0 ? "Gold" : "Brown" }],
  }));
  assert.equal(detectOfficialTierTrait(items), null);
  const gold = computeGenericRaritySnapshot(items).byTokenId.get("0")!;
  assert.ok(gold.percentile >= 95);
  assert.equal(gold.tier, "Legendary");
});

test("competition rank ties share rank", () => {
  const items = [
    { tokenId: "a", name: null, traits: [{ traitType: "X", value: "rare" }] },
    { tokenId: "b", name: null, traits: [{ traitType: "X", value: "rare" }] },
    { tokenId: "c", name: null, traits: [{ traitType: "X", value: "common" }] },
    { tokenId: "d", name: null, traits: [{ traitType: "X", value: "common" }] },
    { tokenId: "e", name: null, traits: [{ traitType: "X", value: "common" }] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("a")?.rank, snap.byTokenId.get("b")?.rank);
  assert.equal(snap.byTokenId.get("a")?.rank, 1);
  assert.equal(snap.byTokenId.get("c")?.rank, 3);
});

test("adversarial: almost-unique serials are spam even if not named Token ID", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    tokenId: String(i),
    name: null,
    traits: [
      { traitType: "Serial", value: `S${i}` },
      { traitType: "Eyes", value: i === 0 ? "Laser" : "Normal" },
    ],
  }));
  assert.equal(isSpamTraitType("Serial", items), true);
  const snap = computeGenericRaritySnapshot(items);
  assert.ok(!snap.scoredTraitTypes.includes("Serial"));
  assert.equal(snap.byTokenId.get("0")?.rank, 1);
});

test("adversarial: unicode / Solana-style attribute names still score", () => {
  const items = [
    { tokenId: "mintA", name: "Mad Lad", traits: [{ traitType: "表情", value: "Grin" }] },
    { tokenId: "mintB", name: "Mad Lad", traits: [{ traitType: "表情", value: "Grin" }] },
    { tokenId: "mintC", name: "Mad Lad", traits: [{ traitType: "表情", value: "Rage" }] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("mintC")?.rank, 1);
  assert.ok((snap.byTokenId.get("mintC")?.score ?? 0) > (snap.byTokenId.get("mintA")?.score ?? 0));
});

test("adversarial: official tier missing on one token does not inherit Legendary", () => {
  const items = [
    { tokenId: "1", name: null, traits: [{ traitType: "Background", value: "Legendary" }, { traitType: "Hat", value: "Cap" }] },
    { tokenId: "2", name: null, traits: [{ traitType: "Background", value: "Common" }, { traitType: "Hat", value: "Cap" }] },
    { tokenId: "3", name: null, traits: [{ traitType: "Background", value: "Common" }, { traitType: "Hat", value: "Cap" }] },
    { tokenId: "4", name: null, traits: [{ traitType: "Hat", value: "Cap" }] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.officialTierTrait, "Background");
  assert.equal(snap.byTokenId.get("1")?.tier, "Legendary");
  assert.notEqual(snap.byTokenId.get("4")?.tier, "Legendary");
});

test("adversarial: empty snapshot is empty, not fabricated ranks", () => {
  const snap = computeGenericRaritySnapshot([]);
  assert.equal(snap.sampleSize, 0);
  assert.equal(snap.byTokenId.size, 0);
  assert.equal(snap.officialTierTrait, null);
});

test("unindexed listed token still scores against collection trait frequencies", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    tokenId: String(i),
    name: null,
    traits: [{ traitType: "Color", value: i === 0 ? "Gold" : "Gray" }],
  }));
  const snap = computeGenericRaritySnapshot(items);
  const traitIndex: Record<string, Record<string, string[]>> = { Color: { Gold: ["0"], Gray: items.slice(1).map((x) => x.tokenId) } };
  const scoresAsc = [...snap.byTokenId.values()].map((r) => r.score).sort((a, b) => a - b);
  const listed = scoreTokenAgainstTraitIndex({
    tokenId: "mint-not-in-sample",
    name: "Claynosaurz #1318",
    traits: [{ traitType: "Color", value: "Gold" }],
    traitIndex,
    sampleSize: 10,
    knownScoresAsc: scoresAsc,
  });
  assert.equal(listed.rank, 1);
  assert.ok(listed.score > 0);
});

test("adversarial: Bitcoin inscription ids and Avalanche token ids share the kernel", () => {
  const items = [
    { tokenId: "abc123i0", name: "Frog", traits: [{ traitType: "Background", value: "Lava" }] },
    { tokenId: "0", name: "Avax ape", traits: [{ traitType: "Background", value: "Blue" }] },
    { tokenId: "00", name: "Avax ape padded", traits: [{ traitType: "Background", value: "Blue" }] },
    { tokenId: "def456i0", name: "Frog", traits: [{ traitType: "Background", value: "Blue" }] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.byTokenId.get("abc123i0")?.rank, 1);
  assert.equal(snap.byTokenId.has("0"), true);
  assert.equal(snap.byTokenId.has("00"), true);
});
