import assert from "node:assert/strict";
import test from "node:test";

import { normalisePulpListings, pulpListingsKey, pulpTokenUrl, type PulpNft } from "../../lib/market/pulp";
import { mergeBook } from "../../lib/market/book";
import {
  isForeignListing,
  isMarketplankRelistRequired,
  venueLabel,
  type Listing,
} from "../../lib/market/types";
import type { NormalisedForeignListing } from "../../lib/market/foreign-listings";

/**
 * PulpMarket carries this collection on Robinhood Chain, so its listings
 * belong in the book. Its API is read-only — no signature, no order data — so
 * every row is display-only and must never acquire a Buy button.
 *
 * Shapes here mirror real responses observed live against
 * /api/listed-nfts?chainId=4663&collectionAddress=… (17 listings at the time
 * of writing, e.g. token 62 at 0.03 ETH).
 */

const OURS = (over: Partial<Listing> = {}): Listing => ({
  id: "listing-robinwood-0xus-1-1",
  collectionSlug: "robinwood",
  tokenId: "1",
  maker: "0x1111111111111111111111111111111111111111",
  priceWei: "1000000000000000000",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  kind: "fixed",
  ...over,
});

test("a real listing normalises, keeping the venue's own expiry", () => {
  const nfts: PulpNft[] = [
    {
      tokenId: "62",
      owner: "0xE975B410c3864F1819Af1e662098790A4Cf9B04D",
      price: "30000000000000000",
      listingExpiresAt: 1_800_000_000_000,
    },
  ];
  const [row] = normalisePulpListings(nfts);
  assert.equal(row.tokenId, "62");
  assert.equal(row.priceWei, "30000000000000000");
  assert.equal(row.venue, "pulp");
  // Lowercased so it matches our own maker comparisons.
  assert.equal(row.maker, "0xe975b410c3864f1819af1e662098790a4cf9b04d");
  // Their real end time is used, unlike the OpenSea path which has none.
  assert.equal(row.expiresAt, new Date(1_800_000_000_000).toISOString());
});

test("tokens that are not for sale are dropped, not priced at zero", () => {
  // Their schema returns unlisted tokens with `price` absent. Carrying one at
  // 0 would put a free plank on the grid and drag the floor to nothing.
  const nfts: PulpNft[] = [
    { tokenId: "1", owner: "0xaaa0000000000000000000000000000000000001" },
    { tokenId: "2", owner: "0xaaa0000000000000000000000000000000000002", price: "" },
    { tokenId: "3", owner: "0xaaa0000000000000000000000000000000000003", price: "0" },
    { tokenId: "4", owner: "0xaaa0000000000000000000000000000000000004", price: "-5" },
    { tokenId: "5", owner: "0xaaa0000000000000000000000000000000000005", price: "not-a-number" },
    { tokenId: "6", price: "1000" },
    { owner: "0xaaa0000000000000000000000000000000000007", price: "1000" },
  ];
  assert.deepEqual(normalisePulpListings(nfts), []);
});

test("a listing with no end time normalises to null rather than inventing one", () => {
  const [row] = normalisePulpListings([
    { tokenId: "9", owner: "0xaaa0000000000000000000000000000000000009", price: "5" },
  ]);
  assert.equal(row.expiresAt, null);
});

test("a Pulp row carries no fulfilment material", () => {
  // The whole reason these link out. If a signature or raw order ever appears
  // here, something has started implying we can fill them.
  const [row] = normalisePulpListings([
    { tokenId: "9", owner: "0xaaa0000000000000000000000000000000000009", price: "5" },
  ]);
  assert.ok(!("signature" in row));
  assert.ok(!("rawOrder" in row));
});

test("Pulp rows join the book, tagged and linking out", () => {
  const foreign: NormalisedForeignListing[] = normalisePulpListings([
    { tokenId: "77", owner: "0xbbb0000000000000000000000000000000000001", price: "5000" },
  ]);
  const merged = mergeBook([], foreign, "robinwood");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].venue, "pulp");
  assert.equal(merged[0].tokenId, "77");
  assert.ok(merged[0].externalUrl?.startsWith("https://pulpmarket.app/?collection="));
  assert.ok(!("rawOrder" in merged[0]));
});

test("Pulp cache and outbound links are collection-scoped, never RobinWood-hard-coded", () => {
  const mugs = "0xab75f3d72509cd3b3a386a03de2b82854f0060e5";
  assert.match(pulpListingsKey(mugs), new RegExp(mugs));
  const [row] = mergeBook([], [{
    tokenId: "27", priceWei: "100", maker: "0xmaker", expiresAt: null, venue: "pulp",
  }], "mugs", undefined, mugs);
  assert.equal(row.externalUrl, `${pulpTokenUrl(mugs, "27")}`);
});

test("cheapest wins across venues, and an exact tie goes to us", () => {
  const ours = OURS({ tokenId: "5", priceWei: "1000" });

  const cheaperPulp = mergeBook(
    [ours],
    [{ tokenId: "5", priceWei: "900", maker: "0xp", expiresAt: null, venue: "pulp" }],
    "robinwood"
  );
  assert.equal(cheaperPulp.length, 1);
  assert.equal(cheaperPulp[0].venue, "pulp");

  // Ours wins the tie: no reason to send a buyer elsewhere for the same money,
  // and our fill pays the creator royalty.
  const tied = mergeBook(
    [ours],
    [{ tokenId: "5", priceWei: "1000", maker: "0xp", expiresAt: null, venue: "pulp" }],
    "robinwood"
  );
  assert.equal(tied[0].venue, undefined);
});

