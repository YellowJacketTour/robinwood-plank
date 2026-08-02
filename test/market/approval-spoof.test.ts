import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalSpoof, FulfillableOrder } from "../../lib/market/seaport";
import { computeApprovalSpoof } from "../../lib/market/seaport";

/**
 * Decision-logic tests for the per-token-approval pre-flight bypass.
 *
 * BACKGROUND: seaport-js's own approval check (lib/utils/approval.js) only
 * ever calls ERC-721 `isApprovedForAll` — never `getApproved(tokenId)` — so a
 * seller/bidder who granted a single-token `approve` (exactApproval=true,
 * see buildListing/buildOffer) instead of a blanket setApprovalForAll reads
 * as having no approval, and seaport-js throws before the wallet opens, even
 * though the order is genuinely fillable on-chain.
 *
 * computeApprovalSpoof identifies WHICH ERC-721 item and WHICH holder that
 * check would gate for a given order shape, and asks an ApprovalReader
 * (real implementation: an on-chain getApproved/isApprovedForAll read) to
 * confirm a valid per-token approval before anything is bypassed.
 *
 * These tests inject a FAKE ApprovalReader so the shape-selection logic —
 * which holder, which item, which conduit — is proven independent of any
 * wallet/provider, and prove the converse: a reader that reports "no
 * confirmed approval" (absent, or a read that errored) never turns into a
 * bypass, no matter the order shape.
 */

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ZERO_CONDUIT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const NONZERO_CONDUIT =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

function listingOrder(overrides: {
  conduitKey?: string;
  tokenId?: string;
  offerItems?: FulfillableOrder["parameters"]["offer"];
}): FulfillableOrder {
  return {
    signature: "0xsig",
    parameters: {
      offerer: SELLER,
      zone: "0x0000000000000000000000000000000000000000",
      orderType: 0,
      startTime: "0",
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      zoneHash: "0x" + "0".repeat(64),
      salt: "1",
      conduitKey: overrides.conduitKey ?? ZERO_CONDUIT,
      totalOriginalConsiderationItems: 1,
      offer: overrides.offerItems ?? [
        {
          itemType: 2, // ERC721
          token: NFT,
          identifierOrCriteria: overrides.tokenId ?? "1497",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0, // NATIVE
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
          recipient: SELLER,
        },
      ],
    },
  } as unknown as FulfillableOrder;
}

function plainOfferOrder(overrides: {
  conduitKey?: string;
  tokenId?: string;
}): FulfillableOrder {
  return {
    signature: "0xsig",
    parameters: {
      offerer: BUYER,
      zone: "0x0000000000000000000000000000000000000000",
      orderType: 0,
      startTime: "0",
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      zoneHash: "0x" + "0".repeat(64),
      salt: "1",
      conduitKey: overrides.conduitKey ?? ZERO_CONDUIT,
      totalOriginalConsiderationItems: 1,
      offer: [
        {
          itemType: 1, // ERC20
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: "1000",
          endAmount: "1000",
        },
      ],
      consideration: [
        {
          itemType: 2, // ERC721 fixed
          token: NFT,
          identifierOrCriteria: overrides.tokenId ?? "1497",
          startAmount: "1",
          endAmount: "1",
          recipient: BUYER,
        },
      ],
    },
  } as unknown as FulfillableOrder;
}

function traitOfferOrder(): FulfillableOrder {
  return {
    signature: "0xsig",
    parameters: {
      offerer: BUYER,
      zone: "0x0000000000000000000000000000000000000000",
      orderType: 0,
      startTime: "0",
      endTime: String(Math.floor(Date.now() / 1000) + 3600),
      zoneHash: "0x" + "0".repeat(64),
      salt: "1",
      conduitKey: ZERO_CONDUIT,
      totalOriginalConsiderationItems: 1,
      offer: [
        {
          itemType: 1, // ERC20
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: "1000",
          endAmount: "1000",
        },
      ],
      consideration: [
        {
          itemType: 4, // ERC721_WITH_CRITERIA
          token: NFT,
          identifierOrCriteria: "0xabc123" + "0".repeat(58),
          startAmount: "1",
          endAmount: "1",
          recipient: BUYER,
        },
      ],
    },
  } as unknown as FulfillableOrder;
}

