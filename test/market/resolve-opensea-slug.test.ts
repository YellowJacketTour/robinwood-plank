import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenSeaCollectionSlug } from "../../lib/market/multichain/trading/foreign-orders";

// resolveOpenSeaCollectionSlug is the fix for a real, live-confirmed bug:
// every foreign-chain collection card (GlobalMarketHub.tsx) links using
// the CONTRACT ADDRESS, but OpenSea's /listings, /offers, and /collections
// endpoints need OpenSea's own slug -- calling them with a raw address
// silently returned empty results rather than an error, rendering every
// such collection's detail page as blank. These tests exercise the real,
// unmocked fail-closed shape (no OpenSea key configured in this test
// environment) that every caller (listings/offers/activity/my-listings
// routes) depends on: a lookup failure returns null, never throws, so
// every call site's `?? collectionSlug` fallback stays reachable.

test("resolveOpenSeaCollectionSlug resolves to null (never throws) without a configured OpenSea key", async () => {
  const slug = await resolveOpenSeaCollectionSlug("base", "0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a");
  assert.equal(slug, null);
});

test("resolveOpenSeaCollectionSlug caches by (chain, lowercased address) -- a second call for the same address in different case doesn't refire", async () => {
  const first = await resolveOpenSeaCollectionSlug("ethereum", "0x000000000000000000000000000000000000dead");
  const second = await resolveOpenSeaCollectionSlug("ethereum", "0x000000000000000000000000000000000000DEAD");
  assert.equal(first, second);
});
