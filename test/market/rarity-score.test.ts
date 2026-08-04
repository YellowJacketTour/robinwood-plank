import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTraitValueScores,
  computeTokenRarityScores,
  computeFacetCounts,
  type TokenTraits,
} from "../../lib/market/rarity-score";

test("single-trait collection: score reduces to plain information content", () => {
  // 4 tokens, one trait each: 3 share "Blue", 1 is uniquely "Gold".
  const tokens: TokenTraits[] = [
    { tokenId: 1, traits: [{ traitType: "Color", traitValue: "Blue" }] },
    { tokenId: 2, traits: [{ traitType: "Color", traitValue: "Blue" }] },
    { tokenId: 3, traits: [{ traitType: "Color", traitValue: "Blue" }] },
    { tokenId: 4, traits: [{ traitType: "Color", traitValue: "Gold" }] },
  ];
  const scores = computeTokenRarityScores(tokens);
  const gold = scores.find((s) => s.tokenId === 4)!;
  const blue = scores.find((s) => s.tokenId === 1)!;
  // Gold: p = 1/4 -> -log2(0.25) = 2 bits. Blue: p = 3/4 -> -log2(0.75) ≈ 0.415 bits.
  assert.ok(Math.abs(gold.score - 2) < 1e-9);
  assert.ok(Math.abs(blue.score - -Math.log2(0.75)) < 1e-9);
  assert.ok(gold.score > blue.score);
  // Rarest (Gold) ranks 1.
  assert.equal(gold.rank, 1);
});

test("a trait value present on 100% of tokens contributes zero bits", () => {
  const tokens: TokenTraits[] = [
    {
      tokenId: 1,
      traits: [
        { traitType: "Species", traitValue: "Plank" }, // universal
        { traitType: "Hat", traitValue: "Top Hat" }, // 1 of 3
      ],
    },
    { tokenId: 2, traits: [{ traitType: "Species", traitValue: "Plank" }] },
    { tokenId: 3, traits: [{ traitType: "Species", traitValue: "Plank" }] },
  ];
  const traitScores = computeTraitValueScores(tokens);
  const universal = traitScores.get("Species::Plank")!;
  assert.equal(universal.probability, 1);
  assert.equal(Object.is(universal.informationContent, 0) || Object.is(universal.informationContent, -0), true);

  const scores = computeTokenRarityScores(tokens);
  const token1 = scores.find((s) => s.tokenId === 1)!;
  // Only the Hat trait contributes: p = 1/3 -> -log2(1/3).
  assert.ok(Math.abs(token1.score - -Math.log2(1 / 3)) < 1e-9);
  const token2 = scores.find((s) => s.tokenId === 2)!;
  assert.equal(token2.score, 0);
});

test("missing traits: a token with zero recognized traits scores 0 and ranks last, tied", () => {
  const tokens: TokenTraits[] = [
    { tokenId: 1, traits: [{ traitType: "Rare", traitValue: "Yes" }] },
    { tokenId: 2, traits: [] },
    { tokenId: 3, traits: [] },
  ];
  const scores = computeTokenRarityScores(tokens);
  const t2 = scores.find((s) => s.tokenId === 2)!;
  const t3 = scores.find((s) => s.tokenId === 3)!;
  assert.equal(t2.score, 0);
  assert.equal(t3.score, 0);
  assert.equal(t2.rank, t3.rank, "tied zero-score tokens share a rank");
  const t1 = scores.find((s) => s.tokenId === 1)!;
  assert.ok(t1.rank < t2.rank);
});

test("competition ranking: ties share a rank and the next distinct score skips ahead (1,2,2,4)", () => {
  const tokens: TokenTraits[] = [
    { tokenId: 1, traits: [{ traitType: "T", traitValue: "rare1" }] }, // unique
    { tokenId: 2, traits: [{ traitType: "T", traitValue: "common" }] },
    { tokenId: 3, traits: [{ traitType: "T", traitValue: "common" }] },
    { tokenId: 4, traits: [{ traitType: "T", traitValue: "common" }] },
  ];
  const scores = computeTokenRarityScores(tokens);
  const byId = new Map(scores.map((s) => [s.tokenId, s]));
  assert.equal(byId.get(1)!.rank, 1);
  assert.equal(byId.get(2)!.rank, 2);
  assert.equal(byId.get(3)!.rank, 2);
  assert.equal(byId.get(4)!.rank, 2);
});

test("explicit totalTokens (partial sample) scales probability against the whole collection", () => {
  // Only 2 of a 10-token collection are in the sample, both sharing one value.
  const tokens: TokenTraits[] = [
    { tokenId: 1, traits: [{ traitType: "Base", traitValue: "Oak" }] },
    { tokenId: 2, traits: [{ traitType: "Base", traitValue: "Oak" }] },
  ];
  const traitScores = computeTraitValueScores(tokens, 10);
  const oak = traitScores.get("Base::Oak")!;
  assert.equal(oak.probability, 0.2);
  assert.ok(Math.abs(oak.informationContent - -Math.log2(0.2)) < 1e-9);
});

test("computeFacetCounts aggregates per trait_type -> trait_value -> count", () => {
  const tokens: TokenTraits[] = [
    { tokenId: 1, traits: [{ traitType: "Base", traitValue: "Oak" }] },
    { tokenId: 2, traits: [{ traitType: "Base", traitValue: "Oak" }] },
    { tokenId: 3, traits: [{ traitType: "Base", traitValue: "Pine" }] },
  ];
  const facets = computeFacetCounts(tokens);
  assert.equal(facets.get("Base")?.get("Oak"), 2);
  assert.equal(facets.get("Base")?.get("Pine"), 1);
});

test("empty totalTokens (0 tokens) does not throw and yields empty maps", () => {
  const traitScores = computeTraitValueScores([], 0);
  assert.equal(traitScores.size, 0);
  const scores = computeTokenRarityScores([]);
  assert.deepEqual(scores, []);
});
