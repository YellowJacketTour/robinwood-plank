import assert from "node:assert/strict";
import test from "node:test";
import { extractNameByline, findRelatedByCreator, type CreatorLinkable } from "../../lib/market/multichain/creator-links";

// Real, generalizable creator-entity-linking for the "search mugs also
// surfaces the rest of that creator's collections" feature. The live case
// this was built against is 9mm.Pro: MUGS (robinhood, creator_handle only),
// Based OG (base, creator_address only), Genesis OG (eth, creator_address
// only) -- confirmed live in local Postgres 2026-08-23. No two of those
// three rows share BOTH an address and a handle, so these tests assert the
// actual cross-signal shape this feature needs, not an idealized one.

function collection(overrides: Partial<CreatorLinkable> & { chainSlug: string; contractAddress: string }): CreatorLinkable {
  return {
    name: null,
    creatorAddress: null,
    creatorHandle: null,
    creatorEns: null,
    ...overrides,
  };
}

test("extractNameByline pulls a trailing 'by <creator>' from a display name", () => {
  assert.equal(extractNameByline("MUGS by 9mm.Pro"), "9mm.pro");
  assert.equal(extractNameByline("Genesis OG by 9mm.Pro"), "9mm.pro");
  assert.equal(extractNameByline("Based OG by 9mm.Pro"), "9mm.pro");
  assert.equal(extractNameByline("Just A Collection"), null);
  assert.equal(extractNameByline(null), null);
});

test("findRelatedByCreator: a corroborated case links collections across mismatched signal sets (the real 9mm.Pro shape)", () => {
  const mugs = collection({ chainSlug: "robinhood", contractAddress: "0xab75f3d72509cd3b3a386a03de2b82854f0060e5", name: "MUGS by 9mm.Pro", creatorHandle: "9mm_pro" });
  const basedOg = collection({ chainSlug: "base-mainnet", contractAddress: "0xad20382061158d1a82e6663a2a6a99318b8a5acf", name: "Based OG by 9mm.Pro", creatorAddress: "0x2d60684bb60445c1a3db3c02cc4b47b62cb4b2d2" });
  const genesisOg = collection({ chainSlug: "eth-mainnet", contractAddress: "0x4c1925696270ff597a00ca2e07dc1646656d8a56", name: "Genesis OG by 9mm.Pro", creatorAddress: "0x2d60684bb60445c1a3db3c02cc4b47b62cb4b2d2" });
  const unrelated = collection({ chainSlug: "bitcoin-mainnet", contractAddress: "brc20-MUGZ", name: "BRC20 $MUGZ" });
  const all = [mugs, basedOg, genesisOg, unrelated];

  const fromMugs = findRelatedByCreator(all, mugs);
  assert.ok(fromMugs);
  assert.equal(fromMugs!.corroborated.length, 2, "both Based OG and Genesis OG should corroborate via the shared name byline");
  const corroboratedKeys = fromMugs!.corroborated.map((r) => r.collection.contractAddress).sort();
  assert.deepEqual(corroboratedKeys, [basedOg.contractAddress, genesisOg.contractAddress].sort());
  assert.equal(fromMugs!.addressOnly.length, 0);
  for (const r of fromMugs!.corroborated) assert.ok(r.matchedOn.includes("name-byline"));

  // Symmetric from the other direction too: Based OG's own byline (and, for
  // Genesis OG, shared address too) should surface both other collections.
  const fromBasedOg = findRelatedByCreator(all, basedOg);
  assert.ok(fromBasedOg);
  assert.equal(fromBasedOg!.corroborated.length, 2, "both MUGS (byline) and Genesis OG (byline + address) corroborate");
  assert.equal(fromBasedOg!.addressOnly.length, 0);
  const genesisMatch = fromBasedOg!.corroborated.find((r) => r.collection.contractAddress === genesisOg.contractAddress);
  assert.ok(genesisMatch);
  assert.ok(genesisMatch!.matchedOn.includes("address"));
  assert.ok(genesisMatch!.matchedOn.includes("name-byline"));
  const mugsMatch = fromBasedOg!.corroborated.find((r) => r.collection.contractAddress === mugs.contractAddress);
  assert.ok(mugsMatch);
  assert.deepEqual(mugsMatch!.matchedOn, ["name-byline"]);
});

test("findRelatedByCreator: a shared creator_address with NO corroborating signal is demoted to addressOnly, not treated as confirmed", () => {
  // Simulates a pooled/shared deployer wallet (e.g. an OpenSea Studio wallet) used by two otherwise-unrelated creators.
  const a = collection({ chainSlug: "eth-mainnet", contractAddress: "0x1111111111111111111111111111111111111a", name: "Unrelated Drop A", creatorAddress: "0xshared00000000000000000000000000000shared" });
  const b = collection({ chainSlug: "eth-mainnet", contractAddress: "0x1111111111111111111111111111111111111b", name: "Unrelated Drop B", creatorAddress: "0xshared00000000000000000000000000000shared" });
  const result = findRelatedByCreator([a, b], a);
  assert.ok(result);
  assert.equal(result!.corroborated.length, 0, "no handle/ens/byline corroboration exists -- must not be marked confirmed");
  assert.equal(result!.addressOnly.length, 1);
  assert.deepEqual(result!.addressOnly[0].matchedOn, ["address"]);
});

test("findRelatedByCreator: no creator identity signals at all returns null (never a false grouping)", () => {
  const noSignal = collection({ chainSlug: "eth-mainnet", contractAddress: "0x2222222222222222222222222222222222222a", name: "Anonymous Collection" });
  const other = collection({ chainSlug: "eth-mainnet", contractAddress: "0x2222222222222222222222222222222222222b", name: "Also Anonymous" });
  assert.equal(findRelatedByCreator([noSignal, other], noSignal), null);
});

test("findRelatedByCreator: an empty universe or a target with no real match returns null", () => {
  const target = collection({ chainSlug: "eth-mainnet", contractAddress: "0x3333333333333333333333333333333333333a", creatorHandle: "solo_artist" });
  assert.equal(findRelatedByCreator([], target), null);
  assert.equal(findRelatedByCreator([target], target), null, "must never match itself");
  const differentHandle = collection({ chainSlug: "eth-mainnet", contractAddress: "0x3333333333333333333333333333333333333b", creatorHandle: "someone_else" });
  assert.equal(findRelatedByCreator([target, differentHandle], target), null);
});
