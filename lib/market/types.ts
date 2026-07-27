/** Shared shapes for Marketplank. See docs/marketplank/SPEC.md. */

export type MarketTab = "buy-sell" | "offers" | "swap" | "positions";

export type CollectionTrustBadge = "lp-burned" | "ownership-renounced" | "verified";

/** A collection allowed to list on Marketplank. Curated allowlist in Phase 1 — see SPEC.md §7. */
export type MarketCollection = {
  slug: string;
  name: string;
  contractAddress: string;
  /** ERC-721 or ERC-1155 — Seaport supports both, vault/AMM (Phase 2) is 721-only for now. */
  tokenStandard: "ERC721" | "ERC1155";
  image: string;
  trustBadges: CollectionTrustBadge[];
  /** Slug of the collection this one is an official derivative of, if any. */
  derivativeOf?: string;
  /** Vault contract address once a Phase 2 instant-liquidity pool exists for this collection. */
  vaultAddress?: string;
};

export type Listing = {
  id: string;
  collectionSlug: string;
  tokenId: string;
  seller: string;
  priceWei: string;
  /** ISO 8601 */
  expiresAt: string;
  kind: "fixed" | "dutch-auction";
};

export type Offer = {
  id: string;
  collectionSlug: string;
  /** Absent for collection-wide offers. */
  tokenId?: string;
  /** Present when the offer targets a set of traits rather than one token or the whole collection. */
  traits?: Array<{ traitType: string; value: string }>;
  buyer: string;
  priceWei: string;
  expiresAt: string;
};
