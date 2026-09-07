import assert from "node:assert/strict";
import test from "node:test";
import { summariseBook, NATIVE_BOOK_OBSERVATION_KEY } from "../../lib/market/native-book";
import type { Listing } from "../../lib/market/types";

const row = (tokenId: string, priceWei: string, venue?: string): Listing =>
  ({ id: `l-${tokenId}`, tokenId, priceWei, maker: "0xa", kind: "fixed", collectionSlug: "robinwood", ...(venue ? { venue } : {}) } as unknown as Listing);

test("merged-book floor observations use their own marketplace key, distinct from the our-rows-only history", () => {
  assert.notEqual(NATIVE_BOOK_OBSERVATION_KEY, "marketplank");
  assert.equal(NATIVE_BOOK_OBSERVATION_KEY, "marketplank-book");
});

test("a foreign row at the floor keeps its venue; our rows never inherit a foreign venue label", () => {
  const s = summariseBook([row("1", "30000000000000000"), row("2", "12000000000000000", "opensea")], 1);
  assert.equal(s.floorVenue, "opensea");
  const t = summariseBook([row("1", "1000000000000000"), row("2", "12000000000000000", "opensea")], 1);
  assert.equal(t.floorVenue, "marketplank");
});
