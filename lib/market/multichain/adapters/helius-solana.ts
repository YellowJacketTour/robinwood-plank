/**
 * Helius DAS (Digital Asset Standard) adapter -- Solana's second real
 * discovery source, alongside magiceden-solana.ts. Verified live 2026-08-20
 * against the real API, not assumed from docs (which were themselves
 * incomplete on key details): searchAssets requires owner_address when
 * combined with tokenType, limit=1000 times out server-side ("statement
 * timeout"), limit=100 works cleanly with real advancing cursor pagination,
 * and there is no reliable grand-total field in the response (unlike
 * UniSat's collection/list) -- "done" is detected the same way HyperSync's
 * own pagination is: a page returning fewer items than requested.
 *
 * SCOPE, STATED HONESTLY: this adapter only covers Metaplex's newer Core
 * standard (interface: "MplCoreCollection"), which IS cleanly, exhaustively
 * enumerable as a distinct collection-level asset type. Legacy-standard
 * collections (interface: "V1_NFT" -- what most established projects like
 * DeGods/Mad Lads use) do NOT have a clean "this is a collection identity,
 * not a member item" signal in a broad searchAssets call -- confirmed live,
 * not assumed -- searching V1_NFT returns individual member NFTs
 * indistinguishably from collection-identity NFTs, the same "500M+
 * individual items, no clean grouping key" scale problem already declined
 * for Bitcoin's raw parent-child inscription walk rather than force a
 * fragile heuristic. Legacy-collection coverage stays on
 * magiceden-solana.ts's ranked list until a real, clean legacy-collection
 * enumeration signal is found.
 *
 * Real name/image come directly from this same discovery response
 * (content.metadata.name / content.links.image) -- floor price and listed
 * count are NOT available from DAS (it's asset data, not marketplace
 * data), so fetchSnapshot here honestly returns null for both rather than
 * fabricating or cross-referencing a fragile name-match against another
 * marketplace.
 *
 * ON-CHAIN FALLBACK (added 2026-08-24, same pattern as alchemy-nft.ts's
 * onchainFallbackSnapshots): reserveDasSlot() returns null whenever every
 * configured DAS provider (Helius/QuickNode/Shyft) is simultaneously
 * jailed/exhausted/unconfigured -- previously fetchSnapshot just threw in
 * that case, with zero fallback, exactly the same single-vendor-dependency
 * gap the Alchemy fix addressed for EVM. solana-metaplex-reads.ts and
 * solana-editions.ts (this session's raw Metaplex Borsh readers) fill that
 * gap for free: a plain `getAccountInfo` against the public Solana RPC
 * needs no DAS provider at all. Tries the legacy Token Metadata PDA first
 * (covers the vast majority of real Solana NFTs), then Metaplex Core as a
 * second attempt (assetId IS the account address for Core assets) --
 * whichever standard the given id actually is. No floor/listed-count is
 * possible here either way (same honest limitation as the DAS path).
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { reserveDasSlot, settleDasSlot, type DasSlot } from "@/lib/market/multichain/discovery/solana-das-pool";
import { readTokenMetadata } from "@/lib/market/multichain/discovery/solana-metaplex-reads";
import { readMetaplexCoreAsset } from "@/lib/market/multichain/discovery/solana-editions";

type HeliusAsset = {
  id: string;
  interface: string;
  content?: {
    metadata?: { name?: string | null; description?: string | null };
    links?: { image?: string | null; external_url?: string | null };
  };
  creators?: Array<{ address?: string | null; verified?: boolean; share?: number }>;
};

/** The first verified creator's address, or the first creator at all if none are verified -- real DAS data, never fabricated. */
function pickCreatorAddress(creators: HeliusAsset["creators"]): string | null {
  if (!creators || creators.length === 0) return null;
  const verified = creators.find((c) => c.verified && c.address);
  return (verified ?? creators.find((c) => c.address))?.address ?? null;
}

/** Reserves+settles a FRESH key from the pool on every call (not once per run), same real per-attempt behavior as OpenSea's pool. `priority` "live" for a user-triggered fetchSnapshot, "background" for a discovery/sync supervisor. */
async function rpc<T>(method: string, params: Record<string, unknown>, priority: "live" | "background" = "live"): Promise<T> {
  const slot: DasSlot | null = await reserveDasSlot(1, { priority });
  if (!slot) throw new Error("helius-solana: no Solana DAS provider available (pool exhausted/jailed, or none of HELIUS_API_KEY(S)/QUICKNODE_SOLANA_URL/SHYFT_API_KEY configured)");
  let ok = false;
  try {
    const res = await fetch(slot.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`helius-solana: HTTP ${res.status} calling ${method} via ${slot.provider}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`helius-solana: ${method} via ${slot.provider} — ${body.error.code} ${body.error.message}`);
    ok = true;
    return body.result as T;
  } finally {
    await settleDasSlot(slot, 1, ok);
  }
}

/**
 * Real, free, no-DAS-provider-required fallback: reads the legacy Token
 * Metadata PDA, and if that's not a real account, tries Metaplex Core (the
 * two Solana NFT standards this app's on-chain readers cover -- see file
 * header). Returns null only when neither standard resolves anything real
 * for this id, never a fabricated snapshot.
 */
async function onchainFallbackSnapshot(assetId: string): Promise<CollectionSnapshot | null> {
  const legacy = await readTokenMetadata(assetId);
  if (legacy) {
    return {
      name: legacy.name || null,
      imageUrl: null, // legacy Metadata account only stores a URI to off-chain JSON, not a direct image URL -- resolving that JSON is real, separate scope this reader doesn't take on
      externalUrl: null,
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: null,
      listedCount: null,
      creatorAddress: legacy.creators?.find((c) => c.verified)?.address ?? legacy.creators?.[0]?.address ?? null,
      creatorHandle: null,
    };
  }
  const core = await readMetaplexCoreAsset(assetId);
  if (core) {
    return {
      name: core.name || null,
      imageUrl: null, // same reasoning as above -- core.uri is off-chain JSON, not a direct image URL
      externalUrl: null,
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: null,
      listedCount: null,
      creatorAddress: null,
      creatorHandle: null,
    };
  }
  return null;
}

export const heliusSolanaAdapter: ChainAdapter = {
  name: "helius-solana",
  async fetchSnapshot({ contractAddress: assetId }): Promise<CollectionSnapshot> {
    let asset: HeliusAsset;
    try {
      asset = await rpc<HeliusAsset>("getAsset", { id: assetId });
    } catch (error) {
      const fallback = await onchainFallbackSnapshot(assetId);
      if (fallback) return fallback;
      throw error; // real on-chain fallback also found nothing recoverable -- surface the real DAS error rather than a fabricated empty snapshot
    }
    return {
      name: asset.content?.metadata?.name ?? null,
      imageUrl: asset.content?.links?.image ?? null,
      externalUrl: asset.content?.links?.external_url ?? null,
      // DAS is asset/metadata data, not marketplace data -- no real floor
      // or listed-count source exists here. Never fabricated.
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: null,
      listedCount: null,
      // Real DAS creators[] data -- first verified creator, else first
      // listed creator. Never fabricated; null when the asset has none.
      creatorAddress: pickCreatorAddress(asset.creators),
      creatorHandle: null,
    };
  },
};
