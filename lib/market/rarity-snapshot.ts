import { getRobinwoodMetadataMap, ROBINWOOD_SUPPLY } from "@/lib/market/robinwood-metadata";
import {
  computeRaritySnapshot,
  emptyTierCounts,
  normalizeRarityTier,
  pickCanonicalTraits,
} from "@/lib/rarity";
import type { RarityInput, RaritySnapshot, RarityTier, TokenRarity } from "@/lib/rarity";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";

/**
 * Rarity snapshot for the whole collection, built from the canonical
 * IPFS-sourced metadata store (lib/market/robinwood-metadata.ts) — never
 * from Blockscout. Blockscout served pre-reveal stubs
 * ([{trait_type:"Status", value:"Unrevealed"}]) for planks #1-180 long after
 * reveal and kept serving them indefinitely (no TTL on this snapshot), which
 * both corrupted those 180 tokens' display AND shrank the ranked sample from
 * 1,542 to 1,362. The canonical store is built once, offline, directly from
 * IPFS (see `scripts/refresh-market-data.ts --metadata`), so this module no
 * longer talks to any rate-limited third party at request time.
 */

// v5: sourced from the canonical robinwood_token_metadata table (IPFS-only),
// not Blockscout. Same compact-blob shape as v4.
const KV_KEY = "plank:market:rarity-snapshot-v5";

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
  // topRarest isn't persisted in CompactBlob (see its own comment), so it
  // must be re-derived here on every KV read the same way computeRaritySnapshot
  // builds it in lib/rarity.ts: one token per rank group, rarest (lowest
  // rank) first, capped at 12. Found live 2026-08-19 -- this function
  // previously hardcoded topRarest to [], which silently starved every
  // caller of it (e.g. GlobalMarketHub's home-chain card art) on every
  // request served from cache, i.e. almost all of them.
  const topRarest: number[] = [];
  const seenRanks = new Set<number>();
  for (const r of [...byTokenId.values()].sort((a, c) => a.rank - c.rank)) {
    if (seenRanks.has(r.rank)) continue;
    seenRanks.add(r.rank);
    topRarest.push(r.tokenId);
    if (topRarest.length >= 12) break;
  }
  return {
    sampleSize: b.sampleSize,
    scoredCount: b.scoredCount,
    byTokenId,
    traitStats: new Map(),
    traitOrder: [],
    histogram: [],
    tierCounts,
    topRarest,
    uniqueBases: 0,
    holoYes: 0,
    holoPct: 0,
    method: "information-content",
  };
}

async function readKv(): Promise<RaritySnapshot | null> {
  return readKvAt(KV_KEY);
}

async function readKvAt(key: string): Promise<RaritySnapshot | null> {
  if (!hasKv()) return null;
  try {
    let b = await kv.get<CompactBlob | string | { value?: CompactBlob }>(key);
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
    // Keep the last known-good snapshot indefinitely. The collection metadata
    // is immutable after reveal, while rebuilding all 1,500+ entries depends
    // on rate-limited Blockscout/IPFS services. Expiring this value caused
    // every Passenger worker to cold-rebuild at the same six-hour boundary,
    // producing intermittent 500s until one rebuild succeeded.
    await kv.set(KV_KEY, snapshotToBlob(s));
  } catch {
    /* best-effort */
  }
}

/**
 * Build rarity inputs from the canonical metadata store. A token missing
 * from the store, or present with no canonical trait, is marked
 * `loaded: false` — the guard below (`pickCanonicalTraits(...).length === 0`
 * inside computeRaritySnapshot's own filter) is kept even though the
 * canonical store already enforces this at write time, because it is cheap
 * insurance against a bad row slipping in some other way, not because we
 * expect it to fire.
 */
async function buildFromCanonicalStore(): Promise<RaritySnapshot> {
  const metadata = await getRobinwoodMetadataMap();
  const inputs: RarityInput[] = [];
  for (let id = 1; id <= ROBINWOOD_SUPPLY; id += 1) {
    const entry = metadata.get(id);
    const attrs = entry?.attributes ?? [];
    inputs.push({
      tokenId: id,
      attributes: attrs,
      loaded: pickCanonicalTraits(attrs).length > 0,
    });
  }
  return computeRaritySnapshot(inputs);
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

    // Deploy-window fallback. This key moved v4 -> v5 because the provenance
    // changed, so the first request after deploy finds nothing at v5 and would
    // rebuild from a canonical table the migration has only just created and
    // nothing has filled yet — throwing, and 500ing every rarity read until
    // the metadata build finishes minutes later.
    //
    // The v4 blob is the same shape and, in production, holds a correct
    // 1,542-token snapshot. Serving it beats serving an error, and it is NOT
    // written back to v5: the next build from the canonical store overwrites
    // it properly. Safe to delete this branch once v5 exists everywhere.
    const legacy = await readKvAt("plank:market:rarity-snapshot-v4");
    if (legacy && legacy.scoredCount >= 50) {
      cached = { snapshot: legacy, at: Date.now() };
      return legacy;
    }

    const snapshot = await buildFromCanonicalStore();
    if (snapshot.scoredCount < 50) {
      throw new Error(
        `Rarity sample too small (${snapshot.scoredCount}) — the canonical metadata store ` +
          `looks empty or unbuilt; run "tsx scripts/refresh-market-data.ts --metadata" first.`
      );
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
