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
  orderType?: number | string;
  totalOriginalConsiderationItems?: number | string;
  conduitKey?: string;
};

/**
 * The only conduit configuration we produce: no conduit at all (Seaport pulls
 * approvals directly). seaport-js resolves the offerer's operator from the
 * order's conduitKey; an unknown key yields an undefined operator and a
 * guaranteed revert at fill, and the OpenSea conduit is not deployed on this
 * chain. FAIL CLOSED on anything but absent/zero.
 */
const ZERO_CONDUIT_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Seaport OrderType. Only FULL_OPEN is accepted.
 *
 * - 1 PARTIAL_OPEN: allows fractional fills, meaningless for a single ERC-721
 *   and extra state we don't model.
 * - 2/3 *_RESTRICTED: fulfillment is gated by a `zone` contract we neither
 *   control nor audit.
 * - 4 CONTRACT: the offerer is a contract that *generates* the real offer and
 *   consideration at fulfillment time via generateOrder(). The static items we
 *   validate here need not be what executes, which would render this entire
 *   validator decorative. Seaport-js can't even construct these, so nothing
 *   legitimate on Marketplank produces one.
 */
const ORDER_TYPE_FULL_OPEN = 0;

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
  // Number.isSafeInteger, not isInteger: unquoted JSON integers above 2^53
  // have ALREADY lost precision by the time they reach us, so converting them
  // to BigInt would silently validate an amount different from what was
  // signed. Reject; large values must arrive as strings.
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
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

  // Only plain open orders. See ORDER_TYPE_FULL_OPEN for why each of the
  // others is refused — the CONTRACT type in particular would let the real
  // items be generated at fulfillment, bypassing everything below.
  const orderType = p.orderType === undefined ? ORDER_TYPE_FULL_OPEN : toItemType(p.orderType);
  if (orderType !== ORDER_TYPE_FULL_OPEN) {
    fail("Only standard open orders are accepted on Marketplank.");
  }

  // Seaport treats only the first `totalOriginalConsiderationItems` entries as
  // covered by the signature. Anything beyond that is an unsigned tip, so
  // counting it toward the price would overstate what the order guarantees.
  if (p.totalOriginalConsiderationItems !== undefined) {
    const declared = toBig(
      p.totalOriginalConsiderationItems,
      "totalOriginalConsiderationItems"
    );
    if (declared !== BigInt(p.consideration.length)) {
      fail("Order carries payment items outside its signature.");
    }
  }

  // conduitKey: only "no conduit" is acceptable. Any other key either points
  // at a conduit we haven't audited or (more likely on chain 4663) one that
  // does not exist, making every fill revert. Absent is fine — getSeaport
  // produces the zero key. FAIL CLOSED on anything else.
  if (p.conduitKey !== undefined) {
    if (typeof p.conduitKey !== "string" || p.conduitKey.toLowerCase() !== ZERO_CONDUIT_KEY) {
      fail("Order uses an unsupported conduit.");
    }
  }

  // An order that hasn't started yet would sit in the book looking live and
  // revert for every buyer who tried it.
  const startTime = toBig(p.startTime ?? 0, "startTime");
  if (Number(startTime) * 1000 > Date.now() + 60_000) {
    fail("Order is not active yet.");
  }

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
  // Date can only represent ±8.64e15 ms; a finite ms beyond that makes
  // toISOString() throw a raw RangeError (a 500 at the route) instead of a
  // clean validation error. Bound it here.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8_640_000_000_000_000) {
    fail("Order has an invalid expiry.");
  }
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

  // ERC-1155 collections: the validator below asserts ERC-721 semantics
  // (quantity exactly 1, one token per order). We have no audited quantity
  // model for 1155 — accepting one here would be silent quantity inflation —
  // so REJECT explicitly until a dedicated 1155 path exists. (No allowlisted
  // collection is 1155 today.)
  if (collection.tokenStandard !== "ERC721") {
    fail("Only ERC-721 collections are tradable on Marketplank for now.");
  }

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
    // Lowercased: order ids and per-maker caps are keyed on this string, so
    // echoing attacker-chosen casing would mint distinct identities per wallet.
    maker: p.offerer.toLowerCase(),
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

  // Same fail-closed 1155 stance as listings — see validateListingOrder.
  if (collection.tokenStandard !== "ERC721") {
    fail("Only ERC-721 collections are tradable on Marketplank for now.");
  }

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
  let nftItemCount = 0;
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
      // ERC-721 quantity is definitionally 1. Seaport reverts on anything
      // else, so a larger amount is at minimum a griefing order — and the
      // same unchecked field would be silent quantity inflation on an 1155
      // path. Assert it here regardless.
      if (fixedAmount(item, `consideration[${i}]`) !== BigInt(1)) {
        fail("Offer NFT quantity must be exactly 1.");
      }
      nftItemCount++;
      // One payment, one plank: a second NFT item would validate, display as
      // an offer on one token, and hand over both for a single payment.
      if (nftItemCount > 1) {
        fail("Offer must ask for exactly one NFT.");
      }
      if (type === ITEM_ERC721) {
        tokenId = toBig(item.identifierOrCriteria, `consideration[${i}].identifier`).toString();
      } else {
        // Criteria form: a non-zero identifierOrCriteria is a Merkle root
        // restricting which token ids can fill. We have no way to display or
        // verify the root's contents, so a rooted bid would render as "offer
        // on any plank" while being unfillable for most sellers. Only the
        // wildcard (root 0 = any id) is accepted. FAIL CLOSED otherwise.
        if (toBig(item.identifierOrCriteria, `consideration[${i}].criteria`) !== BigInt(0)) {
          fail("Criteria offers must apply to the whole collection.");
        }
      }
      continue;
    }

    if (type === ITEM_ERC20) {
      if (!sameAddress(item.token, expectedCurrency)) {
        fail("Offer fee is denominated in an unexpected token.");
      }
      // The fulfiller (the seller accepting this bid) pays every consideration
      // item out of the offered funds. An ERC-20 item routed anywhere but the
      // marketplace treasury is a clawback siphoning the headline amount back
      // to an attacker-chosen address — REJECT it outright.
      if (!sameAddress(item.recipient, MARKET_FEE_RECIPIENT)) {
        fail("Offer routes payment away from the seller.");
      }
      feePaid += fixedAmount(item, `consideration[${i}]`);
      continue;
    }

    fail("Offer contains an unsupported item type.");
  }

  if (nftItemCount !== 1) fail("Offer does not ask for an NFT from this collection.");

  assertFeeHonored(total, feePaid, collection);

  // The seller NETS the offered amount minus everything clawed back as
  // consideration (post-checks above, that is only the treasury fee). This is
  // the number to display — showing the gross would overstate the bid.
  const net = total - feePaid;
  if (net <= BigInt(0)) fail("Offer nets the seller nothing.");

  return {
    // Lowercased — see validateListingOrder.
    maker: p.offerer.toLowerCase(),
    tokenId,
    priceWei: net.toString(),
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
  if (!collection.feeBps || collection.feeBps <= 0) {
    // No fee configured: any amount routed to the treasury would be value
    // silently diverted from the maker (and, for offers, understate the net
    // shown after subtraction). Fail closed on unexpected fee items.
    if (feePaid > BigInt(0)) {
      fail("Order pays a marketplace fee this collection does not charge.");
    }
    return;
  }
  // seaport-js runs BigInt(basisPoints) when building the fee item, which
  // throws on any non-integer. A collection configured with, say, 42.07 bps
  // would fail every listing attempt with an opaque SDK error — catch it here
  // with a message that names the actual problem.
  if (!Number.isInteger(collection.feeBps)) {
    fail("Collection fee must be a whole number of basis points.");
  }
  const expected = (total * BigInt(collection.feeBps)) / BigInt(10_000);
  if (expected === BigInt(0)) return;
  const tolerance = expected / BigInt(100) + BigInt(1); // 1% + 1 wei
  if (feePaid + tolerance < expected) {
    fail("Order does not pay the marketplace fee for this collection.");
  }
  // UPPER bound too: a "fee" far above the configured rate is not a fee, it
  // is value siphoned to the treasury address while the maker believes they
  // are paying the standard rate (and it would gut the seller's net on bids).
  if (feePaid > expected + tolerance) {
    fail("Order overpays the marketplace fee for this collection.");
  }
}
