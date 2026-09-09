import { postgresQuery } from "@/lib/postgres";

/**
 * The Global Market Hub's rank table: one row per collection, holding every
 * key the hub sorts by AND the key it filters by, so the sort is indexable.
 *
 * WHY IT EXISTS
 * -------------
 * The hub's ordering spans two tables -- the filter (`chain_slug`) lives on
 * `plank_multichain_collections`, and almost every sort key
 * (`sales_24h`, `holder_count`, `volume_30d_wei`, ...) lives on
 * `plank_multichain_snapshots`. Postgres cannot index a sort that spans two
 * tables, so every page load scanned `collections`, hash-joined ~345,000
 * snapshot rows, sorted all of them, and returned forty.
 *
 * Measured live 2026-09-09: `limit=500` took 4,934 ms and `limit=40` returned
 * HTTP 504 after 60,081 ms. The smaller page timed out, which is the
 * signature of work that ignores its own limit.
 *
 * Removing `COUNT(*) OVER()` fixed one of TWO full passes over the join. This
 * removes the other.
 *
 * WHY A TABLE AND NOT A VIEW
 * --------------------------
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` over 345k rows on every sync cycle
 * is its own load problem, and a view cannot be updated incrementally by the
 * writer that already knows exactly which single row changed. A real table
 * can be, and is, below.
 *
 * WHY IT IS SAFE TO DERIVE
 * ------------------------
 * Every column here is a copy of a column the catalog already owns. Nothing is
 * computed, interpreted or guessed -- so this table can be dropped and rebuilt
 * from the base tables at any time with no loss. It is an index in table form,
 * not a second source of truth, and it must never become one: if a value
 * exists ONLY here, the next rebuild silently destroys it.
 *
 * The one derived column, `has_floor`, materialises the expression
 * `(floor_price_wei IS NOT NULL)` that appears in the hub's tie-break. As an
 * expression it could never be part of an index; as a stored boolean it can.
 */

/** Columns the hub can sort by, mapped to their rank-table column. */
export const HUB_SORT_COLUMN: Record<string, string> = {
  name: "r.contract_address",
  floor: "r.floor_price_wei",
  volume: "r.volume_24h_wei",
  sales: "r.sales_24h",
  listed: "r.listed_count",
  holders: "r.holder_count",
  change: "r.floor_change_pct",
};

/**
 * The default ordering, matching `plank_market_hub_rank_default_idx` column
 * for column.
 *
 * THE ORDER HERE IS A CONTRACT WITH THE INDEX, not a preference. A composite
 * index only serves a sort whose leading columns match it in sequence; change
 * one term and the plan silently falls back to a full sort, which is the exact
 * failure this table exists to remove -- and it would be invisible, because
 * the results stay correct and only the latency changes.
 */
export const HUB_DEFAULT_ORDER = `
  r.is_vault_backed DESC,
  r.sales_24h DESC NULLS LAST,
  r.sales_7d DESC NULLS LAST,
  r.has_floor DESC,
  r.holder_count DESC NULLS LAST,
  r.volume_30d_wei DESC NULLS LAST,
  r.chain_slug,
  r.contract_address
`;

/**
 * Refresh one collection's rank row from the base tables.
 *
 * Called after a snapshot write. Cheap by construction: a single-row upsert
 * driven by the primary key, with the SELECT reading exactly one row through
 * two primary-key lookups.
 *
 * NEVER THROWS. This table is an accelerator, and a stale rank row costs
 * ordering accuracy on one collection until the next write. A failure here
 * must not fail the snapshot write that triggered it -- losing real observed
 * data to protect a derived index would be exactly backwards.
 */
