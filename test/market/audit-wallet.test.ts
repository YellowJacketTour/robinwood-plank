import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EXPORTED_ADDRESS_CONSTANTS,
  PERMIT2_ADDRESS,
  MARKET_OFFER_CURRENCY,
  SEAPORT_ADDRESS,
} from "@/lib/constants";
import { validateOfferOrder, type DerivedOrder } from "@/lib/market/order-validation";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { assertAcceptableOffer, buildOffer } from "@/lib/market/seaport";
import { applySlippage } from "@/lib/market/vault";
import { assertSafeSwapDestination } from "@/lib/wallet";

const COLLECTION = MARKET_COLLECTIONS[0];

test("AUDIT-1: PERMIT2_ADDRESS is a valid 20-byte address", () => {
  assert.match(
    PERMIT2_ADDRESS,
    /^0x[0-9a-fA-F]{40}$/,
    `PERMIT2_ADDRESS is ${PERMIT2_ADDRESS.length} chars, not 42 — allowlist can never match`
  );
});

test("AUDIT-2: an offer order's conduitKey is validated", () => {
  const evil = {
    signature: "0xdeadbeef",
    parameters: {
      offerer: "0x1111111111111111111111111111111111111111",
      orderType: 0,
      startTime: "0",
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      // arbitrary attacker-chosen conduit key — never inspected
      conduitKey: "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1",
      offer: [
        {
          itemType: 1,
          token: MARKET_OFFER_CURRENCY,
          identifierOrCriteria: "0",
          startAmount: "1000",
          endAmount: "1000",
        },
      ],
      consideration: [
        {
          itemType: 2,
          token: COLLECTION.contractAddress,
          identifierOrCriteria: "7",
          startAmount: "1",
          endAmount: "1",
          recipient: "0x1111111111111111111111111111111111111111",
        },
      ],
    },
  };
  assert.throws(
    () => validateOfferOrder(evil, COLLECTION, MARKET_OFFER_CURRENCY),
    /conduit/i,
    "validator accepted an order carrying an arbitrary conduitKey"
  );
});

test("AUDIT-3: SEAPORT_ADDRESS cannot be overridden by env at runtime", () => {
  assert.equal(
    SEAPORT_ADDRESS,
    "0x0000000000000068F116a894984e2DB1123eB395",
    "Seaport address is env-overridable (NEXT_PUBLIC_SEAPORT_ADDRESS)"
  );
});

test("AUDIT-4: every exported address constant is a valid 20-byte address", () => {
  const entries = Object.entries(EXPORTED_ADDRESS_CONSTANTS);
  assert.ok(entries.length >= 9, "address constant registry looks incomplete");
  for (const [name, value] of entries) {
    assert.match(value, /^0x[0-9a-fA-F]{40}$/, `${name} is malformed: "${value}"`);
  }
});

test("AUDIT-5: accept-offer cross-check rejects relay/signature mismatches", () => {
  const derived: DerivedOrder = {
    maker: "0x1111111111111111111111111111111111111111",
    tokenId: "7",
    priceWei: "1000",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    currency: MARKET_OFFER_CURRENCY,
  };
  // Honest row passes.
  assertAcceptableOffer({ tokenId: "7", priceWei: "1000" }, derived);
  // Relay claims a different token than the signature covers.
  assert.throws(
    () => assertAcceptableOffer({ tokenId: "8", priceWei: "1000" }, derived),
    /token/i
  );
  // Relay shows one price, order pays another.
  assert.throws(
    () => assertAcceptableOffer({ tokenId: "7", priceWei: "999999" }, derived),
    /price/i
  );
  // Collection-wide (criteria) orders cannot be accepted — fail closed.
  assert.throws(
    () =>
      assertAcceptableOffer(
        { tokenId: undefined, priceWei: "1000" },
        { ...derived, tokenId: undefined }
      ),
    /specific token/i
  );
});

test("AUDIT-6: collection-wide offers are disabled (fail closed)", async () => {
  await assert.rejects(
    () =>
      buildOffer("0x1111111111111111111111111111111111111111", {
        offerWei: "1000",
        considerationTokenAddress: COLLECTION.contractAddress,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        feeBps: 0,
      }),
    /disabled/i,
    "buildOffer still signs unfillable collection-wide criteria orders"
  );
});

test("AUDIT-7: vault min-out can never be zero (unbounded slippage)", () => {
  assert.equal(applySlippage(BigInt(10_000), 100), BigInt(9_900)); // 1%
  assert.equal(applySlippage(BigInt(10_000), 0), BigInt(10_000));
  assert.throws(() => applySlippage(BigInt(0), 100), /zero/i);
  assert.throws(() => applySlippage(BigInt(1), 9_999), /zero/i); // rounds to 0
  assert.throws(() => applySlippage(BigInt(10_000), 10_000), /slippage/i);
  assert.throws(() => applySlippage(BigInt(10_000), -1), /slippage/i);
});

test("AUDIT-8: market/vault sends are destination-allowlisted in lib/wallet", () => {
  const attacker = "0x2222222222222222222222222222222222222222";
  // market kind: attacker contract blocked, Seaport / WETH / collection allowed.
  assert.throws(() => assertSafeSwapDestination(attacker, "market"), /Blocked/i);
  assertSafeSwapDestination(SEAPORT_ADDRESS, "market");
  assertSafeSwapDestination(MARKET_OFFER_CURRENCY, "market");
  assertSafeSwapDestination(COLLECTION.contractAddress, "market");
  // vault kind: with no vault configured, EVERYTHING is blocked (fail closed).
  assert.throws(() => assertSafeSwapDestination(attacker, "vault"), /vault/i);
  // unknown kinds fail closed.
  assert.throws(() => assertSafeSwapDestination(SEAPORT_ADDRESS, "mystery"), /unknown kind/i);
  // original swap rule preserved.
  assert.throws(() => assertSafeSwapDestination(attacker, "swap"), /Blocked unsafe swap/i);
});
