import assert from "node:assert/strict";
import { test } from "node:test";
import {
  itemKey,
  listBulkItems,
  makeListingInput,
  makeListingPostBody,
  resolveBulkPrices,
  type BulkItemStatus,
  type SelectedItem,
} from "../../lib/market/bulk-list";
import type { ListInput } from "../../lib/market/seaport";
import type { MarketCollection } from "../../lib/market/types";

/**
 * Bulk listing — N items, N signatures, ONE order-construction path.
 *
 * The security property under test: the bulk flow must produce the exact
 * same ListInput (fed to lib/market/seaport.ts buildListing) and the exact
 * same relay POST body as the single-item ListForm flow, which now calls the
 * same makeListingInput/makeListingPostBody helpers. Plus: strict price
 * validation in both modes, and clean per-item partial-failure handling.
 *
 * Run with: npm run test:market
 */

const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const SELLER = "0x1111111111111111111111111111111111111111";

const collection: MarketCollection = {
  slug: "robinwood",
  name: "RobinWood",
  contractAddress: NFT,
  tokenStandard: "ERC721",
  image: "/x.png",
  trustBadges: [],
  feeBps: 0,
};

const feeCollection: MarketCollection = { ...collection, slug: "other", feeBps: 250 };

function sel(tokenId: string, c: MarketCollection = collection): SelectedItem {
  return { collection: c, tokenId };
}

// ─── Price validation ───────────────────────────────────────────────────────

test("same-price mode: one valid price applies to every selected item", () => {
  const r = resolveBulkPrices("same", "0.5", {}, [sel("1"), sel("2"), sel("3")]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.prices.size, 3);
  for (const wei of r.prices.values()) assert.equal(wei, BigInt("500000000000000000"));
});

test("same-price mode rejects empty, zero, negative-ish and malformed prices", () => {
  for (const bad of ["", "0", "0.0", ".", "1.2.3", "abc", "-1"]) {
    const r = resolveBulkPrices("same", bad, {}, [sel("1")]);
    assert.equal(r.ok, false, `should reject "${bad}"`);
  }
});

test("empty selection is rejected in both modes", () => {
  assert.equal(resolveBulkPrices("same", "1", {}, []).ok, false);
  assert.equal(resolveBulkPrices("per-item", "", {}, []).ok, false);
});

test("per-item mode: each item gets its own price; all must validate", () => {
  const items = [sel("7"), sel("8")];
  const r = resolveBulkPrices(
    "per-item",
    "",
    { [itemKey(items[0])]: "1", [itemKey(items[1])]: "0.25" },
    items
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.prices.get("robinwood:7"), BigInt("1000000000000000000"));
  assert.equal(r.prices.get("robinwood:8"), BigInt("250000000000000000"));
});

test("per-item mode FAILS CLOSED when any item's price is missing or invalid", () => {
  const items = [sel("7"), sel("8")];
  // Missing one price entirely
  let r = resolveBulkPrices("per-item", "", { [itemKey(items[0])]: "1" }, items);
  assert.equal(r.ok, false);
  // One invalid price
  r = resolveBulkPrices(
    "per-item",
    "",
    { [itemKey(items[0])]: "1", [itemKey(items[1])]: "0" },
    items
  );
  assert.equal(r.ok, false);
  // Whitespace-only
  r = resolveBulkPrices(
    "per-item",
    "",
    { [itemKey(items[0])]: "1", [itemKey(items[1])]: "   " },
    items
  );
  assert.equal(r.ok, false);
});

// ─── Order-shape parity with the single-listing path ────────────────────────

/** Reconstructs what ListForm.tsx's submit() produced BEFORE the shared
 * helpers existed (verbatim from its previous inline object literals). If
 * makeListingInput/makeListingPostBody ever drift from this shape, the bulk
 * path has forked from the audited single-listing path. */
function legacySingleListingInput(
  c: MarketCollection,
  tokenId: string,
  priceWei: bigint,
  expiresAt: string
): ListInput {
  return {
    offerTokenAddress: c.contractAddress,
    offerTokenId: tokenId.trim(),
    considerationWei: priceWei.toString(),
    expiresAt,
    feeBps: c.feeBps,
  };
}

test("bulk ListInput is byte-identical to the single-listing path's, incl. fee handling", () => {
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const c of [collection, feeCollection]) {
    const ours = makeListingInput(c, " 42 ", BigInt(123456789), expiresAt);
    const legacy = legacySingleListingInput(c, " 42 ", BigInt(123456789), expiresAt);
    assert.deepEqual(ours, legacy);
    // Fee comes from the collection config, never invented per-flow.
    assert.equal(ours.feeBps, c.feeBps);
  }
});

