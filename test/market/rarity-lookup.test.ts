import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rarityMapGet, countTiers, tokenIdAliases } from "../../lib/market/rarity-lookup";

describe("rarity map lookup", () => {
  it("aliases numeric ids for listing overlay", () => {
    assert.ok(tokenIdAliases("06770").includes("6770"));
  });

  it("matches numeric ids with leading zeros", () => {
    const map = new Map([["6770", { tier: "Legendary" }]]);
    assert.equal(rarityMapGet(map, "06770")?.tier, "Legendary");
    assert.equal(rarityMapGet(map, "6770")?.tier, "Legendary");
  });

  it("counts every tier in the full catalog", () => {
    const map = new Map([
      ["1", { tier: "Legendary" }],
      ["2", { tier: "Epic" }],
      ["3", { tier: "Epic" }],
    ]);
    assert.deepEqual(countTiers(map), { Legendary: 1, Epic: 2 });
  });
});
