import { validateListingOrder } from "@/lib/market/order-validation";
import type { DerivedOrder } from "@/lib/market/order-validation";
import type { Listing, MarketCollection } from "@/lib/market/types";

/**
 * "Sweep the floorboards" — plan a batch buy of the N cheapest listings.
 *
 * SECURITY MODEL (same as the single-buy flow, docs/marketplank/AUDIT-2026-07-27):
 * nothing about any order is taken on the relay's word. Every candidate order
 * is re-derived in THIS browser through the EXISTING validateListingOrder —
 * the one audited validation path, no parallel/weaker copy — and the sweep
 * total is the sum of those DERIVED prices, i.e. exactly what the signed
 * orders will charge. Any order that fails validation, disagrees with its
 * relay metadata, or duplicates a token already in the sweep is DROPPED
 * before the wallet is ever prompted, and the total shrinks accordingly.
 */

/**
 * Hard cap on planks per sweep. Keeps calldata/gas bounded and the confirm
 * modal legible; fulfillAvailableAdvancedOrders scales linearly in orders.
 */
export const SWEEP_MAX = 20;

export type SweepItem = {
  listing: Listing & { rawOrder: unknown };
  /** Re-derived in this browser from the signed order — the price that fills. */
  derived: DerivedOrder;
};

export type SweepPlan = {
  /** Validated, deduped, cheapest-first. What the wallet will be asked to fill. */
  items: SweepItem[];
  /** Exact sum of every item's derived priceWei — what the buyer pays if all fill. */
  totalWei: string;
  /** Candidates dropped because their signed order failed re-validation. */
  droppedInvalid: number;
};

/**
 * Build a sweep plan for up to `count` cheapest listings.
 *
 * - Each rawOrder is validated via validateListingOrder (throws → dropped).
 * - Relay-claimed tokenId must match the signature-derived one (else dropped).
 * - The buyer's own listings are excluded (sweeping your own plank is a no-op
 *   that burns gas).
 * - One order per tokenId: two listings of the same plank can't both fill, so
 *   only the cheapest is kept — counting both would overstate what the sweep
 *   can deliver.
 * - Ordering is by DERIVED price ascending, so "cheapest" is judged on the
 *   signed order, never on relay metadata.
 */
export function planSweep(
  listings: Array<Listing & { rawOrder: unknown }>,
  count: number,
  collection: MarketCollection,
  buyerAddress?: string
): SweepPlan {
  const take = Math.max(0, Math.min(Math.floor(count), SWEEP_MAX));
  const valid: SweepItem[] = [];
  let droppedInvalid = 0;

  for (const listing of listings) {
    let derived: DerivedOrder;
    try {
      derived = validateListingOrder(listing.rawOrder, collection);
    } catch {
      droppedInvalid++;
      continue;
    }
    // The relay's claimed token must be the signature-covered one — otherwise
    // the card the user clicked and the order that fills are different planks.
    if (!derived.tokenId || derived.tokenId !== listing.tokenId) {
      droppedInvalid++;
      continue;
    }
    if (buyerAddress && derived.maker === buyerAddress.toLowerCase()) {
      continue; // own listing — excluded, not "invalid"
    }
    valid.push({ listing, derived });
  }

  // Cheapest first, judged on the derived (signed) price.
  valid.sort((a, b) => {
    const pa = BigInt(a.derived.priceWei);
    const pb = BigInt(b.derived.priceWei);
    if (pa !== pb) return pa < pb ? -1 : 1;
    // Stable tie-break so the plan is deterministic.
    return a.listing.id < b.listing.id ? -1 : 1;
  });

  // Dedupe by tokenId, keeping the cheapest (first after sort).
  const seen = new Set<string>();
  const items: SweepItem[] = [];
  for (const item of valid) {
    if (items.length >= take) break;
    if (seen.has(item.derived.tokenId as string)) continue;
    seen.add(item.derived.tokenId as string);
    items.push(item);
  }

  let total = BigInt(0);
  for (const item of items) total += BigInt(item.derived.priceWei);

  return { items, totalWei: total.toString(), droppedInvalid };
}

/**
 * Final gate before the wallet: re-derive every order AGAIN and require the
 * sum to equal the total the user just read on the confirm button. Any drift
 * (an order swapped underneath the plan, a stale plan object, a bug upstream)
 * throws — FAIL CLOSED, nothing reaches the wallet.
 */
export function assertSweepTotal(
  items: SweepItem[],
  expectedTotalWei: string,
  collection: MarketCollection
): void {
  if (items.length === 0) {
    throw new Error("Nothing to sweep.");
  }
  let total = BigInt(0);
  for (const item of items) {
    // Throws OrderValidationError on any tampering — no catch, no drop here:
    // at confirm time a bad order means the DISPLAYED total is wrong, and the
    // only safe response is to abort, not silently re-price.
    const derived = validateListingOrder(item.listing.rawOrder, collection);
    if (derived.tokenId !== item.listing.tokenId) {
      throw new Error("A plank in this sweep doesn't match its signature.");
    }
    total += BigInt(derived.priceWei);
  }
  if (total.toString() !== expectedTotalWei) {
    throw new Error("Sweep total changed — review and try again.");
  }
}
