/**
 * DeFiLlama NFT API adapter (nft.llama.fi) -- Ethereum mainnet only.
 *
 * WHY THIS EXISTS
 * ----------------
 * The chase for a free EVM ranking API hit real dead ends this session:
 * Reservoir/SimpleHash shut down in 2025; Magic Eden's Reservoir-powered
 * v4 EVM API is PERMANENTLY retired (Magic Eden exited EVM/Bitcoin
 * entirely, March-April 2026, confirmed via live 503s + news of the
 * shutdown -- not a temporary outage); Moralis's documented
 * hottest-collections/top-collections routes 404 on a verified-valid key
 * (the SDK ships the route, the backend doesn't serve it -- looks
 * deprecated, not plan-gated: the live dashboard has no Market Data
 * product listed at all); NFTScan's key authenticates but every call,
 * even the cheapest, 403s with "Up to maximum CU usage" on a brand-new
 * account (the advertised free signup CU never actually landed).
 *
 * DeFiLlama's NFT endpoint is the one that actually works exactly as
 * advertised: verified live 2026-08-17, GET https://nft.llama.fi/collections
 * with NO auth, NO key, NO rate-limit hit across repeated calls, returning
 * floor price + name + image + totalSupply for 4,118 tracked collections in
 * one response. DeFiLlama is a long-running, widely-used, proven free data
 * source (not a startup that might vanish next quarter) -- the strongest
 * "actually free, actually works" find of this whole investigation.
 *
 * THE REAL LIMITATION
 * --------------------
 * Confirmed live: neither /collections nor /collection/:id expose a volume
 * field -- only floorPrice + floorPricePctChange1Day/7Day. This adapter is
 * therefore floor-price-ranking ONLY; discoverTopCollections({metric:
 * "volume"}) returns an empty array rather than guessing or throwing (see
 * that method's comment). Real top-by-volume EVM coverage still comes from
 * this app's self-hosted activity ranking (see
 * lib/market/multichain/discovery/evm-log-scan.ts's recordActivity /
 * getTopByActivity), which is unaffected by any of this.
 *
 * Also confirmed live: no chain field is present on any record, and every
 * spot-checked collectionId is an Ethereum mainnet contract address (the
 * image CDN URLs are literally img.reservoir.tools, suggesting DeFiLlama's
 * NFT tracking inherited its dataset from Reservoir's infrastructure before
 * that shut down) -- so this adapter only maps to "eth-mainnet".
 */
import type { ChainAdapter, CollectionSnapshot, DiscoveredCollection } from "@/lib/market/multichain/types";

type LlamaCollection = {
  collectionId: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  totalSupply: number | null;
  onSaleCount: number | null;
  floorPrice: number | null;
};

const COLLECTIONS_URL = "https://nft.llama.fi/collections";
const COLLECTION_URL = "https://nft.llama.fi/collection";

// A single GET returns the whole dataset (~4k rows, no pagination) -- cache
// it in-process for a short window so a batch of fetchSnapshot calls in one
// sync run (see sync.ts) doesn't refetch 4k rows per collection.
let cache: { at: number; rows: LlamaCollection[] } | null = null;
const CACHE_TTL_MS = 60_000;

async function fetchAllCollections(): Promise<LlamaCollection[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const res = await fetch(COLLECTIONS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`defillama-nft: ${res.status} ${res.statusText} fetching ${COLLECTIONS_URL}`);
  const rows = (await res.json()) as LlamaCollection[];
  cache = { at: Date.now(), rows };
  return rows;
}

/** The bulk feed can repeat one marketplace-level aggregate across every
 * contract grouped into that collection. Its XCOPY Editions rows currently
 * share the same 1,416 supply even though the exact-contract endpoint reports
 * 20, 74 and 83 respectively. Read identity/supply from the exact endpoint;
 * retain bulk floor/book fields only as marketplace-group evidence. */
async function fetchExactCollection(contractAddress: string): Promise<LlamaCollection | null> {
  const response = await fetch(`${COLLECTION_URL}/${encodeURIComponent(contractAddress)}`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as LlamaCollection[] | LlamaCollection;
  return Array.isArray(body) ? body[0] ?? null : body;
}

/**
 * Same 18-decimal-equivalent wei string every other adapter in this
 * directory uses -- DeFiLlama reports floorPrice as decimal ETH.
 */
function toWeiString(decimalAmount: number | null): string | null {
  if (decimalAmount == null || !Number.isFinite(decimalAmount) || decimalAmount <= 0) return null;
  const scaled = Math.round(decimalAmount * 1e9);
  return (BigInt(scaled) * BigInt(1_000_000_000)).toString();
}

/**
 * Same real bug class fixed in alchemy-nft.ts's MAX_PLAUSIBLE_TOTAL_SUPPLY
 * (confirmed live 2026-08-19 on arb-mainnet contracts via the sibling
 * adapter): `total_supply` is a Postgres BIGINT column, and an unsanitized
 * huge/malformed supply value either overflows it or serializes to
 * scientific-notation text BIGINT's parser rejects outright, failing the
 * whole snapshot write. DeFiLlama's own data has not been observed doing
 * this, but the write path is identical, so the same ceiling applies here
 * defensively rather than waiting to hit the same outage from this source.
 */
const MAX_PLAUSIBLE_TOTAL_SUPPLY = 100_000_000;

function sanitizeTotalSupply(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_TOTAL_SUPPLY ? value : null;
}

export const defillamaNftAdapter: ChainAdapter = {
  name: "defillama-nft",
  async fetchSnapshot({ contractAddress }): Promise<CollectionSnapshot> {
    const rows = await fetchAllCollections();
    const match = rows.find((r) => r.collectionId.toLowerCase() === contractAddress.toLowerCase());
    if (!match) {
      throw new Error(`defillama-nft: ${contractAddress} not in nft.llama.fi/collections`);
    }
    const exact = await fetchExactCollection(contractAddress).catch(() => null);
    return {
      name: exact?.name ?? match.name,
      imageUrl: exact?.image ?? match.image,
      externalUrl: null, // DeFiLlama's collection payload has no marketplace link field
      floorPriceWei: toWeiString(match.floorPrice),
      floorPriceCurrency: match.floorPrice != null ? "ETH" : null,
      floorPriceMarketplace: match.floorPrice != null ? "defillama" : null,
      totalSupply: sanitizeTotalSupply(exact?.totalSupply ?? match.totalSupply),
      listedCount: match.onSaleCount,
    };
  },

  async discoverTopCollections({ metric, limit }): Promise<DiscoveredCollection[]> {
    if (metric === "volume") {
      // Confirmed live: no volume field anywhere in this API. Returning []
      // rather than throwing keeps discover-multichain-collections.ts's
      // Promise.all([volume, floorPrice]) from failing the whole chain over
      // a metric this source simply doesn't have -- the floorPrice half
      // still runs.
      return [];
    }
    const rows = await fetchAllCollections();
    const ranked = [...rows]
      .filter((r) => r.floorPrice != null && r.floorPrice > 0)
      .sort((a, b) => (b.floorPrice ?? 0) - (a.floorPrice ?? 0))
      .slice(0, limit);
    return ranked.map((r, i) => ({
      contractAddress: r.collectionId,
      name: r.name,
      imageUrl: r.image,
      volumeRank: null,
      floorPriceRank: i + 1,
    }));
  },
};
