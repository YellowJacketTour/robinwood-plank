import { robinwoodTokenUri } from "@/lib/market/token-image";
import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { getTraitIndex } from "@/lib/market/trait-index";
import { getCollection } from "@/lib/market/collections";
import { getRobinwoodMetadataMap, ROBINWOOD_SUPPLY } from "@/lib/market/robinwood-metadata";
import type { NftAttribute } from "@/lib/ipfs";
import type { RarityTier } from "@/lib/rarity";

/**
 * Full precomputed RobinWood collection dataset — one payload the gallery's
 * cold start reads INSTEAD OF walking tokenURI + IPFS metadata per token.
 *
 * The collection is fixed (1,542 tokens, fully minted) and metadata is
 * immutable post-reveal. Image + description come straight from the
 * canonical IPFS-sourced metadata store (lib/market/robinwood-metadata.ts) —
 * no Blockscout, no per-request IPFS reads. Name/tier/rank/percentile still
 * come from rarity-snapshot.ts and attributes from trait-index.ts (inverted),
 * both of which are themselves now sourced from that same canonical store,
 * so nothing here re-scans traits that are already scanned elsewhere.
 */

export type CollectionIndexEntry = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  tier: RarityTier;
  rank: number;
  percentile: number;
  normalizedScore: number;
};

export type CollectionIndexPayload = {
  collectionSlug: string;
  totalSupply: number;
  count: number;
  builtAt: number;
  entries: CollectionIndexEntry[];
};

type ImageRecord = { imageUri: string; description: string };
type ImageMap = Record<string, ImageRecord>;

/**
 * Per-token image + description, keyed by decimal token-id string. Kept as
 * its own export (rather than inlined into getCollectionIndex) because
 * app/api/market/orders/route.ts uses it to backfill artwork for foreign
 * (OpenSea) listings of tokens we already have canonical metadata for.
 *
 * `contractAddress` is accepted for backward compatibility with that caller,
 * but only the RobinWood contract has a canonical store today; any other
 * address returns an empty map rather than falling back to Blockscout/IPFS.
 */
export async function getCollectionImageMap(
  contractAddress: string
): Promise<ImageMap> {
  const { NFT_CONTRACT_ADDRESS } = await import("@/lib/mint-contract");
  if (contractAddress.toLowerCase() !== NFT_CONTRACT_ADDRESS.toLowerCase()) {
    return {};
  }
  const metadata = await getRobinwoodMetadataMap();
  const map: ImageMap = {};
  for (const [id, entry] of metadata) {
    if (!entry.imageUri) continue;
    map[String(id)] = { imageUri: entry.imageUri, description: entry.description };
  }
  return map;
}

let payloadCache: { at: number; payload: CollectionIndexPayload } | null = null;
const PAYLOAD_MEMORY_MS = 5 * 60_000;

/**
 * Assemble the full per-token dataset from the three already-cached sources
 * (rarity snapshot, trait index, image map). Each source is independently
 * KV-backed and built at most once ever, so after the very first cold build
 * this is just in-memory map lookups over 1,542 entries — no network I/O.
 */
export async function getCollectionIndex(): Promise<CollectionIndexPayload> {
  if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_MEMORY_MS) {
    return payloadCache.payload;
  }

  const collection = getCollection("robinwood");
  if (!collection) {
    throw new Error("RobinWood collection is not registered.");
  }

  const [rarity, traitState, imageMap] = await Promise.all([
    getRaritySnapshot(),
    getTraitIndex(collection),
    getCollectionImageMap(collection.contractAddress),
  ]);

  const traitsByType = traitState.index?.traits ?? {};
  // Invert traitType -> value -> tokenId[] into tokenId -> attributes[].
  const attributesByToken = new Map<number, NftAttribute[]>();
  for (const [traitType, byValue] of Object.entries(traitsByType)) {
    for (const [value, tokenIds] of Object.entries(byValue)) {
      for (const idStr of tokenIds) {
        const id = Number(idStr);
        if (!Number.isFinite(id)) continue;
        const list = attributesByToken.get(id) ?? [];
        list.push({ trait_type: traitType, value });
        attributesByToken.set(id, list);
      }
    }
  }

  const totalSupply = Math.max(
    ROBINWOOD_SUPPLY,
    traitState.index?.totalSupply ?? 0,
    rarity.scoredCount
  );

  const entries: CollectionIndexEntry[] = [];
  for (let id = 1; id <= totalSupply; id += 1) {
    const r = rarity.byTokenId.get(id);
    const img = imageMap[String(id)];
    const attrs = attributesByToken.get(id) ?? [];
    entries.push({
      tokenId: id,
      tokenUri: robinwoodTokenUri(id),
      name: r?.name || `Plank #${id}`,
      description: img?.description || "",
      imageUri: img?.imageUri || "",
      attributes: attrs,
      tier: r?.tier || "Common",
      rank: r?.rank ?? 0,
      percentile: r?.percentile ?? 0,
      normalizedScore: r?.normalizedScore ?? 0,
    });
  }

  const payload: CollectionIndexPayload = {
    collectionSlug: collection.slug,
    totalSupply,
    count: entries.length,
    builtAt: Date.now(),
    entries,
  };
  payloadCache = { at: Date.now(), payload };
  return payload;
}
