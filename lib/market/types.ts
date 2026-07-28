/** Shared shapes for Marketplank. See docs/marketplank/SPEC.md. */

export type MarketTab = "buy-sell" | "offers" | "activity" | "swap" | "positions";

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
};

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
   * The token's own artwork, resolved once at listing time. Showing the
   * collection logo for every item makes a grid look broken or fake — the art
   * is the product. Falls back to the collection image only if resolution
   * fails.
   */
  imageUrl?: string;
};

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
  /** Resolved token art; absent for collection-wide offers. */
  imageUrl?: string;
};
