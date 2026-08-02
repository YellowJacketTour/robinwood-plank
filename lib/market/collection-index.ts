import { fetchTokenInstances } from "@/lib/market/blockscout";
import { fetchNftMetadata } from "@/lib/ipfs";
import type { NftAttribute } from "@/lib/ipfs";
import { robinwoodTokenUri } from "@/lib/market/token-image";
import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { getTraitIndex } from "@/lib/market/trait-index";
import { getCollection } from "@/lib/market/collections";
import type { RarityTier } from "@/lib/rarity";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";

/**
 * Full precomputed RobinWood collection dataset — one payload the gallery's
 * cold start reads INSTEAD OF walking tokenURI + IPFS metadata per token.
 *
 * The collection is fixed (1,542 tokens, fully minted) and metadata is
 * immutable post-reveal, so this is built once from Blockscout + IPFS
 * (same sources rarity-snapshot.ts and trait-index.ts already use) and kept
 * in durable KV forever — no TTL, same reasoning as rarity-snapshot's
 * KV_KEY comment: rebuilding depends on rate-limited services, so expiring
 * it would force every cold worker to re-walk 1,542 tokens at once.
 *
 * This module only adds the ONE piece neither existing snapshot keeps:
 * per-token image + description. Name/tier/rank/percentile come from
 * rarity-snapshot.ts and attributes come from trait-index.ts (inverted),
 * so nothing here re-scans traits that are already scanned elsewhere.
 */

const ROBINWOOD_SUPPLY = 1542;
const IMAGE_KV_KEY = "plank:market:collection-image-map-v1";
const MAX_IPFS_BACKFILL = 800;
const IPFS_CONCURRENCY = 12;

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

type ImageBuildState = {
  map: ImageMap | null;
  inflight: Promise<ImageMap> | null;
};

type GlobalImageMap = { __plankCollectionImageMapV1?: ImageBuildState };

function imageState(): ImageBuildState {
  const store = globalThis as GlobalImageMap;
  if (!store.__plankCollectionImageMapV1) {
    store.__plankCollectionImageMapV1 = { map: null, inflight: null };
  }
  return store.__plankCollectionImageMapV1;
}

function hasKv(): boolean {
  return hasDurableKv();
}

async function readImageKv(): Promise<ImageMap | null> {
  if (!hasKv()) return null;
  try {
    let raw = await kv.get<ImageMap | string | { value?: ImageMap }>(IMAGE_KV_KEY);
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as ImageMap | { value?: ImageMap };
      } catch {
        return null;
      }
    }
    if (raw && typeof raw === "object" && "value" in raw) {
      raw = (raw as { value?: ImageMap }).value ?? null;
    }
    if (!raw || typeof raw !== "object") return null;
    const map = raw as ImageMap;
    if (Object.keys(map).length < 100) return null;
    return map;
  } catch {
    return null;
  }
}

async function writeImageKv(map: ImageMap): Promise<void> {
  if (!hasKv()) return;
  try {
    // No TTL — image URLs are content-addressed IPFS paths, never expected
    // to change. See module comment for why expiry is intentionally absent.
    await kv.set(IMAGE_KV_KEY, map);
  } catch {
    /* best-effort */
  }
}

async function imageFromIpfs(tokenId: number): Promise<ImageRecord | null> {
  try {
    const meta = await fetchNftMetadata(robinwoodTokenUri(tokenId));
    const imageUri = typeof meta.image === "string" ? meta.image.trim() : "";
    if (!imageUri) return null;
    const description =
      typeof meta.description === "string" ? meta.description.trim() : "";
    return { imageUri, description };
  } catch {
    return null;
  }
}

export async function getCollectionImageMap(
  contractAddress: string
): Promise<ImageMap> {
  const state = imageState();
  if (state.map) return state.map;

  const fromKv = await readImageKv();
  if (fromKv) {
    state.map = fromKv;
    return fromKv;
  }

  if (!state.inflight) {
    state.inflight = (async () => {
      const map: ImageMap = {};

      try {
        const items = await fetchTokenInstances(contractAddress, { maxPages: 40 });
        for (const it of items) {
          const idNum = Number(it.id);
          if (!Number.isFinite(idNum)) continue;
          const rawImage =
            (it.metadata?.image && String(it.metadata.image).trim()) ||
            (it.image_url && String(it.image_url).trim()) ||
            "";
          if (!rawImage) continue;
          const description =
            typeof (it.metadata as { description?: unknown } | null)?.description === "string"
              ? String((it.metadata as { description?: unknown }).description).trim()
              : "";
          map[String(idNum)] = { imageUri: rawImage, description };
        }
      } catch {
        /* Blockscout down — fall through to full IPFS backfill below */
      }

      const missing: number[] = [];
      for (let id = 1; id <= ROBINWOOD_SUPPLY; id += 1) {
        if (!map[String(id)]) missing.push(id);
      }

      const queue = missing.slice(0, MAX_IPFS_BACKFILL);
      for (let i = 0; i < queue.length; i += IPFS_CONCURRENCY) {
        const slice = queue.slice(i, i + IPFS_CONCURRENCY);
        await Promise.all(
          slice.map(async (id) => {
            const rec = await imageFromIpfs(id);
            if (rec) map[String(id)] = rec;
          })
        );
      }

      if (Object.keys(map).length >= 100) {
        void writeImageKv(map);
      }
      state.map = map;
      return map;
    })().finally(() => {
      state.inflight = null;
    });
  }

  return state.inflight;
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
