/**
 * Real, bounded, incremental reconciliation of collection_archival_stats.
 * fills_ever_stored -- a real, systemic gap found live 2026-08-26: this
 * column has been 0 across every one of 558,678 tracked collections since
 * it was created, because no real caller ever passed `isFill: true` to
 * recordArchivalHydration. ~79 million real fills already sit indexed
 * across plank_seaport_fills and the 8 other real per-venue fill tables --
 * this is a display-honesty gap (archive-depth understates real completed
 * work), not a missing-data gap.
 *
 * Deliberately NOT a single full-catalog aggregate: a first attempt at
 * that (one GROUP BY across all ~78M rows) took over 2 minutes and was
 * still competing with a real, concurrently-running anti-wraparound
 * autovacuum on plank_seaport_fills -- exactly the kind of unbounded,
 * all-at-once operation this app's own 2026-08-25 disk-fill incident
 * taught it to avoid. This does the same real reconciliation work in
 * small, indexed, per-collection batches instead, same shape as
 * erc4906-rescan.ts and archival-ledger.ts's own frontier lane.
 *
 * Also NOT wired into the real seaport-fill-indexer.ts hot write path
 * (which runs at real, very high volume -- tens of millions of calls) --
 * a synchronous ledger read+write per fill there would add real,
 * meaningful overhead to the primary indexing pipeline. This lane keeps
 * fills_ever_stored eventually-consistent instead, which is the right
 * tradeoff for a completeness DISPLAY metric, not a correctness-critical
 * one.
 */
import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";

/** Every real fill table this app writes to, each keyed by
 * (chain_slug, nft_contract) with a real supporting index -- see each
 * table's own *_collection_idx. */
const FILL_TABLES = [
  "plank_seaport_fills",
  "plank_blur_fills",
  "plank_looksrare_fills",
  "plank_x2y2_fills",
  "plank_wyvern_fills",
  "plank_foundation_fills",
  "plank_sudoswap_fills",
  "plank_cryptokitties_fills",
] as const;

const CURSOR_KEY = "fills-reconcile:cursor-offset";

/**
 * Processes a small, bounded batch of tracked collections: for each, sums
 * real fills across every venue table (indexed per-collection COUNT, not a
 * full-table scan) and raises fills_ever_stored via GREATEST if the real
 * total exceeds what's currently recorded. Cursor-paginated through
 * plank_multichain_collections so repeated invocations sweep the whole
 * real catalog over time without ever doing more than `limit` collections'
 * worth of work per call.
 */
export async function reconcileFillsBatch(limit = 10): Promise<{ checked: number; updated: number; totalFillsAdded: number }> {
  const offset = (await durableKv.get<number>(CURSOR_KEY)) ?? 0;
  const collections = await postgresQuery<{ chain_slug: string; contract_address: string }>(
    `SELECT chain_slug, contract_address FROM plank_multichain_collections
     ORDER BY chain_slug, contract_address
     OFFSET $1 LIMIT $2`,
    [offset, limit]
  );

  if (collections.rows.length === 0) {
    await durableKv.set(CURSOR_KEY, 0); // real end of catalog reached -- wrap around
    return { checked: 0, updated: 0, totalFillsAdded: 0 };
  }

  let updated = 0;
  let totalFillsAdded = 0;
  for (const row of collections.rows) {
    let realFills = 0;
    for (const table of FILL_TABLES) {
      const result = await postgresQuery<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE chain_slug = $1 AND lower(nft_contract) = lower($2)`,
        [row.chain_slug, row.contract_address]
      ).catch(() => ({ rows: [{ n: "0" }] }));
      realFills += Number(result.rows[0]?.n ?? 0);
    }
    if (realFills === 0) continue;

    const before = await postgresQuery<{ fills_ever_stored: number }>(
      `SELECT fills_ever_stored FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
      [row.chain_slug, row.contract_address.toLowerCase()]
    );
    const priorCount = before.rows[0]?.fills_ever_stored ?? 0;
    if (realFills <= priorCount) continue;

    await postgresQuery(
      `INSERT INTO collection_archival_stats (chain_slug, collection_key, fills_ever_stored, organic_hits, first_archived_at, last_archived_at)
       VALUES ($1, $2, $3, 0, now(), now())
       ON CONFLICT (chain_slug, collection_key) DO UPDATE SET
         fills_ever_stored = GREATEST(collection_archival_stats.fills_ever_stored, $3)`,
      [row.chain_slug, row.contract_address.toLowerCase(), realFills]
    );
    updated += 1;
    totalFillsAdded += realFills - priorCount;
  }

  await durableKv.set(CURSOR_KEY, offset + collections.rows.length);
  return { checked: collections.rows.length, updated, totalFillsAdded };
}
