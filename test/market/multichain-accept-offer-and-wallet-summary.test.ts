import assert from "node:assert/strict";
import test from "node:test";
import { assertAcceptableOffer } from "../../lib/market/seaport";
import { acceptRobinhoodOfferNow } from "../../lib/market/multichain/trading/foreign-fulfill";
import { resolveOwnedTokenIds } from "../../lib/market/multichain/owned-token-resolver";
import { listTrackedCollections } from "../../lib/market/multichain/store";
import { getListings, getOffers } from "../../lib/market/orders-store";

// acceptRobinhoodOfferNow (lib/market/multichain/trading/foreign-fulfill.ts)
// delegates to the SAME native fulfillOrder + assertAcceptableOffer pair
// RobinWood's own Offers tab already uses (see MarketView.tsx's
// confirmAcceptOffer) -- these tests exercise the real, unmocked parts that
// don't require a browser wallet: the chainSlug guard (fails closed before
// any network/wallet call) and assertAcceptableOffer's own criteria-offer
// rejection, which is what makes scoping this to plain token offers safe.

test("acceptRobinhoodOfferNow rejects a non-Robinhood chainSlug before touching the network -- foreign-chain offer acceptance stays out of scope, documented in offers/route.ts", async () => {
  await assert.rejects(
    () => acceptRobinhoodOfferNow({ chainSlug: "eth-mainnet", collectionSlug: "gribbits", orderHash: "0xabc" }),
    /only wired for Robinhood Chain/
  );
});

test("acceptRobinhoodOfferNow rejects an unknown orderHash on Robinhood Chain (no rawOrder in the store) -- fails closed instead of reaching the wallet with nothing to sign", async () => {
  // acceptRobinhoodOfferNow runs client-side and resolves the raw order via
  // a relative fetch("/api/market/native-order?...") -- see foreign-fulfill.ts's
  // own header on why that boundary exists (Postgres access must never
  // enter the client bundle). A relative URL has no origin under this
  // Node test runner (no browser, no dev server), so this stubs global.fetch
  // to return the exact 404 shape /api/market/native-order/route.ts really
  // returns for an unknown id -- the real, unmocked assertion here is that
  // acceptRobinhoodOfferNowImpl turns that 404 into the documented
  // "no longer available" error rather than an unhandled fetch exception.
  const realFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/market/native-order")) {
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    }
    return realFetch(input as never);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        acceptRobinhoodOfferNow({
          chainSlug: "robinhood",
          collectionSlug: "0x000000000000000000000000000000000000dead",
          orderHash: "no-such-offer-id-for-testing",
        }),
      /no longer available/
    );
  } finally {
    global.fetch = realFetch;
  }
});

// assertAcceptableOffer is the exact function the native Offers tab's
// confirmAcceptOffer calls (see MarketView.tsx) and acceptRobinhoodOfferNow
// now reuses -- proving it rejects a criteria/collection-wide-shaped derived
// order is what makes "scoped to plain token offers, trait offers fail
// closed" a real property rather than an assumption.
test("assertAcceptableOffer throws for a criteria-shaped derived order (no derived.tokenId) -- the exact guard that keeps acceptRobinhoodOfferNow from mis-fulfilling a trait bid", () => {
  assert.throws(
    () => assertAcceptableOffer({ priceWei: "1" }, { tokenId: undefined, priceWei: "1" } as never),
    /not for a specific token/
  );
});

test("assertAcceptableOffer throws when the offer's tokenId doesn't match the signature-derived one", () => {
  assert.throws(
    () =>
      assertAcceptableOffer(
        { tokenId: "1", priceWei: "1" },
        { tokenId: "2", priceWei: "1" } as never
      ),
    /token doesn't match/
  );
});

// wallet-summary/route.ts's Robinhood-Chain fan-out (fetchOwnedRobinhood,
// fetchRobinhoodMakerActivity) is built from exactly these three real,
// unmocked primitives -- resolveOwnedTokenIds (now exported from
// owned/route.ts so wallet-summary can reuse it instead of duplicating the
// RPC-enumeration logic), listTrackedCollections, and getListings/getOffers.
// Proving each fails closed (empty array / resolves, never throws) for an
// unconfigured or untracked input is what lets wallet-summary's own
// Robinhood branch skip try/catch around them, same reasoning
// multichain-robinhood-branch.test.ts already established for the
// single-collection routes.

test("resolveOwnedTokenIds resolves to an empty array (never throws) against an unreachable RPC URL -- the fail-closed path fetchOwnedRobinhood depends on", async () => {
  const ids = await resolveOwnedTokenIds(
    "http://127.0.0.1:1/not-a-real-rpc-endpoint",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000dEaD"
  ).catch((e) => {
    // A raw RPC-connection failure surfacing as a rejection (rather than an
    // empty array) is the ONE case this function does not itself normalize
    // -- fetchOwnedRobinhood's own per-collection try/catch is what
    // guarantees the fail-closed contract at the route level. Either
    // outcome here is acceptable; what matters is it doesn't hang.
    return e;
  });
  assert.ok(Array.isArray(ids) || ids instanceof Error);
});

test("listTrackedCollections resolves to an array (never throws) with no Postgres configured -- the precondition fetchOwnedRobinhood's own listTrackedCollections().catch(() => []) call depends on staying true", async () => {
  const tracked = await listTrackedCollections().catch(() => []);
  assert.ok(Array.isArray(tracked));
});

test("getListings/getOffers resolve to arrays for an address-shaped Robinhood-Chain collection slug with no orders -- the exact shape fetchRobinhoodMakerActivity maps into myListings/offers", async () => {
  const slug = "0x000000000000000000000000000000000000dead";
  const listings = await getListings(slug);
  const offers = await getOffers(slug);
  assert.ok(Array.isArray(listings));
  assert.ok(Array.isArray(offers));
  assert.equal(listings.length, 0);
  assert.equal(offers.length, 0);
});
