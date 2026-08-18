/** Shared shapes for Marketplank. See docs/marketplank/SPEC.md. */

export type MarketTab = "buy-sell" | "offers" | "activity" | "swap" | "my-nfts" | "positions";

export type CollectionTrustBadge = "lp-burned" | "ownership-renounced" | "verified";

/** A collection allowed to list on Marketplank. Curated allowlist in Phase 1 — see SPEC.md §7. */
export type MarketCollection = {
  slug: string;
  name: string;
  contractAddress: string;
  /**
   * ERC-721 or ERC-1155 — Seaport supports both, but the order validator
   * currently REJECTS ERC-1155 collections outright (no audited quantity
   * model; see order-validation.ts). Vault/AMM (Phase 2) is 721-only too.
   */
  tokenStandard: "ERC721" | "ERC1155";
  image: string;
  trustBadges: CollectionTrustBadge[];
  /** Slug of the collection this one is an official derivative of, if any. */
  derivativeOf?: string;
  /** Vault contract address once a Phase 2 instant-liquidity pool exists for this collection. */
  vaultAddress?: string;
  /**
   * Marketplace fee for THIS collection's trades, in basis points (100 = 1%).
   * 0 = no fee. Toggle any approved collection's fee on/off or adjust the
   * rate by editing lib/market/collections.ts and redeploying — see
   * MARKET_DEFAULT_FEE_BPS for the default applied to non-PLANK collections.
  */
  feeBps: number;
  /** EIP-2981 creator royalty rate for new signed orders, in basis points. */
  royaltyBps: number;
  /** EIP-2981 creator royalty receiver for new signed orders. */
  royaltyRecipient: string;
};

/**
 * Marketplaces other than ours that we surface listings from. Absence of a
 * venue on a Listing means Marketplank; every member here is display-only.
 */
export type ListingVenue = "opensea" | "pulp";

export type Listing = {
  id: string;
  collectionSlug: string;
  tokenId: string;
  /** Wallet that placed this order — the seller for a listing. */
  maker: string;
  priceWei: string;
  /** ISO 8601 */
  expiresAt: string;
  kind: "fixed" | "dutch-auction";
  /**
   * Internal availability marker. False means the signed order predates
   * mandatory creator royalties and must be relisted before fulfillment.
   */
  royaltyEnforced?: boolean;
  /**
   * The token's own artwork, resolved once at listing time. Showing the
   * collection logo for every item makes a grid look broken or fake — the art
   * is the product. Falls back to the collection image only if resolution
   * fails.
   */
  imageUrl?: string;
  /**
   * Which marketplace holds this order.
   *
   * Absent means Marketplank — our own relay, fulfillable natively with the
   * safety rails in lib/wallet.ts. Any present value means the order lives in
   * a foreign orderbook: the collection genuinely trades elsewhere too, and
   * hiding that would show buyers an incomplete market.
   *
   * On Robinhood Chain, foreign listings are never given a Buy button: an
   * OpenSea order there references a conduit our own order-validation
   * deliberately fails closed on (a Robinhood-Chain-specific safety rail
   * against treating a foreign order as equivalent to our own book), and
   * PulpMarket's public API is read-only with no signature at all, so there
   * is nothing to fulfil even in principle.
   *
   * On a FOREIGN chain (see foreignChainSlug below), a "venue: opensea"
   * listing CAN be genuinely bought — via
   * lib/market/multichain/trading/foreign-fulfill.ts and the deployed
   * MarketplankForeignFeeRouter, which calls the real Seaport contract
   * directly rather than treating the order as part of our own book. That
   * order-validation conduitKey rail doesn't apply here: it exists to
   * protect the integrity of OUR orderbook, and a foreign-chain trade never
   * touches it. Creator royalty is whatever the real order's own
   * consideration embeds (OpenSea's own enforcement), not something this
   * app adds or removes. Check isCrossChainBuyable(), not this field alone,
   * before rendering a Buy affordance.
   *
   * TEST FOR "FOREIGN" WITH isForeignListing(), NEVER `venue === "opensea"`.
   * Absence-means-ours plus a widening union is a trap: a comparison against
   * one literal silently routes every OTHER foreign venue into the ours
   * branch, which is how a Buy button ends up on an order nobody can fill.
   */
  venue?: ListingVenue;
  /** Where to send the buyer for a foreign listing. */
  externalUrl?: string;
  /**
   * Present only for a listing sourced from a chain other than Robinhood
   * Chain — one of lib/market/multichain/trading/foreign-chain-registry.ts's
   * FOREIGN_CHAINS chainSlugs. Undefined means this listing is either ours
   * or a Robinhood-Chain-native foreign listing (Pulp/legacy OpenSea rows).
   */
  foreignChainSlug?: string;
  /**
   * The real order hash, needed to fetch a genuinely fulfillable signed
   * order via fetchListingFulfillmentData() immediately before signing —
   * never cached, since OpenSea's summary/display data (what populates the
   * rest of this Listing) carries no usable signature. Present only when
   * this specific listing is known to be safely re-fetchable that way.
   */
  foreignOrderHash?: string;
  /**
   * Real per-token traits, present only for a foreign listing (see
   * app/api/market/multichain/listings/route.ts) -- resolved from the same
   * OpenSea NFT-detail call already made for imageUrl, at no extra cost.
   * Used by the Details view alongside foreignTraitCounts (fetched
   * separately, collection-wide) to show a real "N% of the collection has
   * this trait" signal -- NOT a full numeric rank, which would require
   * fetching every token in the collection (see traits/route.ts's header).
   */
  traits?: Array<{ traitType: string; value: string }>;
};

