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
   * Foreign listings are never given a Buy button. OpenSea's orders reference
   * a conduit we do not control and pay no creator royalty, and our own
   * order-validation deliberately fails closed on a non-zero conduitKey.
   * PulpMarket's public API is read-only and exposes no signature at all, so
   * there is nothing to fulfil even in principle. They link out instead, so
   * the venue that settles the trade is the venue the buyer chose.
   *
   * TEST FOR "FOREIGN" WITH isForeignListing(), NEVER `venue === "opensea"`.
   * Absence-means-ours plus a widening union is a trap: a comparison against
   * one literal silently routes every OTHER foreign venue into the ours
   * branch, which is how a Buy button ends up on an order nobody can fill.
   */
  venue?: ListingVenue;
  /** Where to send the buyer for a foreign listing. */
  externalUrl?: string;
};

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
