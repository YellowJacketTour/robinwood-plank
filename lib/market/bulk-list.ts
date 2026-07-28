import { parseTokenAmount } from "@/lib/trade";
import type { ListInput } from "@/lib/market/seaport";
import type { MarketCollection } from "@/lib/market/types";

/**
 * Bulk listing — select many owned tokens, price them (one price for all or a
 * unique price each), sign a Seaport listing PER ITEM, publish each to the
 * relay.
 *
 * SECURITY MODEL (docs/marketplank/AUDIT-2026-07-27):
 * - There is NO parallel order-construction path. Every order is built by the
 *   same `buildListing` in lib/market/seaport.ts that the single-item
 *   ListForm calls, with inputs produced by `makeListingInput` /
 *   `makeListingPostBody` below — helpers that ListForm itself now uses, so
 *   the two flows cannot drift apart. Fee handling, expiry, collection
 *   address and the POST body shape are identical by construction.
 * - N ITEMS = N SIGNATURES, deliberately. seaport-js 4.1.5 does expose
 *   `createBulkOrders` (EIP-712 merkle bulk signing), but a bulk signature is
 *   NOT a plain 65-byte ECDSA over the single-order digest — it is a
 *   signature over a merkle root plus an encoded proof, and the relay's
 *   hardened signature gate (lib/market/signature.ts, the CRITICAL-1 fix)
 *   rejects any signature that is not 64/65-byte ECDSA recovering to the
 *   offerer. Accepting bulk signatures would mean WIDENING that gate on a
 *   live production system with no live-chain way to verify the new
 *   encoding end-to-end. FAIL CLOSED: individual signatures only, until a
 *   verified bulk path exists on both sides.
 * - Partial failure is first-class: each item carries its own status. A
 *   SIGNING failure (user rejected / wallet error) stops the run and marks
 *   the rest "skipped" — continuing would spam wallet prompts. A PUBLISH
 *   failure (relay rejected one order) records the error and continues,
 *   because the remaining orders are already independent.
 */

export type PricingMode = "same" | "per-item";

export type SelectedItem = {
  collection: MarketCollection;
  tokenId: string;
};

export type BulkPriceResult =
  | { ok: true; prices: Map<string, bigint> } // key: `${slug}:${tokenId}` → wei
  | { ok: false; error: string };

export function itemKey(item: SelectedItem): string {
  return `${item.collection.slug}:${item.tokenId}`;
}

/**
 * Validate the pricing form into per-item wei amounts. FAIL CLOSED: any
 * missing, malformed, zero or negative price rejects the whole submission —
 * never silently drop or default an item's price.
 */
export function resolveBulkPrices(
  mode: PricingMode,
  samePrice: string,
  perItemPrices: Record<string, string>,
  selected: SelectedItem[]
): BulkPriceResult {
  if (selected.length === 0) return { ok: false, error: "Select at least one item." };

  const prices = new Map<string, bigint>();
  if (mode === "same") {
    const wei = parseTokenAmount(samePrice, 18);
    if (wei === null || wei <= BigInt(0)) {
      return { ok: false, error: "Enter a valid ETH price." };
    }
    for (const item of selected) prices.set(itemKey(item), wei);
    return { ok: true, prices };
  }

  for (const item of selected) {
    const key = itemKey(item);
    const raw = perItemPrices[key];
    if (raw === undefined || raw.trim() === "") {
      return { ok: false, error: `Missing price for #${item.tokenId}.` };
    }
    const wei = parseTokenAmount(raw, 18);
    if (wei === null || wei <= BigInt(0)) {
      return { ok: false, error: `Invalid price for #${item.tokenId}.` };
    }
    prices.set(key, wei);
  }
  return { ok: true, prices };
}

/**
 * The EXACT ListInput the single-listing flow builds — shared so the bulk
 * path cannot construct a different (weaker) order shape. Any change here
 * changes both flows together.
 */
