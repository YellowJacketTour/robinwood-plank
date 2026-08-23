/**
 * One-time cleanup for the real, already-fixed bug documented in
 * lib/market/multichain/store.ts's resolveCanonicalContractAddress: three
 * non-EVM discovery adapters (ordinalswallet-collection-scan.ts,
 * unisat-collection-list-scan.ts, the magiceden-solana discovery path)
 * each registered a collection under whatever slug string their own
 * upstream API happened to hand back for the SAME real collection.
 *
 * Confirmed live 2026-08-23 via a full-dataset sweep: 37 groups / 74 rows,
 * all non-EVM (28 on ordinalswallet-ordinals, 6 on unisat-collections, 3
 * on magiceden-solana), gated on BOTH a fuzzy-slug match (strip -_ and
 * whitespace, lowercase) AND an exact normalized-name match (strip all
 * non-alphanumerics, lowercase) within the same chain+adapter -- the same
 * sweep found real, genuinely-different collections that fuzzy-match on
 * slug alone (e.g. "foxy" -> "The Foxy Gang" vs "Foxygon") and hundreds of
 * BRC-20 ticker rows that only collide once punctuation is stripped, so
 * this script does NOT merge on slug alone.
 *
 * The write-path guard (store.ts) now prevents new duplicates of this
 * shape from being created; this script cleans up the ones already on
 * disk from before that fix landed. For each merge group, the WINNER is
 * the row with (in order): more indexed plank_foreign_rarity rows, then a
 * real image_url, then a real creator_handle/creator_address, then the
 * lowest id (first discovered). Every satellite table keyed by
 * (chain_slug, collection_slug) or (chain_slug, contract_address) has its
 * loser-side rows folded onto the winner's key (INSERT ... ON CONFLICT DO
 * NOTHING, so nothing already on the winner's key is overwritten) before
 * the loser's plank_multichain_collections row is deleted -- FK-owned
 * tables (plank_multichain_snapshots, plank_collection_floor_observations)
 * are reassigned the same way, and ON DELETE CASCADE cleans up whatever's
 * left (rows that would have collided) when the loser row is finally
 * deleted.
 *
 * plank_collection_cells is intentionally NOT touched: it's keyed by
 * collection_key, not collection_slug, and had zero rows for
 * bitcoin-mainnet at the time this script was written -- confirmed via a
 * direct query, not assumed. If that ever changes this script will still
 * be correct (it just won't migrate that table), not silently wrong.
 *
 * DRY-RUN BY DEFAULT. Nothing is written unless --apply is passed.
 *
 * Usage:
 *   tsx scripts/dedup-slug-collision-collections.ts              (report only)
 *   tsx scripts/dedup-slug-collision-collections.ts --apply      (actually merge+delete)
 */
import { hasPostgresConfig, postgresQuery } from "../lib/postgres";
import { isNonEvmChainSlug } from "../lib/market/multichain/trading/non-evm-chains";

const APPLY = process.argv.includes("--apply");

type Row = {
  id: number;
  chain_slug: string;
  adapter: string;
  contract_address: string;
  name: string | null;
  image_url: string | null;
  creator_handle: string | null;
  creator_address: string | null;
};

function normalizeSlugForCollision(slug: string): string {
  return slug.toLowerCase().replace(/[-_\s]+/g, "");
}

