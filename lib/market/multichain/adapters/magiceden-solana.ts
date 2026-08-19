/**
 * Magic Eden adapter -- Solana, the first non-EVM ecosystem this index
 * covers. Proves the ChainAdapter abstraction (lib/market/multichain/types.ts)
 * actually generalizes across ecosystems, not just across EVM chains: unlike
 * alchemy-nft.ts, there is no eth_getLogs, no wei, no contract address --
 * `contractAddress` here is repurposed to carry the collection's Magic Eden
 * SYMBOL (its slug, e.g. "degods"), since Solana NFT collections have no
 * single canonical on-chain contract address the way ERC-721 does.
 *
 * Verified live against the real endpoint before writing this (not assumed
 * from docs): GET /v2/collections/degods/stats confirmed working, NO API key
 * required at all, on 2026-08-17 -- floorPrice 5,337,500,000 lamports
 * (5.3375 SOL), listedCount 397. The collection-metadata endpoint
 * (/v2/collections/:symbol) hit a tighter undocumented per-minute limit on
 * the same pass, so this adapter deliberately does NOT call it -- name/image
 * come from the seed registry instead (see scripts/seed-multichain-collections.ts),
 * same as any collection this app doesn't have a metadata source for.
 */
import type { ChainAdapter, CollectionSnapshot, DiscoveredCollection } from "@/lib/market/multichain/types";

type MagicEdenStats = {
  floorPrice?: number | null;
  listedCount?: number | null;
};

/**
 * Ranked-discovery entry from stats-mainnet.magiceden.io's public
 * collection_stats/search endpoint. Confirmed live 2026-08-17: no API key,
 * sort=volume|floorPrice (the exact param name came from the endpoint's own
 * validation error, not a guess), limit up to 500 in a single call (no
 * pagination needed), and — important — `fp` here is DECIMAL SOL, unlike
 * the per-collection /v2/collections/:symbol/stats endpoint's
 * `floorPrice`, which is LAMPORTS. Mixing those units up would have been a
 * real, silent bug (roughly 1e9x off), which is exactly why this file keeps
 * its own conversion helper next to each call site rather than a single
 * shared "the API returns lamports" assumption.
 */
type MagicEdenRankedEntry = {
  collectionSymbol: string;
  name?: string | null;
  image?: string | null;
  vol?: number | null;
  fp?: number | null;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`magiceden-solana: ${res.status} ${res.statusText} fetching ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * Stored alongside every other chain's price as a wei-equivalent string
 * (see alchemy-nft.ts's toWeiString for the same reasoning) -- SOL has 9
 * decimals (lamports), not 18, so this is NOT a straight lamports passthrough:
 * scaling to an 18-decimal-equivalent string keeps every row in
 * plank_multichain_snapshots comparable by magnitude even though the
 * currency differs, which floor_price_currency records for display.
 */
function lamportsToScaledString(lamports: number): string | null {
  if (!Number.isFinite(lamports) || lamports <= 0) return null;
  // lamports (9dp) * 1e9 = 18dp-equivalent integer, done in BigInt to avoid
  // float drift on values this large.
  return (BigInt(Math.round(lamports)) * BigInt(1_000_000_000)).toString();
}

export const magicEdenSolanaAdapter: ChainAdapter = {
  name: "magiceden-solana",
  async discoverTopCollections({ metric, limit }): Promise<DiscoveredCollection[]> {
    const sort = metric === "floorPrice" ? "floorPrice" : "volume";
    const entries = await fetchJson<MagicEdenRankedEntry[]>(
      `https://stats-mainnet.magiceden.io/collection_stats/search/all?window=1d&limit=${limit}&sort=${sort}&direction=desc`
    );
    return entries.map((entry, i) => ({
      contractAddress: entry.collectionSymbol,
      name: entry.name ?? null,
      imageUrl: entry.image ?? null,
      volumeRank: metric === "volume" ? i + 1 : null,
      floorPriceRank: metric === "floorPrice" ? i + 1 : null,
    }));
  },
  async fetchSnapshot({ contractAddress: symbol }): Promise<CollectionSnapshot> {
    const stats = await fetchJson<MagicEdenStats>(
      `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/stats`
    );

    const floorLamports = stats.floorPrice ?? null;
    return {
      name: null, // no metadata call -- see header comment
      imageUrl: null,
      externalUrl: `https://magiceden.io/marketplace/${symbol}`,
      floorPriceWei: floorLamports != null ? lamportsToScaledString(floorLamports) : null,
      floorPriceCurrency: "SOL",
      floorPriceMarketplace: "magiceden",
      totalSupply: null, // not returned by /stats
      listedCount: stats.listedCount ?? null,
    };
  },
};
