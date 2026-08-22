import assert from "node:assert/strict";
import test from "node:test";
import { shouldSkipZeroMemberCollection, type HeliusSearchItem } from "../../lib/market/multichain/discovery/helius-collection-scan";

/**
 * Pins the real fix for a real bug flagged live 2026-08-20 ("solana is
 * now showing 49 thousand collections... something is broken"): the scan
 * itself was never duplicating/looping, but its only registration filter
 * (has a name or an image) let through every empty/dead/spam Metaplex
 * Core "collection" -- a permissionless, free-to-create standard.
 * num_minted (Core's own real member-count field, live-verified against
 * Helius mainnet) is the real, honest floor: zero minted members means a
 * collection structurally can never have real floor/volume/listed data.
 */

test("shouldSkipZeroMemberCollection skips a collection with confirmed zero minted members", () => {
  const item: HeliusSearchItem = { id: "abc", mpl_core_info: { num_minted: 0, current_size: 0 } };
  assert.equal(shouldSkipZeroMemberCollection(item), true);
});

test("shouldSkipZeroMemberCollection keeps a real collection with at least one minted member", () => {
  const item: HeliusSearchItem = { id: "abc", mpl_core_info: { num_minted: 1, current_size: 1 } };
  assert.equal(shouldSkipZeroMemberCollection(item), false);
});

test("shouldSkipZeroMemberCollection keeps a collection with a large real supply", () => {
  const item: HeliusSearchItem = { id: "abc", mpl_core_info: { num_minted: 10_000, current_size: 10_000 } };
  assert.equal(shouldSkipZeroMemberCollection(item), false);
});

test("shouldSkipZeroMemberCollection never filters on a MISSING mpl_core_info -- absence of data is not evidence of zero", () => {
  const item: HeliusSearchItem = { id: "abc" };
  assert.equal(shouldSkipZeroMemberCollection(item), false);
});

test("shouldSkipZeroMemberCollection never filters when num_minted itself is missing but the object is present", () => {
  const item: HeliusSearchItem = { id: "abc", mpl_core_info: { current_size: 1 } };
  assert.equal(shouldSkipZeroMemberCollection(item), false);
});