export function makeListingInput(
  collection: MarketCollection,
  tokenId: string,
  priceWei: bigint,
  expiresAt: string
): ListInput {
  return {
    offerTokenAddress: collection.contractAddress,
    offerTokenId: tokenId.trim(),
    considerationWei: priceWei.toString(),
    expiresAt,
    feeBps: collection.feeBps,
  };
}

/** The EXACT relay POST body the single-listing flow sends — shared for the
 * same reason as makeListingInput. */
export function makeListingPostBody(
  collection: MarketCollection,
  tokenId: string,
  maker: string,
  priceWei: bigint,
  expiresAt: string,
  rawOrder: unknown
): Record<string, unknown> {
  return {
    kind: "listing",
    collectionSlug: collection.slug,
    tokenId: tokenId.trim(),
    maker,
    priceWei: priceWei.toString(),
    expiresAt,
    rawOrder,
  };
}

export type BulkItemState = "pending" | "signing" | "publishing" | "listed" | "failed" | "skipped";

export type BulkItemStatus = {
  key: string;
  tokenId: string;
  collectionSlug: string;
  state: BulkItemState;
  error?: string;
};

export type BulkListDeps = {
  /** MUST be lib/market/seaport.ts buildListing (injectable only for tests). */
  buildListing: (account: string, input: ListInput) => Promise<unknown>;
  /** POST one order body to /api/market/orders. Throws on network error;
   * returns { ok, message } from the relay. */
  postOrder: (body: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
};

export async function defaultPostOrder(
  body: Record<string, unknown>
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/market/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: res.ok, message: data.message };
}

/**
 * Sign + publish every selected item sequentially (each signature is its own
 * wallet prompt; parallel prompts are hostile UX and some wallets drop them).
 * Returns the final per-item statuses; `onProgress` receives a fresh copy on
 * every state change so the UI can render live.
 */
export async function listBulkItems(
  account: string,
  selected: SelectedItem[],
  prices: Map<string, bigint>,
  durationDays: number,
  deps: BulkListDeps,
  onProgress?: (statuses: BulkItemStatus[]) => void
): Promise<BulkItemStatus[]> {
  const statuses: BulkItemStatus[] = selected.map((item) => ({
    key: itemKey(item),
    tokenId: item.tokenId,
    collectionSlug: item.collection.slug,
    state: "pending",
  }));
  const emit = () => onProgress?.(statuses.map((s) => ({ ...s })));
  emit();

  for (let i = 0; i < selected.length; i += 1) {
    const item = selected[i];
    const status = statuses[i];
    const wei = prices.get(status.key);
    if (wei === undefined || wei <= BigInt(0)) {
      // Should be unreachable (resolveBulkPrices runs first) — fail closed,
      // never sign an order whose price we can't account for.
      status.state = "failed";
      status.error = "No validated price for this item.";
      emit();
      continue;
    }

    // Per-item expiry computed at sign time, same formula as ListForm.
    const expiresAt = new Date(Date.now() + durationDays * 86_400_000).toISOString();

    let rawOrder: unknown;
    try {
      status.state = "signing";
      emit();
      rawOrder = await deps.buildListing(account, makeListingInput(item.collection, item.tokenId, wei, expiresAt));
    } catch (e) {
      // Wallet-level failure (rejected / disconnected): stop — every further
      // item would pop another prompt the user just declined.
      status.state = "failed";
      status.error = e instanceof Error ? e.message : "Signing failed.";
      for (let j = i + 1; j < statuses.length; j += 1) statuses[j].state = "skipped";
      emit();
      break;
    }

    try {
      status.state = "publishing";
      emit();
      const res = await deps.postOrder(
        makeListingPostBody(item.collection, item.tokenId, account, wei, expiresAt, rawOrder)
      );
      if (!res.ok) throw new Error(res.message || "The relay rejected this listing.");
      status.state = "listed";
    } catch (e) {
      // Relay-level failure: this order is signed but unpublished. Record it
      // and continue — the remaining items are independent.
      status.state = "failed";
      status.error = e instanceof Error ? e.message : "Publishing failed.";
    }
    emit();
  }
  return statuses;
}