/** Records every (owner, token, tokenId) it was asked about. */
function spyingReader(result: ApprovalSpoof | null) {
  const calls: Array<[string, string, string]> = [];
  const reader = async (owner: string, token: string, tokenId: string) => {
    calls.push([owner, token, tokenId]);
    return result;
  };
  return { reader, calls };
}

test("BUY: checks the offerer's (seller's) offered ERC-721 item, not the buyer", async () => {
  const spoof: ApprovalSpoof = { owner: SELLER, token: NFT, operator: SEAPORT };
  const { reader, calls } = spyingReader(spoof);
  const order = listingOrder({ tokenId: "1497" });

  const result = await computeApprovalSpoof(order, BUYER, undefined, reader);

  assert.deepEqual(result, spoof);
  assert.deepEqual(calls, [[SELLER, NFT, "1497"]]);
});

test("ACCEPT plain offer: checks the fulfiller's (seller's/accountAddress's) consideration NFT", async () => {
  const spoof: ApprovalSpoof = { owner: SELLER, token: NFT, operator: SEAPORT };
  const { reader, calls } = spyingReader(spoof);
  const order = plainOfferOrder({ tokenId: "42" });

  // SELLER is the accepting account here — never the order's own offerer (BUYER).
  const result = await computeApprovalSpoof(order, SELLER, undefined, reader);

  assert.deepEqual(result, spoof);
  assert.deepEqual(calls, [[SELLER, NFT, "42"]]);
});

test("ACCEPT trait offer: resolves the concrete token id from considerationCriteria, not the order's opaque root", async () => {
  const spoof: ApprovalSpoof = { owner: SELLER, token: NFT, operator: SEAPORT };
  const { reader, calls } = spyingReader(spoof);
  const order = traitOfferOrder();

  const result = await computeApprovalSpoof(
    order,
    SELLER,
    [{ identifier: "77", proof: [] }],
    reader
  );

  assert.deepEqual(result, spoof);
  assert.deepEqual(calls, [[SELLER, NFT, "77"]]);
});

test("ACCEPT trait offer WITHOUT a resolved criteria: never bypasses (nothing concrete to check)", async () => {
  const { reader, calls } = spyingReader({ owner: SELLER, token: NFT, operator: SEAPORT });
  const order = traitOfferOrder();

  const result = await computeApprovalSpoof(order, SELLER, undefined, reader);

  assert.equal(result, null);
  assert.deepEqual(calls, [], "must not even ask — there is no concrete token id to verify");
});

test("non-zero conduitKey: never bypasses, reader is never even called", async () => {
  const { reader, calls } = spyingReader({ owner: SELLER, token: NFT, operator: SEAPORT });
  const order = listingOrder({ conduitKey: NONZERO_CONDUIT });

  const result = await computeApprovalSpoof(order, BUYER, undefined, reader);

  assert.equal(result, null);
  assert.deepEqual(calls, [], "a non-zero-conduit order must never reach the approval reader");
});

test("reader reports no confirmed approval (absent or unreadable): computeApprovalSpoof passes that through as null", async () => {
  const { reader } = spyingReader(null);
  const order = listingOrder({});

  const result = await computeApprovalSpoof(order, BUYER, undefined, reader);

  assert.equal(
    result,
    null,
    "a reader that could not positively confirm approval must never produce a bypass"
  );
});

test("no ERC-721 item anywhere in the order: never bypasses", async () => {
  const { reader, calls } = spyingReader({ owner: SELLER, token: NFT, operator: SEAPORT });
  const order = listingOrder({
    offerItems: [
      {
        itemType: 1, // ERC20 — not the ERC721 shape this bypass exists for
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: "1",
        endAmount: "1",
      },
    ],
  });

  const result = await computeApprovalSpoof(order, BUYER, undefined, reader);

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test("multiple ERC-721 offer items (shape order-validation never allows, defense in depth): never bypasses", async () => {
  const { reader, calls } = spyingReader({ owner: SELLER, token: NFT, operator: SEAPORT });
  const order = listingOrder({
    offerItems: [
      {
        itemType: 2,
        token: NFT,
        identifierOrCriteria: "1",
        startAmount: "1",
        endAmount: "1",
      },
      {
        itemType: 2,
        token: NFT,
        identifierOrCriteria: "2",
        startAmount: "1",
        endAmount: "1",
      },
    ],
  });

  const result = await computeApprovalSpoof(order, BUYER, undefined, reader);

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});
