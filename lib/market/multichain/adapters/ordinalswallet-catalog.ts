/**
 * Keyless Bitcoin collection catalog from turbo.ordinalswallet.com.
 * UniSat's collection-indexer and auction/list are the buy-book, but they
 * 403 with -2006 under the current key quota -- verified live 2026-08-20
 * against bitcoin-wizards. This endpoint returned the full 1337-item
 * collection in one call, with real inscription ids, names, previewable
 * content, and escrow satoshi prices when an item is listed. Never used as
 * a UniSat auctionId (buy still needs UniSat's book).
 */
import { satsToPriceWei } from "@/lib/market/multichain/trading/solana-bitcoin-listings";

export type BitcoinCatalogToken = {
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
};

export type BitcoinCatalogListing = {
  id: string;
  tokenId: string;
  maker: string;
  priceWei: string;
  imageUrl: string | null;
  name: string | null;
};

type OwInscription = {
  id?: string;
  meta?: { name?: string | null } | null;
  escrow?: { satoshi_price?: number | null; seller_address?: string | null } | null;
};

const cache = new Map<string, { at: number; tokens: BitcoinCatalogToken[]; listings: BitcoinCatalogListing[] }>();
const TTL_MS = 5 * 60_000;

export async function fetchOrdinalsWalletCatalog(collectionSlug: string): Promise<{
  tokens: BitcoinCatalogToken[];
  listings: BitcoinCatalogListing[];
}> {
  const hit = cache.get(collectionSlug);
  if (hit && Date.now() - hit.at < TTL_MS) return { tokens: hit.tokens, listings: hit.listings };

  const res = await fetch(`https://turbo.ordinalswallet.com/collection/${encodeURIComponent(collectionSlug)}/inscriptions`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { tokens: [], listings: [] };
  const rows = (await res.json()) as OwInscription[];
  if (!Array.isArray(rows)) return { tokens: [], listings: [] };

  const tokens: BitcoinCatalogToken[] = [];
  const listings: BitcoinCatalogListing[] = [];
  for (const row of rows) {
    if (!row.id) continue;
    const name = row.meta?.name ?? null;
    const imageUrl = `https://ordinals.com/content/${row.id}`;
    tokens.push({ tokenId: row.id, name, imageUrl });
    const sats = row.escrow?.satoshi_price;
    if (typeof sats === "number" && Number.isFinite(sats) && sats > 0) {
      listings.push({
        id: `ow:${row.id}`,
        tokenId: row.id,
        maker: row.escrow?.seller_address ?? "",
        priceWei: satsToPriceWei(sats),
        imageUrl,
        name,
      });
    }
  }
  cache.set(collectionSlug, { at: Date.now(), tokens, listings });
  return { tokens, listings };
}
