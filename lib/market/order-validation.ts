import { MARKET_FEE_RECIPIENT, MARKETPLANK_SWAP_FEE_BPS, MARKETPLANK_SWAP_FLAT_FEE_WEI, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import { computeCriteriaRoot, CriteriaError } from "@/lib/market/criteria";
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

/**
 * A criteria item's `identifierOrCriteria` is a Merkle root, and seaport-js
 * emits it as 0x-hex when it builds the order (everything else is decimal).
 * Accept exactly those two shapes — never for amounts or token ids.
 */
function toCriteriaBig(v: unknown, field: string): bigint {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  return toBig(v, field);
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

type CollectionRoyalty = { bps: number; recipient: string };

function collectionRoyalty(collection: MarketCollection): CollectionRoyalty | null {
  if (collection.royaltyBps <= 0) return null;
  if (!Number.isInteger(collection.royaltyBps) || collection.royaltyBps > 10_000) {
    fail("Collection royalty must be a whole number of basis points between 1 and 10000.");
  }
  if (!isAddressLike(collection.royaltyRecipient)) {
    fail("Collection royalty recipient is not a valid address.");
  }
  if (sameAddress(collection.royaltyRecipient, MARKET_FEE_RECIPIENT)) {
    fail("Collection royalty recipient must differ from the marketplace treasury.");
  }
  return { bps: collection.royaltyBps, recipient: collection.royaltyRecipient };
}

/**
 * Existing signed orders do not carry application metadata. Use their signed
 * consideration to recover the rollout marker when an old stored row is read.
 * This is only a compatibility hint; new writes are still validated strictly
 * by the API before this helper is ever used.
 */
export function hasConfiguredRoyaltyConsideration(
  rawOrder: unknown,
  collection: MarketCollection
): boolean {
  const royalty = collectionRoyalty(collection);
  if (!royalty) return false;
  try {
    const order = assertShape(rawOrder);
    return order.parameters.consideration.some(
      (item) => {
        const itemType = toItemType(item.itemType);
        return (
          (itemType === ITEM_NATIVE || itemType === ITEM_ERC20) &&
          sameAddress(item.recipient, royalty.recipient)
        );
      }
    );
  } catch {
    return false;
  }
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
  /**
   * Present only for TRAIT-scoped criteria offers: the non-zero Merkle root
   * (0x-prefixed, 32 bytes, lowercase) the signed order commits to. Recomputed
   * from the caller-supplied token-id snapshot and asserted equal — never
   * taken from the order alone.
   */
  criteriaRoot?: string;
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
  const royalty = collectionRoyalty(collection);

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
  let royaltyPaid = BigInt(0);
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
    if (royalty && sameAddress(item.recipient, royalty.recipient)) royaltyPaid += amount;
  }
  if (total <= BigInt(0)) fail("Listing price must be greater than zero.");

  assertFeeHonored(total, feePaid, collection);
  assertRoyaltyHonored(total, royaltyPaid, royalty);

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

/** Same shape as DerivedOrder but for a multi-item bundle listing. */
export type DerivedBundleOrder = {
  maker: string;
  tokenIds: string[];
  priceWei: string;
  expiresAt: string;
  currency: string;
};

/**
 * Validate a BUNDLE LISTING: offers 2+ NFTs, ALL from the SAME `collection`
 * (cross-collection bundles are a genuinely different, unaudited model --
 * out of scope here, see NativeBundleListForm.tsx's own header), for one
 * combined native-ETH price. A deliberately SEPARATE function from
 * validateListingOrder above rather than a modified version of it --
 * that function is the single most audited security boundary in this
 * app (see this file's own header) and is shared by the Robinhood-chain
 * native path too; changing its `offer.length !== 1` invariant to support
 * a second, riskier shape would widen what EVERY caller of it accepts,
 * not just bundle listings. New function, not a wider one -- same
 * discipline this whole feature has used throughout (ethCallForeignFree
 * alongside ethCallFree, sendForeignTransaction alongside sendTransaction,
 * etc.).
 */
export function validateBundleListingOrder(
  rawOrder: unknown,
  collection: MarketCollection,
  maxItems: number
): DerivedBundleOrder {
  const order = assertShape(rawOrder);
  const p = order.parameters;

  if (collection.tokenStandard !== "ERC721") {
    fail("Only ERC-721 collections are tradable on Marketplank for now.");
  }
  const royalty = collectionRoyalty(collection);

  if (p.offer.length < 2) {
    fail("A bundle must offer at least two NFTs -- list a single item instead.");
  }
  if (p.offer.length > maxItems) {
    fail(`A bundle may offer at most ${maxItems} NFTs.`);
  }

  const tokenIds: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < p.offer.length; i++) {
    const offered = p.offer[i];
    if (toItemType(offered.itemType) !== ITEM_ERC721) {
      fail(`Bundle item ${i} must be an ERC-721 token.`);
    }
    if (!sameAddress(offered.token, collection.contractAddress)) {
      fail(`Bundle item ${i} is for a different contract than the collection it claims.`);
    }
    if (fixedAmount(offered, `offer[${i}]`) !== BigInt(1)) {
      fail(`Bundle item ${i} must offer exactly one token.`);
    }
    const tokenId = toBig(offered.identifierOrCriteria, `offer[${i}].identifier`).toString();
    if (seen.has(tokenId)) fail(`Bundle lists token #${tokenId} more than once.`);
    seen.add(tokenId);
    tokenIds.push(tokenId);
  }

  // Same consideration accounting as a single-item listing: every payment
  // item must be native ETH, summed for the total, fee/royalty legs
  // identified by recipient -- unchanged logic, just reused for a bundle.
  let total = BigInt(0);
  let feePaid = BigInt(0);
  let royaltyPaid = BigInt(0);
  for (let i = 0; i < p.consideration.length; i++) {
    const item = p.consideration[i];
    if (toItemType(item.itemType) !== ITEM_NATIVE) {
      fail("Bundle listings must be priced in ETH.");
    }
    if (!sameAddress(item.token, NATIVE_TOKEN_ADDRESS)) {
      fail("Bundle payment token is not native ETH.");
    }
    if (!isAddressLike(item.recipient)) {
      fail("Bundle has a payment with no valid recipient.");
    }
    const amount = fixedAmount(item, `consideration[${i}]`);
    total += amount;
    if (sameAddress(item.recipient, MARKET_FEE_RECIPIENT)) feePaid += amount;
    if (royalty && sameAddress(item.recipient, royalty.recipient)) royaltyPaid += amount;
  }
  if (total <= BigInt(0)) fail("Bundle price must be greater than zero.");

  assertFeeHonored(total, feePaid, collection);
  assertRoyaltyHonored(total, royaltyPaid, royalty);

  return {
    maker: p.offerer.toLowerCase(),
    tokenIds,
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
  expectedCurrency: string,
  opts?: {
    /**
     * TRAIT-BID token-id snapshot. When present, a criteria consideration
     * item's non-zero Merkle root MUST equal computeCriteriaRoot(snapshot) —
     * i.e. the order provably commits to exactly this set and nothing else.
     * When absent, the pre-existing rule stands unchanged: a non-zero root is
     * rejected outright (audit A5 — an opaque root would display as "any
     * plank" while being unfillable for most sellers).
     */
    criteriaTokenIds?: readonly string[];
  }
): DerivedOrder {
  const order = assertShape(rawOrder);
  const p = order.parameters;
  let criteriaRoot: string | undefined;

  // Same fail-closed 1155 stance as listings — see validateListingOrder.
  if (collection.tokenStandard !== "ERC721") {
    fail("Only ERC-721 collections are tradable on Marketplank for now.");
  }
  const royalty = collectionRoyalty(collection);

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
  let royaltyPaid = BigInt(0);

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
        // restricting which token ids can fill.
        //
        // TRAIT BIDS (2026-07-28): when the caller supplies the token-id
        // snapshot the bid claims to commit to, we recompute the root with
        // the same tree construction seaport-js signs with and require exact
        // equality — the root's contents are then fully verified, displayed
        // honestly, and fillable by construction (proven end-to-end against
        // the real Seaport 1.6 bytecode in SeaportCriteriaFulfill.test.ts).
        //
        // WITHOUT a snapshot, the original audit rule stands: an opaque
        // non-zero root would render as "offer on any plank" while being
        // unfillable for most sellers. FAIL CLOSED.
        const rootBig = toCriteriaBig(
          item.identifierOrCriteria,
          `consideration[${i}].criteria`
        );
        if (opts?.criteriaTokenIds !== undefined) {
          if (rootBig === BigInt(0)) {
            fail("Trait offer carries no criteria root.");
          }
          let expectedRoot: string;
          try {
            expectedRoot = computeCriteriaRoot(opts.criteriaTokenIds);
          } catch (e) {
            fail(
              e instanceof CriteriaError ? e.message : "Trait criteria set is invalid."
            );
          }
          if (rootBig !== BigInt(expectedRoot)) {
            fail("Offer's criteria root does not match its claimed token set.");
          }
          criteriaRoot = expectedRoot;
        } else if (rootBig !== BigInt(0)) {
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
      // marketplace treasury or the configured creator royalty receiver is a
      // clawback siphoning the headline amount back to an attacker-chosen
      // address — REJECT it outright.
      const amount = fixedAmount(item, `consideration[${i}]`);
      const isTreasury = sameAddress(item.recipient, MARKET_FEE_RECIPIENT);
      const isRoyalty = Boolean(royalty && sameAddress(item.recipient, royalty.recipient));
      if (!isTreasury && !isRoyalty) {
        fail("Offer routes payment away from the seller.");
      }
      if (isTreasury) feePaid += amount;
      if (isRoyalty) royaltyPaid += amount;
      continue;
    }

    fail("Offer contains an unsupported item type.");
  }

  if (nftItemCount !== 1) fail("Offer does not ask for an NFT from this collection.");

  // A trait bid must actually BE a criteria order — a snapshot alongside a
  // plain fixed-token item is a shape mismatch, not a trait bid.
  if (opts?.criteriaTokenIds !== undefined && !criteriaRoot) {
    fail("Trait offer is not a criteria order.");
  }

  assertFeeHonored(total, feePaid, collection);
  assertRoyaltyHonored(total, royaltyPaid, royalty);

  // The seller NETS the offered amount minus every configured consideration
  // clawback (marketplace fee plus creator royalty). This is the number to
  // display — showing the gross would overstate the bid.
  const net = total - feePaid - royaltyPaid;
  if (net <= BigInt(0)) fail("Offer nets the seller nothing.");

  return {
    // Lowercased — see validateListingOrder.
    maker: p.offerer.toLowerCase(),
    tokenId,
    priceWei: net.toString(),
    expiresAt: endTimeToIso(p),
    currency: expectedCurrency,
    ...(criteriaRoot ? { criteriaRoot } : {}),
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

/**
 * A royalty-bearing collection must route its configured EIP-2981 amount to
 * the configured receiver. This is checked against the signed consideration
 * items, so a relayed order cannot merely claim that it pays the royalty.
 */
function assertRoyaltyHonored(
  total: bigint,
  royaltyPaid: bigint,
  royalty: CollectionRoyalty | null
): void {
  if (!royalty) {
    if (royaltyPaid > BigInt(0)) {
      fail("Order pays a creator royalty this collection does not charge.");
    }
    return;
  }
  const expected = (total * BigInt(royalty.bps)) / BigInt(10_000);
  if (expected === BigInt(0)) return;
  const tolerance = expected / BigInt(100) + BigInt(1); // 1% + 1 wei
  if (royaltyPaid + tolerance < expected) {
    fail("Order does not pay the collection's creator royalty.");
  }
  if (royaltyPaid > expected + tolerance) {
    fail("Order overpays the collection's creator royalty.");
  }
}

/**
 * Validate a SWAP/OTC order -- roadmap item: "nft for nft trades... otc nft
 * and coin trades for any asset combination." A real, distinct trade shape
 * from every other validator in this file: BOTH offer and consideration
 * sides carry 1+ ERC-721 items (from any contract(s) -- unlike
 * validateBundleListingOrder, a swap is not scoped to one collection),
 * with an optional native-ETH top-up on the CONSIDERATION side only. This
 * is what makes it a swap rather than a listing (NFT for pure ETH, already
 * validateListingOrder's job) or an offer (pure ETH for NFT, already
 * validateOfferOrder's job) -- if either side has zero NFTs, this function
 * refuses it and points the caller at the right validator instead.
 *
 * WHY THE ETH TOP-UP IS CONSIDERATION-ONLY -- A REAL PROTOCOL CONSTRAINT,
 * NOT A DESIGN CHOICE
 * ---------------------------------------------------------------------------
 * Confirmed live via a real fork fulfillment attempt: native ETH cannot be
 * a Seaport OFFER item at all. There is no allowance mechanism for ETH the
 * way there is for ERC-20/ERC-721 (Seaport "pulls" offer items from the
 * offerer at fulfillment time via approve/transferFrom; ETH has no
 * equivalent -- it can only ever be SENT by whoever calls fulfillOrder,
 * i.e. the taker, as msg.value). This is exactly why every other "pay
 * money" flow in this app that needs to come FROM an offerer (buildOffer,
 * foreignOfferCurrency) uses WETH, an ERC-20, never native ETH. A future
 * "maker also pays WETH" variant is possible following that same pattern,
 * but is out of scope here -- v1 only supports the side that works
 * natively: the taker (fulfiller) can top up with ETH, the maker cannot.
 *
 * FEE MODEL: MARKETPLANK_SWAP_FEE_BPS (1.8%, same rate as every other
 * native fee) applies to considerationNativeWei when present. A pure
 * barter swap with no ETH at all has no monetary total a percentage could
 * apply to, so it pays MARKETPLANK_SWAP_FLAT_FEE_WEI instead -- the
 * feature is never revenue-free regardless of trade shape, matching this
 * app's own established stance (MARKETPLANK_NATIVE_LISTING_FEE_BPS's own
 * header).
 *
 * ROYALTY: none charged, same documented simplification every other
 * native foreign-chain order in this app already takes (no real per-chain
 * EIP-2981 data exists for arbitrary collections Marketplank doesn't
 * curate) -- and doubly true here, since a swap can span MULTIPLE
 * collections at once, each with a potentially different royalty
 * recipient/rate this app has no reliable way to resolve for both sides
 * simultaneously.
 *
 * CRITERIA (any-NFT-from-collection-X) SWAPS: explicitly out of scope for
 * v1, same caution buildOffer's own header already applies elsewhere
 * ("wildcard root-0 form was never proven fillable") -- every item on
 * both sides here is a SPECIFIC, named token, not a Merkle-committed set.
 */
export type DerivedSwapOrder = {
  maker: string;
  offerItems: { contractAddress: string; tokenId: string }[];
  considerationItems: { contractAddress: string; tokenId: string }[];
  considerationNativeWei: string;
  expiresAt: string;
};

export function validateSwapOrder(rawOrder: unknown, maxItemsPerSide = 10): DerivedSwapOrder {
  const order = assertShape(rawOrder);
  const p = order.parameters;

  const offerItems: { contractAddress: string; tokenId: string }[] = [];
  const seenOffer = new Set<string>();
  for (let i = 0; i < p.offer.length; i++) {
    const item = p.offer[i];
    const itemType = toItemType(item.itemType);
    // No native-ETH branch here -- see this function's own header on why
    // an OFFER item can never be native ETH under Seaport itself, not
    // just under this app's rules.
    if (itemType !== ITEM_ERC721) {
      fail(`Swap offer item ${i} must be an ERC-721 token.`);
    }
    if (fixedAmount(item, `offer[${i}]`) !== BigInt(1)) {
      fail(`Swap offer item ${i} must offer exactly one token.`);
    }
    const tokenId = toBig(item.identifierOrCriteria, `offer[${i}].identifier`).toString();
    const key = `${item.token.toLowerCase()}:${tokenId}`;
    if (seenOffer.has(key)) fail("Swap offers the same token more than once.");
    seenOffer.add(key);
    offerItems.push({ contractAddress: item.token.toLowerCase(), tokenId });
  }
  if (offerItems.length === 0) {
    fail("A swap must offer at least one NFT -- use a plain offer for a pure-ETH bid.");
  }
  if (offerItems.length > maxItemsPerSide) {
    fail(`A swap may offer at most ${maxItemsPerSide} NFTs.`);
  }

  const considerationItems: { contractAddress: string; tokenId: string }[] = [];
  let considerationNativeToMaker = BigInt(0);
  let feePaid = BigInt(0);
  const seenConsideration = new Set<string>();
  for (let i = 0; i < p.consideration.length; i++) {
    const item = p.consideration[i];
    const itemType = toItemType(item.itemType);
    if (!isAddressLike(item.recipient)) fail(`Swap consideration item ${i} has no valid recipient.`);
    if (itemType === ITEM_NATIVE) {
      const amount = fixedAmount(item, `consideration[${i}]`);
      if (sameAddress(item.recipient, MARKET_FEE_RECIPIENT)) {
        feePaid += amount;
      } else if (sameAddress(item.recipient, p.offerer)) {
        considerationNativeToMaker += amount;
      } else {
        fail(`Swap consideration item ${i} pays an unrecognized recipient.`);
      }
      continue;
    }
    if (itemType !== ITEM_ERC721) {
      fail(`Swap consideration item ${i} must be an ERC-721 token or native ETH.`);
    }
    if (fixedAmount(item, `consideration[${i}]`) !== BigInt(1)) {
      fail(`Swap consideration item ${i} must ask for exactly one token.`);
    }
    if (!sameAddress(item.recipient, p.offerer)) {
      fail(`Swap consideration item ${i} (an NFT) must be delivered to the swap's own maker.`);
    }
    const tokenId = toBig(item.identifierOrCriteria, `consideration[${i}].identifier`).toString();
    const key = `${item.token.toLowerCase()}:${tokenId}`;
    if (seenConsideration.has(key)) fail("Swap asks for the same token more than once.");
    seenConsideration.add(key);
    considerationItems.push({ contractAddress: item.token.toLowerCase(), tokenId });
  }
  if (considerationItems.length === 0) {
    fail("A swap must ask for at least one NFT in return -- use a plain listing for a pure-ETH sale.");
  }
  if (considerationItems.length > maxItemsPerSide) {
    fail(`A swap may ask for at most ${maxItemsPerSide} NFTs in return.`);
  }

  if (considerationNativeToMaker > BigInt(0)) {
    const expected = (considerationNativeToMaker * BigInt(MARKETPLANK_SWAP_FEE_BPS)) / BigInt(10_000);
    const tolerance = expected / BigInt(100) + BigInt(1); // 1% + 1 wei, same tolerance every other fee check uses
    if (feePaid + tolerance < expected) fail("Swap does not pay the marketplace fee.");
    if (feePaid > expected + tolerance) fail("Swap overpays the marketplace fee.");
  } else {
    const flatFee = BigInt(MARKETPLANK_SWAP_FLAT_FEE_WEI);
    if (feePaid < flatFee) {
      fail("A pure NFT-for-NFT swap (no ETH top-up) must pay the flat marketplace fee.");
    }
  }

  return {
    maker: p.offerer.toLowerCase(),
    offerItems,
    considerationItems,
    considerationNativeWei: considerationNativeToMaker.toString(),
    expiresAt: endTimeToIso(p),
  };
}