/**
 * True only for a foreign listing that can genuinely be bought in-app right
 * now: sourced from OpenSea (the only venue with a proven fulfillment-data
 * path — see foreign-orders.ts), tagged with the foreign chain it lives on,
 * and carrying the order hash needed to re-fetch a real signature. Every
 * other foreign listing (PulpMarket always; a Robinhood-Chain-native
 * OpenSea row) stays View-only — see the Listing.venue doc comment for why
 * those two cases are permanently different, not merely unimplemented.
 */
export function isCrossChainBuyable(
  listing: Pick<Listing, "venue" | "foreignChainSlug" | "foreignOrderHash">
): boolean {
  return listing.venue === "opensea" && Boolean(listing.foreignChainSlug) && Boolean(listing.foreignOrderHash);
}

/**
 * True when this listing is held by a marketplace other than ours.
 *
 * The single question every venue-aware branch actually asks. Foreign means
 * "not fulfillable here" — the reason differs per venue (OpenSea: a conduit
 * we do not control; PulpMarket: a read-only API with no signature) but the
 * consequence is identical, so callers should not care which one it is.
 *
 * Adding a venue to ListingVenue must never require touching a branch again.
 */
export function isForeignListing(listing: Pick<Listing, "venue">): boolean {
  return listing.venue !== undefined;
}

/** Badge text per venue. Absent venue is ours — see MARKETPLANK_VENUE_LABEL. */
export const VENUE_LABELS: Record<ListingVenue, string> = {
  opensea: "OpenSea",
  pulp: "PulpMarket",
};

export const MARKETPLANK_VENUE_LABEL = "Marketplank";

/**
 * What to call the venue holding this listing, ours included.
 *
 * Every listing is labelled, not just foreign ones: if only foreign rows were
 * badged then "unmarked" would have to be inferred as ours, and that
 * inference fails for anyone landing mid-scroll.
 */
export function venueLabel(listing: Pick<Listing, "venue">): string {
  return listing.venue ? VENUE_LABELS[listing.venue] : MARKETPLANK_VENUE_LABEL;
}

/**
 * A legacy order can be displayed for context, but cannot be fulfilled by
 * Marketplank because its signed consideration predates creator royalties.
 * Foreign rows are display-only and must never inherit this state — they are
 * not ours to relist, and telling a holder to relist someone else's listing
 * on another marketplace is nonsense.
 */
export function isMarketplankRelistRequired(
  listing: Pick<Listing, "venue" | "royaltyEnforced">
): boolean {
  return !isForeignListing(listing) && listing.royaltyEnforced === false;
}

export const MARKETPLANK_RELIST_MESSAGE =
  "This listing needs to be unlisted and relisted before it can be purchased on Marketplank.";

export type Offer = {
  id: string;
  collectionSlug: string;
  /** Absent for collection-wide offers. */
  tokenId?: string;
  /** Present when the offer targets a set of traits rather than one token or the whole collection. */
  traits?: Array<{ traitType: string; value: string }>;
  /**
   * TRAIT bids only: the token-id snapshot the signed order's Merkle root
   * commits to, captured at bid-creation time. The accepting seller recomputes
   * the root from this exact list (client-side, trustlessly — see
   * assertAcceptableTraitOffer) and derives their fulfillment proof from it.
   */
  criteriaTokenIds?: string[];
  /** Wallet that placed this order — the buyer for an offer. */
  maker: string;
  priceWei: string;
  expiresAt: string;
  /** False means the signed offer must be relisted before fulfillment. */
  royaltyEnforced?: boolean;
  /** Resolved token art; absent for collection-wide offers. */
  imageUrl?: string;
};
