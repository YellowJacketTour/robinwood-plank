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
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Alchemy's network subdomain per chainSlug. This is the ONE place that
 * needs a new line when Alchemy adds NFT API support for another chain --
 * everything else in this adapter is chain-agnostic.
 */
export const ALCHEMY_NETWORK_SUBDOMAIN: Record<string, string> = {
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

/** Exported so other chain-aware callers (e.g. foreign-chain-registry.ts's foreignRpcUrls) can build an Alchemy URL for a different product path without duplicating the demo-key fallback. */
export function apiKey(): string {
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
  /** Real on-chain deployer address, from Alchemy's own contract metadata -- never fabricated. */
  contractDeployer?: string | null;
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
/**
 * Real, confirmed live 2026-08-18: a base-mainnet contract's Alchemy floor
 * response decoded to 2.592e+29 "ETH" -- obviously corrupt upstream data
 * (more ETH than will ever exist), not a real floor. Unguarded, that
 * reached Postgres as literal scientific-notation text and failed the
 * NUMERIC(78,0) column with "invalid input syntax for type bigint". 10
 * million ETH-equivalent is comfortably above any real floor price this
 * app will ever see (ETH's own total supply is ~120M) while still well
 * below the corrupt value -- a sanity ceiling, not a business rule.
 */
const MAX_PLAUSIBLE_FLOOR_ETH = 10_000_000;

/**
 * Same class of bug as MAX_PLAUSIBLE_FLOOR_ETH above, confirmed live
 * 2026-08-19 on real arb-mainnet contracts: `metadata.totalSupply` is a
 * string Alchemy passes through from whatever the contract's own
 * totalSupply() (or an indexer artifact) reports, with no sanity bound --
 * seen returning "1e+24", a 6.8e7-magnitude float artifact, and
 * 10000000000000000000 (1e19). `total_supply` is a Postgres BIGINT column
 * (max ~9.22e18), and Number(hugeString).toString() serializes to
 * scientific-notation text ("1e+24") once magnitude crosses 1e21, which
 * BIGINT's input parser rejects outright regardless of magnitude -- both
 * failure modes hit the same real INSERT and blocked the sync entirely for
 * every affected contract, not just clamped one bad value. No real NFT
 * collection has anywhere near this many tokens (the largest legitimate
 * collections this app tracks run in the tens of thousands), so this is a
 * sanity ceiling on a corrupt/malicious contract, not a business rule.
 */
const MAX_PLAUSIBLE_TOTAL_SUPPLY = 100_000_000;

function toWeiString(decimalAmount: number): string | null {
  if (!Number.isFinite(decimalAmount) || decimalAmount <= 0 || decimalAmount > MAX_PLAUSIBLE_FLOOR_ETH) return null;
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

/**
 * Alchemy's own openSeaMetadata pass-through carries a real, confirmed
 * upstream data bug: some collections' imageUrl/externalUrl/twitterUsername
 * fields come back as the LITERAL 4-character string "null" (and
 * bannerImageUrl similarly) rather than a real JSON null -- verified live
 * 2026-08-19 via a direct getContractMetadata call for a real registered
 * Base collection (0x76c346...) that returned `"imageUrl": "null"`. This is
 * dirty data OpenSea's own indexer is passing through, not a bug in this
 * app's own code -- but it's exactly what broke Next's <Image> component
 * ("invalid src prop") on the collection detail page, since a truthy
 * 4-char string sails right past every `!imageUrl` falsy check this app
 * had. Sanitized once, here, at the source, so every downstream reader
 * (collection detail pages, the hub, the rankings table) never has to
 * special-case this upstream quirk itself.
 */
function cleanMetadataString(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") return null;
  return trimmed;
}

/**
 * Batch metadata resolution -- getContractMetadataBatch, up to 100
 * contracts per call (Alchemy's own documented cap). Built specifically
 * to fix a real, measured bottleneck: HyperSync discovery
 * (hypersync-evm-scan.ts) can surface 1,000+ candidates in one pass, and
 * resolving them one at a time via fetchSnapshot took ~90 seconds for
 * ~1,350 candidates on eth-mainnet alone, confirmed live 2026-08-20. This
 * collapses that into one HTTP round-trip per 100 contracts.
 *
 * Verified live against the real endpoint before writing this, not
 * assumed from docs (which had it wrong on two points): the response
 * wraps in `{ contracts: [...] }`, NOT a bare array, and the field is
 * `openSeaMetadata` (capital S) -- exactly matching AlchemyContractMetadata
 * above, not the lowercase the docs page's own summary showed. Bonus found
 * live: openSeaMetadata.floorPrice is bundled in this same response, so
 * this one call replaces BOTH fetchSnapshot's getContractMetadata AND its
 * separate getFloorPrice call for every contract in the batch.
 */
const BATCH_SIZE = 100;

export async function fetchSnapshotsBatch(
  chainSlug: string,
  contractAddresses: string[]
): Promise<Map<string, CollectionSnapshot>> {
  const base = baseUrl(chainSlug);
  const results = new Map<string, CollectionSnapshot>();

  for (let i = 0; i < contractAddresses.length; i += BATCH_SIZE) {
    const chunk = contractAddresses.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${base}/getContractMetadataBatch`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ contractAddresses: chunk }),
    });
    if (!res.ok) {
      throw new Error(`alchemy-nft: ${res.status} ${res.statusText} fetching getContractMetadataBatch`);
    }
    const data = (await res.json()) as { contracts: (AlchemyContractMetadata & { address: string })[] };
    for (const metadata of data.contracts ?? []) {
      const totalSupply = metadata.totalSupply != null ? Number(metadata.totalSupply) : null;
      const openSea = metadata.openSeaMetadata as
        | (AlchemyContractMetadata["openSeaMetadata"] & { floorPrice?: number | null })
        | null
        | undefined;
      const floorPriceWei = openSea?.floorPrice != null ? toWeiString(openSea.floorPrice) : null;
      // OpenSea quotes floor price in each chain's own native token (POL on
      // Polygon, BNB on BSC, AVAX on Avalanche, ETH elsewhere) -- hardcoding
      // "ETH" here mislabeled every non-ETH-native chain's floor. Real fix:
      // the same per-chain symbol foreign-chain-registry.ts already carries
      // for on-chain trading, reused here for display.
      const nativeSymbol = foreignChainByChainSlug(chainSlug)?.nativeCurrencySymbol ?? "ETH";
      results.set(metadata.address.toLowerCase(), {
        name: cleanMetadataString(openSea?.collectionName) ?? cleanMetadataString(metadata.name),
        imageUrl: cleanMetadataString(openSea?.imageUrl),
        externalUrl: cleanMetadataString(openSea?.externalUrl),
        floorPriceWei,
        floorPriceCurrency: floorPriceWei != null ? nativeSymbol : null,
        floorPriceMarketplace: floorPriceWei != null ? "opensea" : null,
        totalSupply:
          Number.isFinite(totalSupply) && totalSupply! > 0 && totalSupply! <= MAX_PLAUSIBLE_TOTAL_SUPPLY
            ? totalSupply
            : null,
        listedCount: null,
        creatorAddress: cleanMetadataString(metadata.contractDeployer),
        creatorHandle: null,
      });
    }
  }
  return results;
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
      name: cleanMetadataString(metadata.openSeaMetadata?.collectionName) ?? cleanMetadataString(metadata.name),
      imageUrl: cleanMetadataString(metadata.openSeaMetadata?.imageUrl),
      externalUrl: cleanMetadataString(metadata.openSeaMetadata?.externalUrl),
      floorPriceWei: floor.priceWei,
      floorPriceCurrency: floor.currency,
      floorPriceMarketplace: floor.marketplace,
      totalSupply:
        Number.isFinite(totalSupply) && totalSupply! > 0 && totalSupply! <= MAX_PLAUSIBLE_TOTAL_SUPPLY
          ? totalSupply
          : null,
      // Alchemy's NFT API does not expose a live listed-count in these two
      // calls -- left null rather than guessed. A future adapter revision
      // could add getNFTsForContract pagination totals if this matters.
      listedCount: null,
      creatorAddress: cleanMetadataString(metadata.contractDeployer),
      creatorHandle: null,
    };
  },
};
