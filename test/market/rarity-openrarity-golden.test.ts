import assert from "node:assert/strict";
import test from "node:test";
import { computeGenericRaritySnapshot, scoreTokenAgainstTraitIndex } from "@/lib/rarity-generic";

/**
 * AUDIT Batch F1 -- OpenRarity-exact golden fixtures, every number computed
 * by hand from the OpenRarity method (github.com/OpenRarity/open-rarity):
 *   score = sum over scored trait types of -log2(count / N), with a token
 *   that lacks a type scored on the "None" pseudo-value; sort by unique
 *   attribute count desc, then score desc; RANK ties (1,2,2,2,5).
 */
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b} got ${a}`);

test("golden: RANK ties are 1,2,2,2,5 (not dense) and scores are the hand-computed bit sums", () => {
  // N = 8. Hat: t1 Crown (1), t2-t4 Cap (3), t5-t8 Beanie (4). Eyes: all Blue (8, 0 bits).
  const items = [
    { tokenId: "1", name: null, traits: [{ traitType: "Hat", value: "Crown" }, { traitType: "Eyes", value: "Blue" }] },
    ...["2", "3", "4"].map((id) => ({ tokenId: id, name: null, traits: [{ traitType: "Hat", value: "Cap" }, { traitType: "Eyes", value: "Blue" }] })),
    ...["5", "6", "7", "8"].map((id) => ({ tokenId: id, name: null, traits: [{ traitType: "Hat", value: "Beanie" }, { traitType: "Eyes", value: "Blue" }] })),
  ];
  const snap = computeGenericRaritySnapshot(items);
  assert.equal(snap.sampleSize, 8);
  // -log2(1/8) = 3 ; -log2(3/8) = 1.415037... ; -log2(4/8) = 1 ; Eyes contributes 0.
  close(snap.byTokenId.get("1")!.score, 3, "Crown");
  close(snap.byTokenId.get("2")!.score, Math.log2(8 / 3), "Cap");
  close(snap.byTokenId.get("5")!.score, 1, "Beanie");
  const ranks = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => snap.byTokenId.get(id)!.rank);
  assert.deepEqual(ranks, [1, 2, 2, 2, 5, 5, 5, 5]);
});

test("golden: a missing scored trait is scored on the None pseudo-value, never dropped", () => {
  // N = 4. Hat: t1 Crown (1), t2/t3 Cap (2), t4 lacks Hat -> None (1). Eyes: all Blue.
  const items = [
    { tokenId: "1", name: null, traits: [{ traitType: "Hat", value: "Crown" }, { traitType: "Eyes", value: "Blue" }] },
    { tokenId: "2", name: null, traits: [{ traitType: "Hat", value: "Cap" }, { traitType: "Eyes", value: "Blue" }] },
    { tokenId: "3", name: null, traits: [{ traitType: "Hat", value: "Cap" }, { traitType: "Eyes", value: "Blue" }] },
    { tokenId: "4", name: null, traits: [{ traitType: "Eyes", value: "Blue" }] },
  ];
  const snap = computeGenericRaritySnapshot(items);
  // t4: None is 1-of-4 -> -log2(1/4) = 2 bits (the old kernel gave it 0 and ranked it last).
  close(snap.byTokenId.get("4")!.score, 2, "None pseudo-value");
  close(snap.byTokenId.get("1")!.score, 2, "Crown");
  close(snap.byTokenId.get("2")!.score, 1, "Cap");
  // t1 and t4 have equal scores, but only t1 carries a REAL unique attribute
  // (None never counts as unique) -> t1 rank 1, t4 rank 2, Caps tie at 3.
  assert.equal(snap.byTokenId.get("1")!.rank, 1);
  assert.equal(snap.byTokenId.get("4")!.rank, 2);
  assert.equal(snap.byTokenId.get("2")!.rank, 3);
  assert.equal(snap.byTokenId.get("3")!.rank, 3);
});

test("golden: unique-attribute count is the primary sort key ahead of information content", () => {
  // N = 8, four scored types.
  // Hat:   t1 Crown (1) ; t2-t8 Cap (7)
  // Eyes:  t2,t3 Red (2) ; others Blue (6)
  // Fur:   t2,t3 Gold (2); others Brown (6)
  // Mouth: t2,t3 Grin (2); others Flat (6)
  const items = Array.from({ length: 8 }, (_, i) => {
    const id = String(i + 1);
    const special = id === "2" || id === "3";
    return {
      tokenId: id,
      name: null,
      traits: [
        { traitType: "Hat", value: id === "1" ? "Crown" : "Cap" },
        { traitType: "Eyes", value: special ? "Red" : "Blue" },
        { traitType: "Fur", value: special ? "Gold" : "Brown" },
        { traitType: "Mouth", value: special ? "Grin" : "Flat" },
      ],
    };
  });
  const snap = computeGenericRaritySnapshot(items);
  const t1 = snap.byTokenId.get("1")!;
  const t2 = snap.byTokenId.get("2")!;
  const t4 = snap.byTokenId.get("4")!;
  // t1 = 3 + 3 * log2(8/6) = 4.2451... ; t2 = log2(8/7) + 3 * log2(8/2) = 6.1926...
  close(t1.score, 3 + 3 * Math.log2(8 / 6), "t1");
  close(t2.score, Math.log2(8 / 7) + 3 * 2, "t2");
  close(t4.score, Math.log2(8 / 7) + 3 * Math.log2(8 / 6), "t4");
  assert.ok(t2.score > t1.score, "t2 has MORE information content than t1");
  // ...but t1 is the only token with a 1-of-N attribute, so it ranks first.
  assert.equal(t1.rank, 1);
  assert.equal(t2.rank, 2);
  assert.equal(snap.byTokenId.get("3")!.rank, 2);
  assert.equal(t4.rank, 4);
});

test("scoreTokenAgainstTraitIndex applies the None pseudo-value for indexed types the token lacks", () => {
  // Same population as the None golden above, expressed as a trait index.
  const traitIndex = {
    Hat: { Crown: ["1"], Cap: ["2", "3"] },
    Eyes: { Blue: ["1", "2", "3", "4"] },
  };
  const scored = scoreTokenAgainstTraitIndex({
    tokenId: "4",
    traits: [{ traitType: "Eyes", value: "Blue" }],
    traitIndex,
    sampleSize: 4,
    knownScoresAsc: [1, 1, 2, 2],
  });
  close(scored.score, 2, "None for Hat");
});
