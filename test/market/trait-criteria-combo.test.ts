import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundValuesForTier,
  clausesToTraitLabels,
  formatCriteriaLabel,
  intersectTokenIdLists,
  parseCriteriaFromBody,
  resolveCriteriaTokenIds,
  tokenIdsForRarityTier,
  unionTokenIdLists,
} from "../../lib/market/trait-criteria";

const traits = {
  Background: {
    Legendary: ["1", "2"],
    LegendaryGraded: ["3"],
    Epic: ["10", "11"],
    Rare: ["20"],
    RareGraded: ["21", "22"],
    Common: ["100", "101", "102"],
  },
  Holographic: {
    Yes: ["1", "10", "20", "100"],
    No: ["2", "3", "11", "21", "22", "101", "102"],
  },
  Base: {
    Oak: ["1", "10", "100"],
    Pine: ["2", "20"],
  },
};

test("intersectTokenIdLists ANDs sets and canonicalizes", () => {
  assert.deepEqual(intersectTokenIdLists([["1", "2", "3"], ["2", "3", "4"]]), ["2", "3"]);
  assert.deepEqual(intersectTokenIdLists([["01"], ["1"]]), ["1"]);
  assert.deepEqual(intersectTokenIdLists([["1"], ["2"]]), []);
});

test("unionTokenIdLists merges without dupes", () => {
  assert.deepEqual(unionTokenIdLists([["1", "2"], ["2", "3"]]), ["1", "2", "3"]);
});

test("rarity tier unions matching Background values", () => {
  assert.deepEqual(backgroundValuesForTier(traits, "Legendary").sort(), [
    "Legendary",
    "LegendaryGraded",
  ]);
  assert.deepEqual(tokenIdsForRarityTier(traits, "Legendary"), ["1", "2", "3"]);
  assert.deepEqual(tokenIdsForRarityTier(traits, "Rare"), ["20", "21", "22"]);
});

test("resolveCriteriaTokenIds ANDs trait + rarity", () => {
  // Holo Yes ∩ Epic Background
  const ids = resolveCriteriaTokenIds(traits, [
    { kind: "trait", traitType: "Holographic", value: "Yes" },
    { kind: "rarity", tier: "Epic" },
  ]);
  assert.deepEqual(ids, ["10"]);
});

test("resolveCriteriaTokenIds multi-trait combo", () => {
  const ids = resolveCriteriaTokenIds(traits, [
    { kind: "trait", traitType: "Holographic", value: "Yes" },
    { kind: "trait", traitType: "Base", value: "Oak" },
  ]);
  assert.deepEqual(ids, ["1", "10", "100"]);
});

test("rank criteria resolves a verified top-N set and combines with traits", () => {
  const rankings = { "1": 1, "2": 40, "10": 12, "20": 75, "100": 180 };
  assert.deepEqual(
    resolveCriteriaTokenIds(traits, [{ kind: "rank", maxRank: 50 }], rankings),
    ["1", "2", "10"]
  );
  assert.deepEqual(
    resolveCriteriaTokenIds(
      traits,
      [
        { kind: "trait", traitType: "Holographic", value: "Yes" },
        { kind: "rank", maxRank: 50 },
      ],
      rankings
    ),
    ["1", "10"]
  );
});

test("parseCriteriaFromBody accepts nested criteria and legacy trait", () => {
  const a = parseCriteriaFromBody({
    criteria: {
      traits: [{ traitType: "Holographic", value: "Yes" }],
      rarityTier: "Epic",
      rankMax: 100,
    },
  });
  assert.equal(a.error, undefined);
  assert.equal(a.clauses.length, 3);

  const b = parseCriteriaFromBody({ trait: { traitType: "Base", value: "Oak" } });
  assert.equal(b.clauses.length, 1);
  assert.equal(b.clauses[0]!.kind, "trait");

  const bad = parseCriteriaFromBody({ rarityTier: "Mythic" });
  assert.ok(bad.error);
  assert.ok(parseCriteriaFromBody({ criteria: { rankMax: 0 } }).error);
});

test("formatCriteriaLabel and clausesToTraitLabels", () => {
  const clauses = [
    { kind: "trait" as const, traitType: "Holographic", value: "Yes" },
    { kind: "rarity" as const, tier: "Epic" as const },
    { kind: "rank" as const, maxRank: 100 },
  ];
  assert.equal(
    formatCriteriaLabel(clauses),
    "Holographic: Yes · Rarity: Epic · Rank: top 100"
  );
  assert.deepEqual(clausesToTraitLabels(clauses), [
    { traitType: "Holographic", value: "Yes" },
    { traitType: "Rarity", value: "Epic" },
    { traitType: "Rank", value: "Top 100" },
  ]);
});
