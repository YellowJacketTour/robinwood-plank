import assert from "node:assert/strict";
import test from "node:test";
import { mergeBook } from "../../lib/market/book";
import { normaliseOpenSeaListings } from "../../lib/market/opensea";
import type { Listing } from "../../lib/market/types";

/**
 * The collection trades on Marketplank and OpenSea at once, so the book shows
 * both. Two properties have to hold: a token never appears twice, and a foreign
 * order is never presented as something we can fill — its conduit is outside
 * our control and our own validator fails closed on it.
 */

const ours = (tokenId: string, priceWei: string): Listing => ({
  id: `listing-${tokenId}`,
  collectionSlug: "robinwood",
  tokenId,
  maker: "0x1111111111111111111111111111111111111111",
  priceWei,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  kind: "fixed",
  imageUrl: `ipfs://art/${tokenId}`,
});

const theirs = (tokenId: string, priceWei: string) => ({
  tokenId,
  priceWei,
  maker: "0x2222222222222222222222222222222222222222",
  expiresAt: null,
});

test("a token listed on both venues appears once, at the cheaper price", () => {
  const book = mergeBook([ours("7", "20000000000000000")], [theirs("7", "9000000000000000")], "robinwood");

  assert.equal(book.length, 1, "the same plank must not render twice");
  assert.equal(book[0].tokenId, "7");
  assert.equal(book[0].priceWei, "9000000000000000");
  assert.equal(book[0].venue, "opensea");
});

test("our listing wins when it is cheaper", () => {
  const book = mergeBook([ours("7", "5000000000000000")], [theirs("7", "9000000000000000")], "robinwood");

  assert.equal(book.length, 1);
  assert.equal(book[0].priceWei, "5000000000000000");
  assert.equal(book[0].venue, undefined, "ours carries no foreign venue tag");
});

test("our listing wins an exact tie", () => {
  // No reason to route a buyer elsewhere for identical money, and our fill is
  // the one that pays the creator royalty.
  const book = mergeBook([ours("7", "9000000000000000")], [theirs("7", "9000000000000000")], "robinwood");

  assert.equal(book[0].venue, undefined);
});

test("foreign-only tokens join the book, tagged and linked out", () => {
  const book = mergeBook([ours("1", "1000000000000000")], [theirs("99", "3000000000000000")], "robinwood");

  assert.equal(book.length, 2);
  const foreign = book.find((l) => l.tokenId === "99");
  assert.equal(foreign?.venue, "opensea");
  assert.ok(
    foreign?.externalUrl?.startsWith("https://opensea.io/assets/robinhood/"),
    "a foreign listing must carry somewhere to send the buyer"
  );
});

test("foreign listings get OUR artwork, not a placeholder", () => {
  // Without this every OpenSea row falls back to the collection logo, so the
  // grid renders as rows of identical placeholders — which reads as broken,
  // and the art is the product. We already hold all 1,542 images.
  const images = { "99": "ipfs://Qm.../99.png" };
  const book = mergeBook([], [theirs("99", "3000000000000000")], "robinwood", images);

  assert.equal(book[0].imageUrl, "ipfs://Qm.../99.png");
});

test("our own resolved image wins over the index", () => {
  const images = { "7": "ipfs://index/7.png" };
  const book = mergeBook(
    [ours("7", "20000000000000000")],
    [theirs("7", "9000000000000000")],
    "robinwood",
    images
  );

  // The OpenSea price wins, but the image we already resolved at listing time
  // is the more specific one and should survive the swap.
  assert.equal(book[0].venue, "opensea");
  assert.equal(book[0].imageUrl, "ipfs://art/7");
});

test("a missing index entry is not a broken image URL", () => {
  const book = mergeBook([], [theirs("42", "1000000000000000")], "robinwood", { "1": "x" });
  assert.equal(book[0].imageUrl, undefined, "absent, so the card falls back cleanly");
});

test("a foreign listing never carries fulfilment material", () => {
  const book = mergeBook([], [theirs("42", "1000000000000000")], "robinwood");
  const foreign = book[0];

  // Storing a signature would imply a Buy path we have deliberately not built.
  assert.ok(!("rawOrder" in foreign), "no raw order");
  assert.ok(!("signature" in foreign), "no signature");
  assert.equal(foreign.venue, "opensea");
});

test("price is what the buyer pays, not what the seller nets", () => {
  // OpenSea's consideration splits across seller and their fee recipient.
  // Quoting only the seller's leg would advertise a price below the real cost.
  const normalised = normaliseOpenSeaListings([
    {
      protocol_data: {
        parameters: {
          offerer: "0x3333333333333333333333333333333333333333",
          offer: [{ itemType: 2, token: "0xnft", identifierOrCriteria: "1467" }],
          consideration: [
            { itemType: 0, startAmount: "14840100000000000", recipient: "0xseller" },
            { itemType: 0, startAmount: "149900000000000", recipient: "0xopenseafee" },
          ],
        },
      },
    },
  ]);

  assert.equal(normalised.length, 1);
  assert.equal(normalised[0].tokenId, "1467");
  assert.equal(normalised[0].priceWei, "14990000000000000", "0.01499 ETH total, both legs");
});

test("non-ERC721 and malformed orders are skipped rather than mis-priced", () => {
  const normalised = normaliseOpenSeaListings([
    // ERC-1155 offer — not this collection's shape.
    {
      protocol_data: {
        parameters: {
          offerer: "0x4444444444444444444444444444444444444444",
          offer: [{ itemType: 3, token: "0xnft", identifierOrCriteria: "1" }],
          consideration: [{ itemType: 0, startAmount: "1000", recipient: "0xs" }],
        },
      },
    },
    // No consideration at all — cannot be priced.
    {
      protocol_data: {
        parameters: {
          offerer: "0x5555555555555555555555555555555555555555",
          offer: [{ itemType: 2, token: "0xnft", identifierOrCriteria: "2" }],
          consideration: [],
        },
      },
    },
  ]);

  assert.deepEqual(normalised, []);
});
