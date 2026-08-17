/**
 * Alchemy NFT API adapter -- covers any EVM chain Alchemy indexes (Ethereum,
 * Polygon, Arbitrum, Base, Optimism, and others; NOT Solana or non-EVM
 * chains, which need their own adapter -- see this directory's other files
 * as they're added).
 *
 * Verified live against the real endpoint before writing this (not assumed
 * from memory): getContractMetadata and getFloorPrice both confirmed working
 * with Alchemy's public "demo" key against Bored Ape Yacht Club
 * (0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d) on 2026-08-17. The "demo" key
 * is Alchemy's own shared, heavily-rate-limited docs key -- fine for proving
 * this adapter works, NOT a production credential. Set ALCHEMY_API_KEY for
 * real use; sync.ts logs a warning (not a hard failure) when it falls back
 * to "demo", so a misconfigured deploy is visible in logs rather than
 * silently rate-limited into uselessness.
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";

/**
 * Alchemy's network subdomain per chainSlug. This is the ONE place that
 * needs a new line when Alchemy adds NFT API support for another chain --
 * everything else in this adapter is chain-agnostic.
 */
const ALCHEMY_NETWORK_SUBDOMAIN: Record<string, string> = {
  "eth-mainnet": "eth-mainnet",
  "polygon-mainnet": "polygon-mainnet",
  "arb-mainnet": "arb-mainnet",
  "base-mainnet": "base-mainnet",
  "opt-mainnet": "opt-mainnet",
  // BNB Smart Chain, Avalanche, zkSync -- confirmed live 2026-08-17 (both
  // the NFT API subdomain AND the raw Node API /v2/ endpoint responded
  // correctly, not just DNS-resolved) before being added here.
  "bnb-mainnet": "bnb-mainnet",
  "avax-mainnet": "avax-mainnet",
  "zksync-mainnet": "zksync-mainnet",
};

function apiKey(): string {
  return process.env.ALCHEMY_API_KEY?.trim() || "demo";
}

function baseUrl(chainSlug: string): string {
  const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    throw new Error(
      `alchemy-nft adapter has no network mapping for chainSlug "${chainSlug}" -- ` +
        `add it to ALCHEMY_NETWORK_SUBDOMAIN once confirmed live against Alchemy's docs.`
    );
  }
  return `https://${subdomain}.g.alchemy.com/nft/v3/${apiKey()}`;
}

type AlchemyContractMetadata = {
  name?: string | null;
  totalSupply?: string | null;
  openSeaMetadata?: {
    collectionName?: string | null;
    imageUrl?: string | null;
    externalUrl?: string | null;
    floorPrice?: number | null;
  } | null;
};

type AlchemyFloorPriceMarketplace = {
  floorPrice?: number | null;
  priceCurrency?: string | null;
  error?: string | null;
};

type AlchemyFloorPriceResponse = {
  openSea?: AlchemyFloorPriceMarketplace | null;
  looksRare?: AlchemyFloorPriceMarketplace | null;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`alchemy-nft: ${res.status} ${res.statusText} fetching ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * A human-currency floor price (Alchemy reports these as decimal ETH/MATIC/
 * etc, not wei) converted to a wei-equivalent string for storage alongside
 * the Robinhood-chain ledger's own NUMERIC(78,0) price columns -- so every
 * price in the multichain snapshot table is comparable without a per-row
 * unit lookup. Assumes 18 decimals, true for every network this adapter
 * currently maps (ETH-denominated L1s/L2s); a non-18-decimal native token
 * would need its own conversion here, not a silent wrong answer.
 */
function toWeiString(decimalAmount: number): string | null {
  if (!Number.isFinite(decimalAmount) || decimalAmount <= 0) return null;
  // Avoid floating-point drift on the multiplication by working in
  // fixed-point: shift 18 decimals via string math on a scaled integer.
  const scaled = Math.round(decimalAmount * 1e9); // 9 of the 18 decimals now integral
  return (BigInt(scaled) * BigInt(1_000_000_000)).toString(); // remaining 1e9 as a bigint multiply
}

/** Picks the lowest real (non-error, positive) floor across marketplaces. */
function pickLowestFloor(
  floors: AlchemyFloorPriceResponse
): { priceWei: string | null; currency: string | null; marketplace: string | null } {
  const candidates: Array<[string, AlchemyFloorPriceMarketplace | null | undefined]> = [
    ["opensea", floors.openSea],
    ["looksrare", floors.looksRare],
  ];
  let best: { priceWei: string; currency: string; marketplace: string; raw: number } | null = null;
  for (const [marketplace, entry] of candidates) {
    if (!entry || entry.error || entry.floorPrice == null) continue;
    const priceWei = toWeiString(entry.floorPrice);
    if (!priceWei) continue;
    if (!best || entry.floorPrice < best.raw) {
      best = { priceWei, currency: entry.priceCurrency ?? "ETH", marketplace, raw: entry.floorPrice };
    }
  }
  return best
    ? { priceWei: best.priceWei, currency: best.currency, marketplace: best.marketplace }
    : { priceWei: null, currency: null, marketplace: null };
}

export const alchemyNftAdapter: ChainAdapter = {
  name: "alchemy-nft",
  async fetchSnapshot({ chainSlug, contractAddress }): Promise<CollectionSnapshot> {
    const base = baseUrl(chainSlug);
    const [metadata, floors] = await Promise.all([
      fetchJson<AlchemyContractMetadata>(
        `${base}/getContractMetadata?contractAddress=${contractAddress}`
      ),
      fetchJson<AlchemyFloorPriceResponse>(
        `${base}/getFloorPrice?contractAddress=${contractAddress}`
      ).catch(() => ({}) as AlchemyFloorPriceResponse), // floor pricing is best-effort, metadata is not
    ]);

    const floor = pickLowestFloor(floors);
    const totalSupply = metadata.totalSupply != null ? Number(metadata.totalSupply) : null;

    return {
      name: metadata.openSeaMetadata?.collectionName ?? metadata.name ?? null,
      imageUrl: metadata.openSeaMetadata?.imageUrl ?? null,
      externalUrl: metadata.openSeaMetadata?.externalUrl ?? null,
      floorPriceWei: floor.priceWei,
      floorPriceCurrency: floor.currency,
      floorPriceMarketplace: floor.marketplace,
      totalSupply: Number.isFinite(totalSupply) ? totalSupply : null,
      // Alchemy's NFT API does not expose a live listed-count in these two
      // calls -- left null rather than guessed. A future adapter revision
      // could add getNFTsForContract pagination totals if this matters.
      listedCount: null,
    };
  },
};
