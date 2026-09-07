/**
 * Reads pre-computed rarity from plank_foreign_rarity (see
 * scripts/index-foreign-rarity.ts and migration 014_foreign_rarity.sql).
 * Returns an empty map, not an error, when a collection hasn't been
 * indexed yet -- that's a real, expected state (indexing is a background
 * job, not automatic on first view), and the UI falls back to un-tiered
 * cards rather than showing a fabricated rank.
 *
 * AUDIT lens 4 #8 (Batch F8): this GET used to kick off a full OpenSea
 * membership walk (indexRarityForCollectionLookup -- up to 500 paged
 * requests plus 10k+ single-row INSERTs) inside the web process. Public
 * requests never fan out to providers here any more: an un-indexed or
 * stale-first-pass collection ENQUEUES a demand job on the shared mesh
 * queue (plank_data_jobs, source opensea-membership, priority 100) and
 * the response is HTTP 202. The only in-request compute left is the
 * in-memory re-rank from an already-stored trait index (no I/O beyond
 * Postgres).
 *
 * AUDIT lens 4 #5 (Batch F5): while withTraits / expected is below the
 * 99.5% finalize line the ranking is PROVISIONAL -- the response is 202
 * (same JSON shape) and `coverage` carries the three honest counters
 * (terminal / withTraits / withImage over expected) so the UI can say
 * "Provisional (N% traits)" instead of presenting all-Common as final.
 */
import { NextRequest, NextResponse } from "next/server";
import { hasForeignRarityStore, getForeignRarity, getForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inFlight = new Set<string>();
/** Enqueue is idempotent (ON CONFLICT job_key), but there is no reason to
 * hit Postgres for it on every poll of the same collection. */
const recentlyEnqueued = new Map<string, number>();
const ENQUEUE_DEBOUNCE_MS = 60_000;

async function enqueueRarityDemand(chainSlug: string, collectionSlug: string): Promise<boolean> {
  const { rarityDemandJob } = await import("@/lib/market/multichain/rarity-index-runner");
  const job = rarityDemandJob(chainSlug, collectionSlug);
  if (!job) return false;
  const last = recentlyEnqueued.get(job.jobKey) ?? 0;
  if (Date.now() - last < ENQUEUE_DEBOUNCE_MS) return true;
  recentlyEnqueued.set(job.jobKey, Date.now());
  if (recentlyEnqueued.size > 2_000) {
    const cutoff = Date.now() - ENQUEUE_DEBOUNCE_MS;
    for (const [k, t] of recentlyEnqueued) if (t < cutoff) recentlyEnqueued.delete(k);
  }
  const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
  await enqueueDataJob(job);
  return true;
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-rarity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  if (!hasForeignRarityStore()) {
    return NextResponse.json({ byTokenId: {}, indexed: false }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    let map = await getForeignRarity(chainSlug, collectionSlug);
    if (map.size > 20) {
      const tiers = new Set([...map.values()].map((v) => v.tier));
      if (tiers.size === 1) {
        const job = `recompute:${chainSlug}:${collectionSlug.toLowerCase()}`;
        if (!inFlight.has(job)) {
          inFlight.add(job);
          try {
            const meta = await getForeignTraitIndex(chainSlug, collectionSlug);
            if (meta.traitIndex) {
              const { itemsFromTraitIndex, applyForeignRaritySnapshot } = await import("@/lib/market/multichain/foreign-rarity-store");
              const { computeGenericRaritySnapshot } = await import("@/lib/rarity-generic");
              const items = itemsFromTraitIndex(meta.traitIndex);
              if (items.length > 0) {
                const snap = computeGenericRaritySnapshot(items);
                await applyForeignRaritySnapshot(chainSlug, collectionSlug, snap);
                map = await getForeignRarity(chainSlug, collectionSlug);
              }
            }
          } catch {
            /* keep stored tiers */
          } finally {
            inFlight.delete(job);
          }
        }
      }
    }
    const byTokenId: Record<string, { name: string; tier: string; rank: number; percentile: number; score: number }> = {};
    for (const [tokenId, v] of map) byTokenId[tokenId] = v;
    const meta = await getForeignTraitIndex(chainSlug, collectionSlug).catch(() => null);
    const sampleSize = meta?.sampleSize ?? map.size;
    // Universal rarity (lib/rarity-universal.ts): coverage is real rows vs
    // the real known supply, never a source's own flag; collection type is
    // detected from the stored trait index, not assumed.
    const { getCollectionSupplyStats } = await import("@/lib/market/multichain/store");
    const { rarityCoverage, collectionTypeSignals, detectCollectionType } = await import("@/lib/rarity-universal");
    const supply = await getCollectionSupplyStats(chainSlug, collectionSlug).catch(() => null);
    const coverage = rarityCoverage(map.size, supply?.totalSupply ?? null);
    let collectionType: string = "unknown";
    if (meta?.traitIndex) {
      const { itemsFromTraitIndex } = await import("@/lib/market/multichain/foreign-rarity-store");
      const items = itemsFromTraitIndex(meta.traitIndex);
      collectionType = detectCollectionType(collectionTypeSignals(items, { totalSupply: supply?.totalSupply ?? null, standard: chainSlug === "bitcoin-mainnet" ? "ordinals" : null }));
    }
    // Old first-pass caps (1k/2k/5k) left Claynosaurz stuck at 5,000 forever
    // because we only enqueued when the map was empty. Resume those samples.
    // Resume only historical first-pass caps. 2_000 is also itemCeiling(unknown
    // supply) — treating it as stale DELETE-looped every rarity GET.
    const staleFirstPass = sampleSize === 1_000 || sampleSize === 5_000;
    const needsIndex =
      map.size === 0 || (staleFirstPass && map.size < 6_000 && chainSlug !== "bitcoin-mainnet");
    let enqueued = false;
    if (needsIndex) {
      // F8: demand job on the mesh queue, never a provider walk in-process.
      enqueued = await enqueueRarityDemand(chainSlug, collectionSlug).catch(() => false);
    }
    // F5: the three honest counters over the stored rows.
    const { readMetadataCoverageCounters } = await import("@/lib/market/multichain/collection-token-store");
    const { metadataCountersToShape } = await import("@/lib/market/multichain/archival-ledger");
    const raw = await readMetadataCoverageCounters(chainSlug, collectionSlug).catch(() => null);
    const shaped = raw ? metadataCountersToShape(raw) : null;
    // No rows at all means nothing is known either way; a ranking that
    // exists in that state (legacy Bitcoin/Solana index with no token rows)
    // is not called provisional on the strength of an empty table.
    const provisional = shaped ? (raw!.rows > 0 ? shaped.provisional : map.size === 0) : map.size === 0;
    const counters = shaped ? { ...shaped.shape, provisional } : null;
    const status = provisional || meta?.partial === true ? 202 : 200;
    return NextResponse.json(
      {
        byTokenId,
        indexed: map.size > 0,
        sampleSize,
        partial: map.size === 0 || staleFirstPass || chainSlug === "bitcoin-mainnet" || coverage.partial || provisional,
        coverage: { ...coverage, ...(counters ?? {}), provisional },
        collectionType,
        enqueued,
      },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ byTokenId: {}, indexed: false }, { headers: { "Cache-Control": "no-store" } });
  }
}