test("a foreign-vs-foreign tie resolves deterministically, not by array order", () => {
  // Two marketplaces can hold the same token at the same price. Without a
  // stable rule the winner depends on which array was concatenated first, so
  // the grid could reshuffle between refreshes with no data change.
  const os: NormalisedForeignListing = {
    tokenId: "8", priceWei: "700", maker: "0xo", expiresAt: null, venue: "opensea",
  };
  const pulp: NormalisedForeignListing = {
    tokenId: "8", priceWei: "700", maker: "0xp", expiresAt: null, venue: "pulp",
  };
  const a = mergeBook([], [os, pulp], "robinwood")[0].venue;
  const b = mergeBook([], [pulp, os], "robinwood")[0].venue;
  assert.equal(a, b);
});

test("foreign rows get OUR artwork, never the venue's", () => {
  const merged = mergeBook(
    [],
    [{ tokenId: "12", priceWei: "10", maker: "0xp", expiresAt: null, venue: "pulp" }],
    "robinwood",
    { "12": "/api/ipfs/image?cid=abc" }
  );
  assert.equal(merged[0].imageUrl, "/api/ipfs/image?cid=abc");
});

test("REGRESSION: a Pulp listing is never treated as ours", () => {
  // The exact bug a naive `venue?: "opensea" | "pulp"` widening introduces.
  // Every branch used to compare against the literal "opensea", so a Pulp row
  // fell into the Marketplank arm — which is the arm that renders a BUY
  // BUTTON, on an order that has no signature and can never be filled.
  const pulpRow: Pick<Listing, "venue" | "royaltyEnforced"> = {
    venue: "pulp",
    royaltyEnforced: false,
  };
  assert.equal(isForeignListing(pulpRow), true);
  assert.equal(isMarketplankRelistRequired(pulpRow), false);

  // And ours still behaves as before.
  assert.equal(isForeignListing({ venue: undefined }), false);
  assert.equal(
    isMarketplankRelistRequired({ venue: undefined, royaltyEnforced: false }),
    true
  );
});

test("every venue is labelled, including ours", () => {
  // Labelling only foreign rows would make "unmarked" mean ours, an inference
  // that fails for anyone landing mid-scroll.
  assert.equal(venueLabel({ venue: "pulp" }), "PulpMarket");
  assert.equal(venueLabel({ venue: "opensea" }), "OpenSea");
  assert.equal(venueLabel({ venue: undefined }), "Marketplank");
});

test("the link out lands on the exact token, not just the collection", () => {
  // These rows are display-only, so the link is the entire action. Dropping a
  // buyer on the collection page to hunt for the plank they just clicked is
  // the kind of small betrayal that makes people stop trusting outbound links.
  const url = pulpTokenUrl("0x327ceaAedBBcF55F40d6f1abC71Bd9bC8adCB156", "62");
  assert.equal(
    url,
    "https://pulpmarket.app/?collection=0x327ceaaedbbcf55f40d6f1abc71bd9bc8adcb156&token=62"
  );
});

test("a row with an unknown venue is skipped, not thrown on", () => {
  // Defensive: mergeBook looks up a link-out function per venue. A row whose
  // venue has no entry must drop out of the book rather than throw, because a
  // throw here fails the entire /api/market/orders request and blanks a book
  // that was otherwise fine.
  const rogue = {
    tokenId: "99",
    priceWei: "500",
    maker: "0xz",
    expiresAt: null,
    venue: "notamarketplace",
  } as unknown as NormalisedForeignListing;

  const ours = OURS({ tokenId: "1" });
  const book = mergeBook([ours], [rogue], "robinwood");
  assert.equal(book.length, 1);
  assert.equal(book[0].tokenId, "1");
});

test("REGRESSION: a stored row with NO venue must not take down the book", () => {
  // This is the bug that took /api/market/orders down twice.
  //
  // readOpenSeaListings returns the KV blob as-is, and that blob is data AT
  // REST written by whatever normaliser was deployed when it was written.
  // `venue` was added to the writer long after 52 OpenSea rows already
  // existed, so production served rows WITHOUT the field while every local
  // run had it — local KV is rewritten by the first cron pass.
  //
  // mergeBook then did `a.venue.localeCompare(b.venue)` and threw a
  // TypeError. GET had no try/catch, so it escaped as a 500 with an empty
  // body.
  //
  // The suite stayed green because the fixture in book-merge.test.ts was
  // edited to ADD `venue` in the same commit that made it required — the
  // test was changed to match the type instead of the data. Hence this test
  // deliberately constructs the OLD shape.
  const legacyRow = {
    tokenId: "7",
    priceWei: "9000000000000000",
    maker: "0x2222222222222222222222222222222222222222",
    expiresAt: null,
    // no `venue` — exactly what production held
  } as unknown as NormalisedForeignListing;

  assert.doesNotThrow(() => mergeBook([OURS({ tokenId: "1" })], [legacyRow], "robinwood"));

  // Two or more rows: Array.prototype.sort skips the comparator entirely
  // below two elements, so a single-row fixture cannot catch this.
  const second = { ...legacyRow, tokenId: "8" } as NormalisedForeignListing;
  assert.doesNotThrow(() => mergeBook([], [legacyRow, second], "robinwood"));
});

test("a legacy row is still dropped rather than shown unlinkable — but loudly", () => {
  // With venue stamped on read this is unreachable in practice. If it ever
  // happens the row cannot get a link-out, and a foreign row with no
  // destination is worse than an absent one — but it must be logged, not
  // silently swallowed, because the last silent drop hid 52 real listings.
  const legacyRow = {
    tokenId: "7", priceWei: "900", maker: "0xz", expiresAt: null,
  } as unknown as NormalisedForeignListing;
  const book = mergeBook([OURS({ tokenId: "1" })], [legacyRow], "robinwood");
  assert.equal(book.length, 1);
  assert.equal(book[0].tokenId, "1");
});
