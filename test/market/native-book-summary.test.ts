import assert from "node:assert/strict";
import test from "node:test";
import { summariseBook } from "../../lib/market/native-book";
import type { Listing } from "../../lib/market/types";

const row = (tokenId: string, priceWei: string, venue?: string): Listing =>
  ({ id: `l-${tokenId}`, tokenId, priceWei, maker: "0xa", kind: "fixed", collectionSlug: "robinwood", ...(venue ? { venue } : {}) } as unknown as Listing);

test("hub floor is the cheapest listing across the merged book and names the venue that holds it", () => {
  const s = summariseBook([row("1", "30000000000000000"), row("2", "12000000000000000", "opensea"), row("3", "35000000000000000")], 2);
  assert.equal(s.floorWei, 12000000000000000n);
  assert.equal(s.floorVenue, "opensea");
  assert.equal(s.listedCount, 3);
  assert.equal(s.ownListedCount, 2);
});

test("our own row at the floor reports marketplank; empty book reports null", () => {
  const s = summariseBook([row("1", "10000000000000000"), row("2", "12000000000000000", "opensea")], 1);
  assert.equal(s.floorVenue, "marketplank");
  assert.equal(s.floorWei, 10000000000000000n);
  const e = summariseBook([], 0);
  assert.equal(e.floorWei, null);
  assert.equal(e.listedCount, 0);
});