export async function refreshHubRank(collectionId: number): Promise<void> {
  try {
    await postgresQuery(
      `INSERT INTO plank_market_hub_rank (
         collection_id, chain_slug, contract_address, is_vault_backed,
         floor_price_wei, volume_24h_wei, sales_24h, volume_7d_wei, sales_7d,
         volume_30d_wei, holder_count, listed_count, floor_change_pct, has_floor
       )
       SELECT c.id, c.chain_slug, c.contract_address, COALESCE(c.is_vault_backed, FALSE),
              s.floor_price_wei, s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d,
              s.volume_30d_wei, s.holder_count, s.listed_count, s.floor_change_pct,
              (s.floor_price_wei IS NOT NULL)
         FROM plank_multichain_collections c
         LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
        WHERE c.id = $1
       ON CONFLICT (collection_id) DO UPDATE SET
         chain_slug       = EXCLUDED.chain_slug,
         contract_address = EXCLUDED.contract_address,
         is_vault_backed  = EXCLUDED.is_vault_backed,
         floor_price_wei  = EXCLUDED.floor_price_wei,
         volume_24h_wei   = EXCLUDED.volume_24h_wei,
         sales_24h        = EXCLUDED.sales_24h,
         volume_7d_wei    = EXCLUDED.volume_7d_wei,
         sales_7d         = EXCLUDED.sales_7d,
         volume_30d_wei   = EXCLUDED.volume_30d_wei,
         holder_count     = EXCLUDED.holder_count,
         listed_count     = EXCLUDED.listed_count,
         floor_change_pct = EXCLUDED.floor_change_pct,
         has_floor        = EXCLUDED.has_floor,
         refreshed_at     = NOW()`,
      [collectionId],
    );
  } catch {
    // Deliberate. See the header: an accelerator must never fail its source.
  }
}

/**
 * Rebuild every rank row from the base tables.
 *
 * The recovery path, and the proof that this table is derived: it can always
 * be reconstructed. Bounded per call so a rebuild cannot monopolise a
 * connection; the caller loops until `done`.
 */
export async function rebuildHubRank(batch = 5_000, afterId = 0): Promise<{
  written: number;
  lastId: number;
  done: boolean;
}> {
  const res = await postgresQuery<{ id: string }>(
    `INSERT INTO plank_market_hub_rank (
       collection_id, chain_slug, contract_address, is_vault_backed,
       floor_price_wei, volume_24h_wei, sales_24h, volume_7d_wei, sales_7d,
       volume_30d_wei, holder_count, listed_count, floor_change_pct, has_floor
     )
     SELECT c.id, c.chain_slug, c.contract_address, COALESCE(c.is_vault_backed, FALSE),
            s.floor_price_wei, s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d,
            s.volume_30d_wei, s.holder_count, s.listed_count, s.floor_change_pct,
            (s.floor_price_wei IS NOT NULL)
       FROM (
         SELECT id FROM plank_multichain_collections
          WHERE id > $2::bigint ORDER BY id LIMIT $1::int
       ) page
       JOIN plank_multichain_collections c ON c.id = page.id
       LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     ON CONFLICT (collection_id) DO UPDATE SET
       chain_slug       = EXCLUDED.chain_slug,
       contract_address = EXCLUDED.contract_address,
       is_vault_backed  = EXCLUDED.is_vault_backed,
       floor_price_wei  = EXCLUDED.floor_price_wei,
       volume_24h_wei   = EXCLUDED.volume_24h_wei,
       sales_24h        = EXCLUDED.sales_24h,
       volume_7d_wei    = EXCLUDED.volume_7d_wei,
       sales_7d         = EXCLUDED.sales_7d,
       volume_30d_wei   = EXCLUDED.volume_30d_wei,
       holder_count     = EXCLUDED.holder_count,
       listed_count     = EXCLUDED.listed_count,
       floor_change_pct = EXCLUDED.floor_change_pct,
       has_floor        = EXCLUDED.has_floor,
       refreshed_at     = NOW()
     RETURNING collection_id AS id`,
    [batch, afterId],
  );
  const ids = res.rows.map((r) => Number(r.id));
  const lastId = ids.length ? Math.max(...ids) : afterId;
  return { written: ids.length, lastId, done: ids.length < batch };
}
