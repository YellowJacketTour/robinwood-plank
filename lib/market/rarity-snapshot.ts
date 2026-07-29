import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { fetchTokenInstances } from "@/lib/market/blockscout";
import { fetchNftMetadata } from "@/lib/ipfs";
import { robinwoodTokenUri } from "@/lib/market/token-image";
import { computeRaritySnapshot, emptyTierCounts, normalizeRarityTier } from "@/lib/rarity";
import type { RarityInput, RaritySnapshot, RarityTier, TokenRarity } from "@/lib/rarity";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";

/**
 * Rarity snapshot for the whole collection via Blockscout metadata (CF-safe),
 * with IPFS metadata backfill for instances Blockscout never revealed.
 */

// v4: no Mythic tier (not in collection metadata); Background-based labels.
const KV_KEY = "plank:market:rarity-snapshot-v4";
const KV_TTL_SEC = 6 * 60 * 60;

let cached: { snapshot: RaritySnapshot; at: number } | null = null;
let inflight: Promise<RaritySnapshot> | null = null;

function hasKv(): boolean {
  return hasDurableKv();
}

type CompactBlob = {
  sampleSize: number;
  scoredCount: number;
  tierCounts: Record<RarityTier, number>;
  byTokenId: Record<
    string,
    { name: string; tier: RarityTier; rank: number; percentile: number; normalizedScore: number; score: number }
  >;
};

function snapshotToBlob(s: RaritySnapshot): CompactBlob {
  const byTokenId: CompactBlob["byTokenId"] = {};
  for (const [id, r] of s.byTokenId) {
    byTokenId[String(id)] = {
      name: r.name,
      tier: r.tier,
      rank: r.rank,
      percentile: r.percentile,
      normalizedScore: r.normalizedScore,
      score: r.score,
    };
  }
  return {
    sampleSize: s.sampleSize,
    scoredCount: s.scoredCount,
    tierCounts: s.tierCounts,
    byTokenId,
  };
}

function blobToSnapshot(b: CompactBlob): RaritySnapshot {
  const byTokenId = new Map<number, TokenRarity>();
  const tierCounts = emptyTierCounts();
  for (const [id, r] of Object.entries(b.byTokenId)) {
    const tokenId = Number(id);
    const tier = normalizeRarityTier(r.tier as string);
    tierCounts[tier] += 1;
    byTokenId.set(tokenId, {
      tokenId,
      name: r.name,
      tier,
      rank: r.rank,
      percentile: r.percentile,
      normalizedScore: r.normalizedScore,
      score: r.score,
      traits: [],
    });
  }
  return {
    sampleSize: b.sampleSize,
    scoredCount: b.scoredCount,
    byTokenId,
    traitStats: new Map(),
    traitOrder: [],
    histogram: [],
    tierCounts,
    topRarest: [],
    uniqueBases: 0,
    holoYes: 0,
    holoPct: 0,
    method: "information-content",
  };
}

async function readKv(): Promise<RaritySnapshot | null> {
  if (!hasKv()) return null;
  try {
    let b = await kv.get<CompactBlob | string | { value?: CompactBlob }>(KV_KEY);
    // Tolerate stringified / double-wrapped seed formats.
    if (typeof b === "string") {
      try {
        b = JSON.parse(b) as CompactBlob | { value?: CompactBlob };
      } catch {
        return null;
      }
    }
    if (b && typeof b === "object" && "value" in b && b.value?.byTokenId) {
      b = b.value;
    }
    if (!b || typeof b !== "object" || !("byTokenId" in b)) return null;
    const blob = b as CompactBlob;
    if (!blob.byTokenId || Object.keys(blob.byTokenId).length < 100) return null;
    return blobToSnapshot(blob);
  } catch {
    return null;
  }
}

async function writeKv(s: RaritySnapshot): Promise<void> {
  if (!hasKv()) return;
  try {
    await kv.set(KV_KEY, snapshotToBlob(s), { ex: KV_TTL_SEC });
  } catch {
    /* best-effort */
  }
}

async function traitsFromIpfs(tokenId: number): Promise<RarityInput["attributes"]> {
  try {
    const meta = await fetchNftMetadata(robinwoodTokenUri(tokenId));
    const attrs = (meta.attributes || []).map((a) => ({
      trait_type: String(a.trait_type || ""),
      value: a.value as string | number | boolean,
    }));
    return attrs;
  } catch {
    return [];
  }
}

/** Fill traits Blockscout never indexed (pre-reveal stubs or missing pages). */
async function backfillMissingTraits(inputs: RarityInput[]): Promise<RarityInput[]> {
  const need = inputs
    .filter((i) => !i.loaded || i.attributes.length === 0)
    .sort((a, b) => a.tokenId - b.tokenId);
  if (need.length === 0) return inputs;
  // Cap cold-build work so Workers stay under CPU/subrequest limits; remaining
  // gaps stay unscored until the next rebuild (seed script fills the rest).
  // Prefer lower token IDs — Blockscout gaps cluster there (vault fence).
  const MAX_BACKFILL = 400;
  const queue = need.slice(0, MAX_BACKFILL);
  const CONCURRENCY = 10;
  const fixes = new Map<number, RarityInput["attributes"]>();
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const slice = queue.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (row) => {
        const attrs = await traitsFromIpfs(row.tokenId);
        if (attrs.length > 0) fixes.set(row.tokenId, attrs);
      })
    );
  }
  if (fixes.size === 0) return inputs;
  return inputs.map((row) => {
    const attrs = fixes.get(row.tokenId);
    if (!attrs) return row;
    return { tokenId: row.tokenId, attributes: attrs, loaded: true };
  });
}

async function buildFromBlockscout(): Promise<RaritySnapshot> {
  const items = await fetchTokenInstances(NFT_CONTRACT_ADDRESS, { maxPages: 40 });
  const inputs: RarityInput[] = items.map((it) => {
    const tokenId = Number(it.id);
    const attrs = (it.metadata?.attributes || []).map((a) => ({
      trait_type: String(a.trait_type || ""),
      value: a.value as string | number,
    }));
    return { tokenId, attributes: attrs, loaded: attrs.length > 0 };
  });

  const seen = new Set(inputs.map((i) => i.tokenId));
  for (let id = 1; id <= 1542; id += 1) {
    if (!seen.has(id)) inputs.push({ tokenId: id, attributes: [], loaded: false });
  }

  const filled = await backfillMissingTraits(inputs);
  return computeRaritySnapshot(filled);
}

export async function getRaritySnapshot(): Promise<RaritySnapshot> {
  if (cached) return cached.snapshot;
  if (inflight) return inflight;

  inflight = (async () => {
    const fromKv = await readKv();
    if (fromKv) {
      cached = { snapshot: fromKv, at: Date.now() };
      return fromKv;
    }

    const snapshot = await buildFromBlockscout();
    if (snapshot.scoredCount < 50) {
      throw new Error(`Rarity sample too small (${snapshot.scoredCount})`);
    }
    cached = { snapshot, at: Date.now() };
    void writeKv(snapshot);
    return snapshot;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export type CompactRarity = {
  name: string;
  tier: RarityTier;
  rank: number;
  percentile: number;
  normalizedScore: number;
};

export function compactRarityFor(
  snapshot: RaritySnapshot,
  tokenId: number
): CompactRarity | null {
  const r = snapshot.byTokenId.get(tokenId);
  if (!r) return null;
  return {
    name: r.name,
    tier: r.tier,
    rank: r.rank,
    percentile: r.percentile,
    normalizedScore: r.normalizedScore,
  };
}
