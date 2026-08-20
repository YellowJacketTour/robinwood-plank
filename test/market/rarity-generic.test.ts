import assert from "node:assert/strict";
import test from "node:test";
import {
  computeGenericRaritySnapshot,
  detectOfficialTierTrait,
  isSpamTraitType,
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
