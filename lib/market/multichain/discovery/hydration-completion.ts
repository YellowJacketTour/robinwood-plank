/**
 * Cheap, indexed-read completion checks for the demand-driven hydration job
 * kinds in collection-demand.ts's hydrationJobSources -- same real gap that
 * was previously found and fixed for anchored-membership ONLY (see that
 * fix's own comment in collection-demand.ts, 2026-08-25: an already-complete
 * collection's job kept getting senselessly re-enqueued on every repeat page
 * visit, permanently winning every priority tie over other, genuinely
 * incomplete collections' real work). The other hydration sources
 * (opensea/robinhood/helius/unisat membership, evm-metadata) had the exact
 * same unconditional-re-enqueue shape and the exact same fix available --
 * they just never got it. No network call, ever: every check here is one
 * indexed read against a durable completion cursor this app already writes.
 */
import { postgresQuery } from "@/lib/postgres";

/** plank_collection_membership_cursors.source values -- must exactly match
 * what each source's own runner writes (rarity-index-runner.ts,
 * helius-rarity-index-runner.ts, unisat-membership-index-runner.ts). */
const OPENSEA_NFTS_SOURCE = "opensea-nfts";
const HELIUS_DAS_GROUPING_SOURCE = "helius-das-grouping";
const UNISAT_COLLECTION_ITEMS_SOURCE = "unisat-collection-items";

async function isMembershipSourceComplete(
  chainSlug: string,
  collectionKey: string,
  source: string
): Promise<boolean> {
  const result = await postgresQuery<{ complete: boolean }>(
    `SELECT complete FROM plank_collection_membership_cursors
      WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND source = $3`,
    [chainSlug, collectionKey, source]
  );
  return result.rows[0]?.complete === true;
}

/** opensea-membership and robinhood-membership both write the same
 * OPENSEA_NFTS_SOURCE row (see rarity-index-runner.ts's own
 * advanceNextRobinhoodMembership, which shares the OpenSea source constant
 * across both chains) -- one check covers both job kinds. */
export async function isOpenseaMembershipComplete(chainSlug: string, collectionKey: string): Promise<boolean> {
  return isMembershipSourceComplete(chainSlug, collectionKey, OPENSEA_NFTS_SOURCE);
}

export async function isHeliusMembershipComplete(chainSlug: string, collectionKey: string): Promise<boolean> {
  return isMembershipSourceComplete(chainSlug, collectionKey, HELIUS_DAS_GROUPING_SOURCE);
}

export async function isUnisatMembershipComplete(chainSlug: string, collectionKey: string): Promise<boolean> {
  return isMembershipSourceComplete(chainSlug, collectionKey, UNISAT_COLLECTION_ITEMS_SOURCE);
}

/**
 * Real gap found live 2026-08-27 ("does it know it's reached 100%?"): NO --
 * confirmed live on CloneX, whose real `plank_collection_tokens` row count
 * had already reached its full, real, known total_supply (19,764 of
 * 19,764), yet isOpenseaMembershipComplete/isAnchoredMembershipComplete/
 * isEvmMetadataComplete all still reported false, and three separate
 * membership sources (opensea-membership, anchored-membership,
 * robinhood-membership) kept actively re-enqueuing and re-walking a
 * collection that was already functionally finished. Root cause: each
 * source's own `complete` flag is set only when THAT source's own
 * pagination/scan personally reaches its own end -- HyperSync's
 * anchored-membership had already written every real row via a DIFFERENT
 * path, but OpenSea's own walk had no way to know that and kept paginating
 * regardless, wasting real, rate-limited OpenSea capacity on a collection
 * with nothing left to discover.
 *
 * This is a source-agnostic, additional short-circuit: real row count in
 * plank_collection_tokens vs the real, independently-sourced total_supply
 * already on plank_multichain_snapshots (the same number the UI's own
 * "X of Y" item count reads from). Two real indexed reads, no network
 * call. A `null` total_supply (never yet reported by any stats source)
 * correctly returns false -- absence of a known ceiling is not evidence of
 * completeness.
 */
export async function isMembershipCountComplete(chainSlug: string, collectionKey: string): Promise<boolean> {
  const result = await postgresQuery<{ observed: string; total_supply: number | null }>(
    `SELECT
       (SELECT COUNT(*) FROM plank_collection_tokens t
          WHERE t.chain_slug = $1 AND lower(t.collection_slug) = lower($2))::text AS observed,
       (SELECT s.total_supply FROM plank_multichain_collections c
          JOIN plank_multichain_snapshots s ON s.collection_id = c.id
          WHERE c.chain_slug = $1 AND lower(c.contract_address) = lower($2)) AS total_supply`,
    [chainSlug, collectionKey]
  );
  const row = result.rows[0];
  if (!row || row.total_supply == null || row.total_supply <= 0) return false;
  return Number(row.observed) >= row.total_supply;
}

/** Same condition advanceEvmTokenMetadata's own rarity-finalize step already
 * computes for itself (rarity-index-runner.ts ~line 487): membership fully
 * enumerated AND zero rows still pending/retry. Metadata work is per-token,
 * not a single cursor, so "complete" here means there is nothing left this
 * source could usefully do for this collection right now -- new pending rows
 * can still appear later (e.g. a fresh mint), at which point this correctly
 * reports incomplete again. */
export async function isEvmMetadataComplete(chainSlug: string, collectionKey: string): Promise<boolean> {
  const result = await postgresQuery<{ remaining: string; membership_complete: boolean }>(
    `SELECT COUNT(*) FILTER (WHERE t.metadata_state IN ('pending','retry'))::text AS remaining,
       EXISTS (
         SELECT 1 FROM plank_collection_membership_cursors m
         WHERE m.chain_slug = $1 AND lower(m.collection_slug) = lower($2) AND m.complete
       ) AS membership_complete
     FROM plank_collection_tokens t
     WHERE t.chain_slug = $1 AND lower(t.collection_slug) = lower($2)`,
    [chainSlug, collectionKey]
  );
  const row = result.rows[0];
  if (!row) return false; // no token rows yet at all -- genuinely nothing known, not "done"
  return row.membership_complete === true && Number(row.remaining) === 0;
}
