import assert from "node:assert/strict";
import test from "node:test";
import { getCollectionAsync } from "../../lib/market/collections-server";
import { getListings, getOffers } from "../../lib/market/orders-store";

// These exercise the same real, unmocked "fails closed on an unknown
// Robinhood-Chain collection" path that every "robinhood" branch added to
// the multichain listings/offers/activity/owned/my-listings routes depends
// on (see app/api/market/multichain/{listings,offers,activity,my-listings}/
// route.ts: each calls getCollectionAsync(collectionSlug) first and returns
// 404 when it resolves to undefined, exactly like this test proves it does).

test("getCollectionAsync (Robinhood-Chain branch precondition) returns undefined for an untracked address-shaped slug -- the 404 path every new route branch relies on", async () => {
  const collection = await getCollectionAsync("0x000000000000000000000000000000000000dead");
  assert.equal(collection, undefined);
});

test("getCollectionAsync (Robinhood-Chain branch precondition) resolves the curated robinwood slug so the 200 path is reachable too", async () => {
  const collection = await getCollectionAsync("robinwood");
  assert.equal(collection?.slug, "robinwood");
  assert.equal(typeof collection?.contractAddress, "string");
});

// getListings/getOffers are the native data sources the new "robinhood"
// branches in listings/offers/my-listings route.ts map into the shared
// foreign-chain response shape. Real, unmocked calls: with no durable KV/
// Postgres configured in this test environment, both fall back to the file
// store and resolve to [] for an unused collection slug rather than
// throwing -- the same "never throw, resolve to an empty real result"
// contract the route branches depend on to return `{ listings: [] }` /
// `{ offers: [] }` instead of a 500.

test("getListings resolves to an array (never throws) for a collection slug that has no orders -- the shape listings/route.ts's and my-listings/route.ts's robinhood branches map directly into { listings }", async () => {
  const listings = await getListings("no-such-collection-slug-for-testing");
  assert.ok(Array.isArray(listings));
  assert.equal(listings.length, 0);
});

test("getOffers resolves to an array (never throws) for a collection slug that has no orders -- the shape offers/route.ts's robinhood branch maps directly into { offers }", async () => {
  const offers = await getOffers("no-such-collection-slug-for-testing");
  assert.ok(Array.isArray(offers));
  assert.equal(offers.length, 0);
});