test("bulk POST body is byte-identical to the single-listing path's", () => {
  const expiresAt = new Date().toISOString();
  const rawOrder = { parameters: { offerer: SELLER }, signature: "0xabcd" };
  const body = makeListingPostBody(collection, "42", SELLER, BigInt(1000), expiresAt, rawOrder);
  assert.deepEqual(body, {
    kind: "listing",
    collectionSlug: "robinwood",
    tokenId: "42",
    maker: SELLER,
    priceWei: "1000",
    expiresAt,
    rawOrder,
  });
  // JSON round-trip stability — exactly what fetch() will serialize.
  assert.equal(
    JSON.stringify(body),
    JSON.stringify({
      kind: "listing",
      collectionSlug: "robinwood",
      tokenId: "42",
      maker: SELLER,
      priceWei: "1000",
      expiresAt,
      rawOrder,
    })
  );
});

test("listBulkItems feeds buildListing the SAME input makeListingInput produces", async () => {
  const seen: ListInput[] = [];
  const items = [sel("1"), sel("2", feeCollection)];
  const prices = new Map([
    ["robinwood:1", BigInt(100)],
    ["other:2", BigInt(200)],
  ]);
  await listBulkItems(SELLER, items, prices, 7, {
    buildListing: async (_account, input) => {
      seen.push(input);
      return { signed: true };
    },
    postOrder: async () => ({ ok: true }),
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].offerTokenAddress, NFT);
  assert.equal(seen[0].offerTokenId, "1");
  assert.equal(seen[0].considerationWei, "100");
  assert.equal(seen[0].feeBps, 0);
  assert.equal(seen[1].feeBps, 250); // fee taken from that item's collection
  // Shape parity with the shared builder for identical inputs:
  assert.deepEqual(
    seen[0],
    makeListingInput(collection, "1", BigInt(100), seen[0].expiresAt)
  );
});

// ─── Partial failure handling ───────────────────────────────────────────────

test("a relay rejection marks THAT item failed and continues with the rest", async () => {
  const items = [sel("1"), sel("2"), sel("3")];
  const prices = new Map(items.map((i) => [itemKey(i), BigInt(1000)]));
  let posts = 0;
  const result = await listBulkItems(SELLER, items, prices, 7, {
    buildListing: async () => ({}),
    postOrder: async () => {
      posts += 1;
      if (posts === 2) return { ok: false, message: "TOO_MANY" };
      return { ok: true };
    },
  });
  assert.deepEqual(
    result.map((s) => s.state),
    ["listed", "failed", "listed"]
  );
  assert.match(result[1].error ?? "", /TOO_MANY/);
});

test("a signing failure stops the run and marks the remainder skipped, not failed or silent", async () => {
  const items = [sel("1"), sel("2"), sel("3")];
  const prices = new Map(items.map((i) => [itemKey(i), BigInt(1000)]));
  let signs = 0;
  let posts = 0;
  const result = await listBulkItems(SELLER, items, prices, 7, {
    buildListing: async () => {
      signs += 1;
      if (signs === 2) throw new Error("User rejected the request.");
      return {};
    },
    postOrder: async () => {
      posts += 1;
      return { ok: true };
    },
  });
  assert.deepEqual(
    result.map((s) => s.state),
    ["listed", "failed", "skipped"]
  );
  assert.match(result[1].error ?? "", /rejected/);
  assert.equal(posts, 1); // nothing published after the wallet said no
});

test("an item with no validated price fails closed and is never signed", async () => {
  const items = [sel("1"), sel("2")];
  const prices = new Map([["robinwood:1", BigInt(1000)]]); // #2 missing
  const signedFor: string[] = [];
  const result = await listBulkItems(SELLER, items, prices, 7, {
    buildListing: async (_a, input) => {
      signedFor.push(input.offerTokenId);
      return {};
    },
    postOrder: async () => ({ ok: true }),
  });
  assert.deepEqual(signedFor, ["1"]);
  assert.equal(result[1].state, "failed");
});

test("progress callback reports every state transition with fresh copies", async () => {
  const items = [sel("1")];
  const prices = new Map([["robinwood:1", BigInt(1000)]]);
  const snapshots: BulkItemStatus[][] = [];
  await listBulkItems(
    SELLER,
    items,
    prices,
    7,
    { buildListing: async () => ({}), postOrder: async () => ({ ok: true }) },
    (s) => snapshots.push(s)
  );
  const states = snapshots.map((s) => s[0].state);
  assert.deepEqual(states, ["pending", "signing", "publishing", "listed"]);
  // Copies, not live references: earlier snapshots must not have mutated.
  assert.equal(snapshots[0][0].state, "pending");
});
