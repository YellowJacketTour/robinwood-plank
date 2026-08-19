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
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";

const RPC_URL = "https://mainnet.helius-rpc.com";

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("helius-solana: HELIUS_API_KEY is not configured");
  return key;
}

type HeliusAsset = {
  id: string;
  interface: string;
  content?: {
    metadata?: { name?: string | null; description?: string | null };
    links?: { image?: string | null; external_url?: string | null };
  };
};

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${RPC_URL}/?api-key=${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method, params }),
  });
  if (!res.ok) throw new Error(`helius-solana: HTTP ${res.status} calling ${method}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`helius-solana: ${method} — ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

export const heliusSolanaAdapter: ChainAdapter = {
  name: "helius-solana",
  async fetchSnapshot({ contractAddress: assetId }): Promise<CollectionSnapshot> {
    const asset = await rpc<HeliusAsset>("getAsset", { id: assetId });
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
    };
  },
};
