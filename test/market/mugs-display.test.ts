import assert from "node:assert/strict";
import test from "node:test";
import { displayMugsName } from "../../lib/market/multichain/mugs-display";

const base = { chainSlug: "robinhood", contractAddress: "0xaB75f3D72509cd3B3a386a03dE2B82854f0060e5" };

test("MUGS surfaces the creator-entered named seed", () => {
  assert.equal(displayMugsName({ ...base, tokenId: "27", name: "MUG 5d19830e5e52c7829f9d5ac89126b637ed810f4c-nya",
    traits: [{ traitType: "Seed", value: "Named" }] }), "MUG nya");
});

test("MUGS labels wallet and reroll identities instead of presenting hashes as custom names", () => {
  assert.equal(displayMugsName({ ...base, tokenId: "1", name: "MUG 2d60684bb60445c1a3db3c02cc4b47b62cb4b2d2",
    traits: [{ traitType: "Seed", value: "Wallet" }] }), "MUG #1 · wallet");
  assert.equal(displayMugsName({ ...base, tokenId: "5", name: "MUG 269a93ec8486fbc3a82e352430e84fd8af8ebb0d-4",
    traits: [{ traitType: "Seed", value: "Reroll" }] }), "MUG #5 · reroll 4");
});

test("non-MUG metadata names pass through unchanged", () => {
  assert.equal(displayMugsName({ chainSlug: "eth-mainnet", contractAddress: base.contractAddress,
    tokenId: "27", name: "MUG hash-nya" }), "MUG hash-nya");
});
