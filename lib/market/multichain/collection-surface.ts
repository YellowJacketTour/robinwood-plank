/**
 * Collection page contract — the Milady outcome, per chain.
 *
 * Two feeds, never spliced:
 *   catalog = every piece (rarity index / ME / UniSat / OW)
 *   book    = live listings (OS / ME / UniSat)
 * The grid is the catalog. The book only overlays Buy/price on matching
 * token ids (see tokenIdAliases). Listed-only is the book sorted by price.
 *
 * Writers (mesh lanes) must not DELETE catalog rows to refresh stats.
 * Reindex only when sample is empty or a small first-pass cap.
 *
 * Extend this map for a new chain — do not add a second grid in the view.
 */
export type CollectionSurface = {
  chainSlug: string;
  catalogPageSize: number;
  bookPageSize: number;
  catalog: string;
  book: string;
  art: string;
};

const EVM: Omit<CollectionSurface, "chainSlug"> = {
  catalogPageSize: 400,
  bookPageSize: 200,
  catalog: "plank_foreign_rarity + OpenSea NFT walk",
  book: "OpenSea listings",
  art: "proven ERC-721 template, else OS /nfts/{id}, else stored image_url",
};

export const COLLECTION_SURFACES: Record<string, CollectionSurface> = {
  "eth-mainnet": { chainSlug: "eth-mainnet", ...EVM },
  "polygon-mainnet": { chainSlug: "polygon-mainnet", ...EVM },
  "base-mainnet": { chainSlug: "base-mainnet", ...EVM },
  "arb-mainnet": { chainSlug: "arb-mainnet", ...EVM },
  "opt-mainnet": { chainSlug: "opt-mainnet", ...EVM },
  "bnb-mainnet": { chainSlug: "bnb-mainnet", ...EVM },
  "avax-mainnet": { chainSlug: "avax-mainnet", ...EVM },
  "solana-mainnet": {
    chainSlug: "solana-mainnet",
    catalogPageSize: 800,
    bookPageSize: 200,
    catalog: "foreign rarity (Helius DAS) else ME listings/activities",
    book: "Magic Eden listings",
    art: "ME token.image, never lowercase mints",
  },
  "bitcoin-mainnet": {
    chainSlug: "bitcoin-mainnet",
    catalogPageSize: 800,
    bookPageSize: 200,
    catalog: "foreign rarity else OW catalog else UniSat items",
    book: "UniSat auction list",
    art: "ordinals.com/content/{inscriptionId} (not /preview)",
  },
  robinhood: {
    chainSlug: "robinhood",
    catalogPageSize: 400,
    bookPageSize: 400,
    catalog: "native rarity + gallery",
    book: "native Seaport + plank.love overlay",
    art: "/images and token metadata, never dns in the client",
  },
};

export function collectionSurface(chainSlug: string): CollectionSurface {
  return (
    COLLECTION_SURFACES[chainSlug] ?? {
      chainSlug,
      catalogPageSize: 400,
      bookPageSize: 200,
      catalog: "rarity index if present",
      book: "chain venue if any",
      art: "stored url only",
    }
  );
}