function normalizeNameForCollision(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

async function main() {
  if (!hasPostgresConfig()) {
    throw new Error("dedup-slug-collision-collections: no Postgres config -- set PGHOST/PGDATABASE/PGUSER/PGPASSWORD first.");
  }

  const result = await postgresQuery<Row>(
    `SELECT id, chain_slug, adapter, contract_address, name, image_url, creator_handle, creator_address
     FROM plank_multichain_collections
     WHERE name IS NOT NULL AND name <> ''`
  );

  const groups = new Map<string, Row[]>();
  for (const row of result.rows) {
    if (!isNonEvmChainSlug(row.chain_slug)) continue;
    // Real false-positive class confirmed live in this script's own dry
    // run: BRC-20 ticker rows are named "BRC20 $<ticker>" by
    // ordinalswallet-collection-scan.ts, and OrdinalsWallet's own upstream
    // data has inconsistent whitespace INSIDE the ticker itself (e.g.
    // "BRC20 $BTC", "BRC20 $ BTC", "BRC20 $BTC "). Both normalizers here
    // strip whitespace, so distinct-looking tickers collapse together --
    // this is real width/placement noise in upstream data this script
    // cannot safely tell apart from a genuinely different ticker (BRC-20
    // tickers are meant to be exact-byte-match). Skip the whole BRC20
    // namespace; it needs its own ticker-normalization pass, not this
    // collection-name dedup.
    if (/^brc20\s*\$/i.test(row.name!.trim())) continue;
    const slugKey = normalizeSlugForCollision(row.contract_address);
    const nameKey = normalizeNameForCollision(row.name!);
    if (!slugKey || !nameKey) continue;
    const key = `${row.chain_slug}::${row.adapter}::${slugKey}::${nameKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const mergeGroups = [...groups.values()].filter((g) => g.length > 1);
  console.log(
    `[dedup] found ${mergeGroups.length} merge group(s) / ${mergeGroups.reduce((n, g) => n + g.length, 0)} row(s)${
      APPLY ? "" : " (DRY RUN -- pass --apply to actually merge+delete)"
    }`
  );
  if (mergeGroups.length === 0) {
    console.log("[dedup] nothing to do.");
    return;
  }

  let mergedGroups = 0;
  let deletedRows = 0;

  for (const group of mergeGroups) {
    // Rank: rarity-row count desc, then has image_url, then has
    // creator info, then lowest id (first discovered).
    const rarityCounts = await Promise.all(
      group.map((r) =>
        postgresQuery<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM plank_foreign_rarity WHERE chain_slug = $1 AND collection_slug = $2`,
          [r.chain_slug, r.contract_address]
        ).then((res) => Number(res.rows[0]?.n ?? 0))
      )
    );
    const ranked = group
      .map((r, i) => ({ row: r, rarity: rarityCounts[i] }))
      .sort((a, b) => {
        if (a.rarity !== b.rarity) return b.rarity - a.rarity;
        const aImg = a.row.image_url ? 1 : 0;
        const bImg = b.row.image_url ? 1 : 0;
        if (aImg !== bImg) return bImg - aImg;
        const aCreator = a.row.creator_handle || a.row.creator_address ? 1 : 0;
        const bCreator = b.row.creator_handle || b.row.creator_address ? 1 : 0;
        if (aCreator !== bCreator) return bCreator - aCreator;
        return a.row.id - b.row.id;
      });

    const winner = ranked[0].row;
    const losers = ranked.slice(1).map((r) => r.row);

    console.log(
      `  [${winner.chain_slug}/${winner.adapter}] winner #${winner.id} "${winner.name}" (${winner.contract_address}, rarity=${ranked[0].rarity}) <- ${losers
        .map((l, i) => `#${l.id} (${l.contract_address}, rarity=${rarityCounts[group.indexOf(l)]})`)
        .join(", ")}`
    );

    if (!APPLY) continue;

    for (const loser of losers) {
      // Column-exact migration per table (a generic "SELECT t.*" shape
      // doesn't work here since each table's columns differ).
      await postgresQuery(
        `INSERT INTO plank_foreign_rarity (chain_slug, collection_slug, token_id, name, score, rank, percentile, tier, indexed_at, image_url)
         SELECT chain_slug, $1, token_id, name, score, rank, percentile, tier, indexed_at, image_url
         FROM plank_foreign_rarity WHERE chain_slug = $2 AND collection_slug = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );
      await postgresQuery(
        `INSERT INTO plank_foreign_rarity_collections (chain_slug, collection_slug, sample_size, trait_index, indexed_at, partial)
         SELECT chain_slug, $1, sample_size, trait_index, indexed_at, partial
         FROM plank_foreign_rarity_collections WHERE chain_slug = $2 AND collection_slug = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );
      await postgresQuery(
        `INSERT INTO plank_collection_token_projections (chain_slug, collection_slug, projected_count, expected_count, partial, provenance, source_observed_at, projected_at)
         SELECT chain_slug, $1, projected_count, expected_count, partial, provenance, source_observed_at, projected_at
         FROM plank_collection_token_projections WHERE chain_slug = $2 AND collection_slug = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );
      await postgresQuery(
        `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, name, image_url, rarity_score, rarity_rank, rarity_percentile, rarity_tier, provenance, source_observed_at, projected_at, traits, metadata_state, metadata_attempted_at, metadata_error, animation_url, media_type)
         SELECT chain_slug, $1, token_id, name, image_url, rarity_score, rarity_rank, rarity_percentile, rarity_tier, provenance, source_observed_at, projected_at, traits, metadata_state, metadata_attempted_at, metadata_error, animation_url, media_type
         FROM plank_collection_tokens WHERE chain_slug = $2 AND collection_slug = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );
      await postgresQuery(
        `INSERT INTO plank_collection_membership_cursors (chain_slug, collection_slug, source, cursor, expected_count, observed_count, complete, last_error, source_observed_at, updated_at)
         SELECT chain_slug, $1, source, cursor, expected_count, observed_count, complete, last_error, source_observed_at, updated_at
         FROM plank_collection_membership_cursors WHERE chain_slug = $2 AND collection_slug = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );
      await postgresQuery(
        `INSERT INTO plank_multichain_activity_stats (chain_slug, contract_address, activity_day, transfer_count)
         SELECT chain_slug, $1, activity_day, transfer_count
         FROM plank_multichain_activity_stats WHERE chain_slug = $2 AND contract_address = $3
         ON CONFLICT DO NOTHING`,
        [winner.contract_address, loser.chain_slug, loser.contract_address]
      );

      // FK-owned tables: reassign by numeric collection_id.
      await postgresQuery(
        `UPDATE plank_multichain_snapshots
         SET collection_id = $1
         WHERE collection_id = $2
           AND NOT EXISTS (SELECT 1 FROM plank_multichain_snapshots WHERE collection_id = $1)`,
        [winner.id, loser.id]
      );
      await postgresQuery(
        `UPDATE plank_collection_floor_observations f
         SET collection_id = $1
         WHERE f.collection_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM plank_collection_floor_observations f2
             WHERE f2.collection_id = $1 AND f2.marketplace = f.marketplace AND f2.observation_bucket = f.observation_bucket
           )`,
        [winner.id, loser.id]
      );

      // Whatever's left on the loser's key (only rows that would have
      // collided on insert, i.e. real duplicate data already present on
      // the winner) is intentionally dropped here: the winner's own copy
      // is kept, and the loser row's ON DELETE CASCADE FKs clean up any
      // remaining collection_id-keyed rows automatically.
      const del = await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [loser.id]);
      deletedRows += del.rowCount ?? 0;
    }
    mergedGroups += 1;
  }

  if (APPLY) {
    console.log(`[dedup] merged ${mergedGroups} group(s), deleted ${deletedRows} loser row(s).`);
  } else {
    console.log("\n[dedup] Re-run with --apply to actually perform the merges listed above.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[dedup] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
