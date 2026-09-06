import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { DEMAND_PRIORITY, hydrationJobSources } from "@/lib/market/multichain/collection-demand";
import { computeDemandScore } from "@/lib/market/multichain/demand-score";
import { listCollectionsWithSnapshots } from "@/lib/market/multichain/store";

/**
 * Predictive focus -- pre-warm what the user is about to need and what the
 * market is about to need. Two halves, both honest about what they are:
 *
 * 1) USER: an intent that names tokens (a previewed sweep, the next grid
 *    page, a trait facet's members) turns into bounded per-token hydration
 *    of exactly those tokens that are still `pending`/`retry` in the token
 *    projection. Same hydrateSpecificToken path the hydrate-token route
 *    already runs per click, just ahead of the click and capped hard
 *    (MAX_TOKENS, CONCURRENCY) so a 500-token sweep preview cannot become
 *    500 vendor calls. Nothing is fetched for a token whose metadata is
 *    already complete.
 *
 * 2) MARKET: collections whose real sales/volume are accelerating (the
 *    momentum term of demand-score.ts, computed only from this app's own
 *    stored windows) are nudged to DEMAND_PRIORITY.PREDICT_NEXT in the mesh
 *    queue -- strictly below any real viewport/click tier, so anticipation
 *    never outranks a person. Run from scripts/market-focus.ts.
 */

const MAX_TOKENS = 24;
const CONCURRENCY = 4;

export type TokenFocusResult = { requested: number; pending: number; hydrated: number; skipped: number };

/** Which of these tokens still need metadata, per the real projection. */
async function pendingTokenIds(chainSlug: string, collectionSlug: string, tokenIds: string[]): Promise<string[]> {
  if (!hasPostgresConfig() || tokenIds.length === 0) return [];
  const rows = await postgresQuery<{ token_id: string }>(
    `SELECT token_id FROM plank_collection_tokens
      WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND token_id = ANY($3::text[])
        AND metadata_state IN ('pending', 'retry')`,
    [chainSlug, collectionSlug, tokenIds]
  ).catch(() => ({ rows: [] as Array<{ token_id: string }> }));
  return rows.rows.map((r) => r.token_id);
}

/**
 * Hydrate the still-pending subset of `tokenIds` for one EVM/Robinhood
 * collection, bounded. Returns real counts; never throws into a request.
 */
export async function focusTokens(chainSlug: string, collectionSlug: string, tokenIds: string[]): Promise<TokenFocusResult> {
  const ids = [...new Set(tokenIds.map((t) => String(t).trim()).filter(Boolean))].slice(0, MAX_TOKENS);
  const result: TokenFocusResult = { requested: ids.length, pending: 0, hydrated: 0, skipped: 0 };
  if (ids.length === 0 || !/^0x[0-9a-fA-F]{40}$/.test(collectionSlug)) {
    result.skipped = ids.length;
    return result;
  }
  const pending = await pendingTokenIds(chainSlug, collectionSlug, ids);
  result.pending = pending.length;
  result.skipped = ids.length - pending.length;
  if (pending.length === 0) return result;
  const { hydrateSpecificToken } = await import("@/lib/market/multichain/rarity-index-runner");
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const tokenId = pending[cursor++];
        try {
          const r = await hydrateSpecificToken(chainSlug, collectionSlug, tokenId);
          if (r.resolved) result.hydrated += 1;
        } catch {
          // one token's failure never stops the rest
        }
      }
    })
  );
  return result;
}

export type MarketFocusCandidate = {
  chainSlug: string;
  contractAddress: string;
  momentum: number;
  score: number;
  sales24h: number | null;
};

/**
 * Collections whose activity is accelerating, from stored windows only.
 * Pure over the snapshot rows so it is unit-testable; the threshold is the
 * demand-score momentum term (0..100) -- a collection whose 24h rate beats
 * its trailing 7d/30d baseline.
 */
export function rankAcceleratingCollections(
  rows: Awaited<ReturnType<typeof listCollectionsWithSnapshots>>,
  opts?: { minMomentum?: number; limit?: number }
): MarketFocusCandidate[] {
  const minMomentum = opts?.minMomentum ?? 40;
  const limit = opts?.limit ?? 40;
  const out: MarketFocusCandidate[] = [];
  for (const c of rows) {
    if (!c.sales24h || c.sales24h <= 0) continue; // no real recent sales = nothing accelerating
    const breakdown = computeDemandScore({
      volume24hWei: c.volume24hWei,
      volume7dWei: c.volume7dWei,
      volume30dWei: c.volume30dWei,
      sales24h: c.sales24h,
      sales7d: c.sales7d,
      sales30d: c.sales30d,
      listedCount: c.listedCount,
      totalSupply: c.totalSupply,
      holderCount: c.holderCount,
    });
    const part = breakdown.parts.find((x) => /momentum|velocity/i.test(x.label));
    const momentum = part && part.max > 0 ? (part.points / part.max) * 100 : 0;
    if (momentum < minMomentum) continue;
    out.push({ chainSlug: c.chainSlug, contractAddress: c.contractAddress, momentum, score: breakdown.score, sales24h: c.sales24h });
  }
  return out.sort((a, b) => b.momentum - a.momentum || b.score - a.score).slice(0, limit);
}

/** Enqueue the accelerating set at PREDICT_NEXT. Returns what it did. */
export async function focusAcceleratingCollections(opts?: { minMomentum?: number; limit?: number }): Promise<{ candidates: MarketFocusCandidate[]; enqueued: number }> {
  const rows = await listCollectionsWithSnapshots();
  const candidates = rankAcceleratingCollections(rows, opts);
  let enqueued = 0;
  for (const c of candidates) {
    const sources = await hydrationJobSources(c.chainSlug, c.contractAddress).catch(() => []);
    for (const { source } of sources) {
      try {
        await enqueueDataJob({
          jobKey: `demand:${source}:${c.chainSlug}:${c.contractAddress}`,
          kind: `mesh-lane:${c.chainSlug}`,
          source,
          chainSlug: c.chainSlug,
          subject: c.contractAddress,
          priority: DEMAND_PRIORITY.PREDICT_NEXT,
          payload: { intent: "market-acceleration", momentum: c.momentum },
        });
        enqueued += 1;
      } catch {
        /* counted by omission */
      }
    }
  }
  return { candidates, enqueued };
}
