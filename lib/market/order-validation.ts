import { MARKET_FEE_RECIPIENT, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import type { MarketCollection } from "@/lib/market/types";

/**
 * Seaport order validation — the single most important security boundary in
 * Marketplank.
 *
 * THE ATTACK THIS EXISTS TO STOP (found 2026-07-27):
 * The order relay used to store a client-supplied `priceWei`, `tokenId` and
 * `maker` next to the signed `rawOrder`, and never checked that they agreed.
 * Anyone could POST a listing whose card read "0.01 Ξ" while the attached
 * signed order actually demanded 100 ETH, or delivered a different token, or
 * paid a different recipient. A buyer who trusted the price on screen and
 * confirmed in their wallet would have been robbed — with no bug in Seaport
 * and no bug in the vault. Pure trust-the-client.
 *
 * The fix is structural, not a patch: nothing about an order is taken on the
 * client's word. Every displayed field is DERIVED from the signed order
 * itself, so what a user sees and what they sign are the same object by
 * construction, and cannot drift apart.
 */

/** Seaport ItemType enum. */
const ITEM_NATIVE = 0;
const ITEM_ERC20 = 1;
const ITEM_ERC721 = 2;
const ITEM_ERC721_CRITERIA = 4;

type RawItem = {
  itemType: number | string;
  token: string;
  identifierOrCriteria: string | number;
  startAmount: string | number;
  endAmount: string | number;
  recipient?: string;
};

type RawParameters = {
  offerer: string;
  offer: RawItem[];
  consideration: RawItem[];
  startTime: string | number;
  endTime: string | number;
};

type RawOrder = {
  parameters: RawParameters;
  signature: string;
};

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderValidationError";
  }
}

function fail(message: string): never {
  throw new OrderValidationError(message);
}

function toBig(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  fail(`Order field "${field}" is not a valid integer.`);
}

function toItemType(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  fail("Order contains an item with an invalid itemType.");
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function isAddressLike(v: unknown): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

/** What the order actually says, after validation. Safe to display. */
export type DerivedOrder = {
  /** parameters.offerer — never the client's claim. */
  maker: string;
  /** Present for item-level orders; absent for collection-wide offers. */
  tokenId?: string;
  /**
   * Total the taker pays, in wei — the sum of every payment item. This is the
   * number to show; it is what leaves the buyer's wallet.
   */
  priceWei: string;
  /** ISO 8601, derived from parameters.endTime. */
  expiresAt: string;
  /** Payment currency: native ETH, or an ERC-20 (offers). */
  currency: string;
};

function assertShape(rawOrder: unknown): RawOrder {
  if (!rawOrder || typeof rawOrder !== "object") fail("Order is missing.");
  const o = rawOrder as Partial<RawOrder>;
  if (!o.parameters || typeof o.parameters !== "object") fail("Order has no parameters.");
  if (typeof o.signature !== "string" || o.signature.length < 4) {
    fail("Order has no signature.");
  }
  const p = o.parameters as Partial<RawParameters>;
  if (!Array.isArray(p.offer) || p.offer.length === 0) fail("Order offers nothing.");
  if (!Array.isArray(p.consideration) || p.consideration.length === 0) {
    fail("Order asks for nothing in return.");
  }
  if (!isAddressLike(p.offerer)) fail("Order has an invalid offerer.");
  return o as RawOrder;
}

/**
 * A payment item whose amount escalates (startAmount != endAmount) is a
 * Dutch/ascending auction. We do not build those, and a fixed price on screen
 * would be a lie if the order escalated — so reject rather than mis-display.
 */
function fixedAmount(item: RawItem, label: string): bigint {
  const start = toBig(item.startAmount, `${label}.startAmount`);
  const end = toBig(item.endAmount, `${label}.endAmount`);
  if (start !== end) {
    fail("Order price changes over time; Marketplank only lists fixed prices.");
  }
  return start;
}

function endTimeToIso(p: RawParameters): string {
  const end = toBig(p.endTime, "endTime");
  const ms = Number(end) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) fail("Order has an invalid expiry.");
  return new Date(ms).toISOString();
}

/**
 * Validate a LISTING: offers exactly one NFT from `collection`, asks for
 * native ETH. Returns only what the order itself says.
 */
export function validateListingOrder(
  rawOrder: unknown,
  collection: MarketCollection
): DerivedOrder {
  const order = assertShape(rawOrder);
  const p = order.parameters;

  if (p.offer.length !== 1) {
    fail("Marketplank listings must offer exactly one NFT.");
  }
  const offered = p.offer[0];
  const offeredType = toItemType(offered.itemType);
  if (offeredType !== ITEM_ERC721) {
    fail("Listing must offer an ERC-721 token.");
  }
  if (!sameAddress(offered.token, collection.contractAddress)) {
    fail("Listing is for a different contract than the collection it claims.");
  }
  const quantity = fixedAmount(offered, "offer[0]");
  if (quantity !== BigInt(1)) fail("Listing must offer exactly one token.");

  const tokenId = toBig(offered.identifierOrCriteria, "offer[0].identifier").toString();

  // Every consideration item must be native ETH, and they sum to the price.
  let total = BigInt(0);
  let feePaid = BigInt(0);
  for (let i = 0; i < p.consideration.length; i++) {
    const item = p.consideration[i];
    if (toItemType(item.itemType) !== ITEM_NATIVE) {
      fail("Listings must be priced in ETH.");
    }
    if (!sameAddress(item.token, NATIVE_TOKEN_ADDRESS)) {
      fail("Listing payment token is not native ETH.");
    }
    if (!isAddressLike(item.recipient)) {
      fail("Listing has a payment with no valid recipient.");
    }
    const amount = fixedAmount(item, `consideration[${i}]`);
    total += amount;
    if (sameAddress(item.recipient, MARKET_FEE_RECIPIENT)) feePaid += amount;
  }
  if (total <= BigInt(0)) fail("Listing price must be greater than zero.");

  assertFeeHonored(total, feePaid, collection);

  return {
    maker: p.offerer,
    tokenId,
    priceWei: total.toString(),
    expiresAt: endTimeToIso(p),
    currency: NATIVE_TOKEN_ADDRESS,
  };
}

/**
 * Validate an OFFER: offers an ERC-20 (Seaport forbids native ETH as an offer
 * item), asks for an NFT from `collection` — a specific id, or any id when
 * the criteria form is used for a collection-wide bid.
 */
export function validateOfferOrder(
  rawOrder: unknown,
  collection: MarketCollection,
  expectedCurrency: string
): DerivedOrder {
  const order = assertShape(rawOrder);
  const p = order.parameters;

  if (p.offer.length !== 1) fail("Offers must offer exactly one payment item.");
  const offered = p.offer[0];
  if (toItemType(offered.itemType) !== ITEM_ERC20) {
    // Seaport cannot pull native ETH from an offerer at fulfillment time, so
    // bids have to be in a wrapped token. Anything else would never fill.
    fail("Offers must be denominated in an ERC-20 token.");
  }
  if (!sameAddress(offered.token, expectedCurrency)) {
    fail("Offer uses an unexpected payment token.");
  }
  const total = fixedAmount(offered, "offer[0]");
  if (total <= BigInt(0)) fail("Offer amount must be greater than zero.");

  let tokenId: string | undefined;
  let sawCollectionItem = false;
  let feePaid = BigInt(0);

  for (let i = 0; i < p.consideration.length; i++) {
    const item = p.consideration[i];
    const type = toItemType(item.itemType);

    if (type === ITEM_ERC721 || type === ITEM_ERC721_CRITERIA) {
      if (!sameAddress(item.token, collection.contractAddress)) {
        fail("Offer targets a different contract than the collection it claims.");
      }
      if (!sameAddress(item.recipient, p.offerer)) {
        fail("Offer would deliver the NFT to someone other than the bidder.");
      }
      sawCollectionItem = true;
      if (type === ITEM_ERC721) {
        tokenId = toBig(item.identifierOrCriteria, `consideration[${i}].identifier`).toString();
      }
      continue;
    }

    if (type === ITEM_ERC20) {
      if (!sameAddress(item.token, expectedCurrency)) {
        fail("Offer fee is denominated in an unexpected token.");
      }
      const amount = fixedAmount(item, `consideration[${i}]`);
      if (sameAddress(item.recipient, MARKET_FEE_RECIPIENT)) feePaid += amount;
      continue;
    }

    fail("Offer contains an unsupported item type.");
  }

  if (!sawCollectionItem) fail("Offer does not ask for an NFT from this collection.");

  assertFeeHonored(total, feePaid, collection);

  return {
    maker: p.offerer,
    tokenId,
    priceWei: total.toString(),
    expiresAt: endTimeToIso(p),
    currency: expectedCurrency,
  };
}

/**
 * A collection with a fee configured must actually pay it. Without this, a
 * seller could hand-craft an order that skips the fee item while still being
 * listed alongside honest ones.
 *
 * Allows a 1 wei tolerance for integer-division rounding inside seaport-js.
 */
function assertFeeHonored(total: bigint, feePaid: bigint, collection: MarketCollection): void {
  if (!collection.feeBps || collection.feeBps <= 0) return;
  const expected = (total * BigInt(Math.round(collection.feeBps))) / BigInt(10_000);
  if (expected === BigInt(0)) return;
  const tolerance = expected / BigInt(100) + BigInt(1); // 1% + 1 wei
  if (feePaid + tolerance < expected) {
    fail("Order does not pay the marketplace fee for this collection.");
  }
}
