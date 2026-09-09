/**
 * Lock-free shard claiming: many workers, one past, no coordinator.
 *
 * The planner (shard.ts) says WHICH ranges of a chain's past need walking.
 * This says how N workers divide them without a lock service, a leader, or a
 * partition assignment that goes stale the moment a worker dies.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` is the whole mechanism. Each worker asks
 * for the next unclaimed rows and Postgres hands every worker a DIFFERENT set,
 * skipping rows another transaction already holds rather than blocking behind
 * them. No two workers can take the same shard, and a worker that crashes
 * mid-shard releases its rows when its transaction dies.
 *
 * WHY A LEASE AND NOT A DELETE
 * ----------------------------
 * A claimed row is stamped, not removed. A worker that dies AFTER committing
 * its claim but BEFORE writing coverage would otherwise take that range to the
 * grave -- the shard would look done and the archive would carry a hole that
 * nothing revisits, which is exactly the failure this whole package exists to
 * refuse. The stamp expires, so an abandoned shard returns to the pool.
 *
 * WHY EXPIRY IS NOT A TIMEOUT ON THE WORK
 * ---------------------------------------
 * The lease bounds how long a claim may be TRUSTED, not how long a shard may
 * take. A slow-but-alive worker whose lease expires does not corrupt anything:
 * a second worker re-walks the same range and writes the same coverage row,
 * because akasha_coverage_run is keyed (chain, from_height) and a rewrite
 * replaces rather than duplicates. Duplicated effort is the acceptable cost;
 * an unrevisited hole is not.
 */
import type { ChainId } from "../shared/types.ts";
import type { Shard } from "./shard.ts";

/** How long a claim is trusted before the shard returns to the pool. */
export const CLAIM_LEASE_SEC = 900;

/** The reason a shard claim carries. Already in migration 104's closed set. */
export const SHARD_REASON = "epoch_backfill" as const;

export interface ClaimRow {
  id: string;
  chain: string;
  from_height: string;
  to_height: string;
  attempts: number;
}

export interface ClaimSql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Enqueue shards as claimable work.
 *
 * Idempotent by (chain, from_height, to_height) among UNCLAIMED rows, so a
 * planner that runs every tick does not pile up duplicates of the same range.
 * A row that is already claimed is deliberately NOT deduped against: if its
 * lease later expires the range genuinely does need re-doing, and refusing to
 * re-enqueue would be the hole-leaving failure again.
 */
export async function enqueueShards(sql: ClaimSql, shards: Shard[]): Promise<number> {
  let queued = 0;
  for (const s of shards) {
    const res = await sql.query(
      `INSERT INTO akasha_gap_queue (chain, from_height, to_height, reason, attempts)
       SELECT $1, $2, $3, $4, 0
        WHERE NOT EXISTS (
          SELECT 1 FROM akasha_gap_queue
           WHERE chain = $1 AND from_height = $2 AND to_height = $3
             AND reason = $4 AND claimed_at IS NULL
        )
       RETURNING id`,
      [s.chain, s.from, s.to, SHARD_REASON],
    );
    queued += res.rows.length;
  }
  return queued;
}

/**
 * Claim up to `limit` shards for this worker.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run from any number of
 * processes at once: rows another transaction holds are skipped, not waited
 * on, so workers never serialise behind each other and never collide.
 *
 * A row is claimable when it has never been claimed, or when its lease has
 * expired -- the abandoned-worker case.
 *
 * Ordered by id, which is enqueue order, which the planner made newest-first:
 * recent history lands first and the archive becomes useful from the top down
 * while its oldest shards are still outstanding.
 */
export async function claimShards(
  sql: ClaimSql,
  chain: ChainId,
  limit: number,
  leaseSec = CLAIM_LEASE_SEC,
): Promise<Shard[]> {
  if (limit < 1) return [];
  const res = await sql.query(
    `WITH claimed AS (
       SELECT id FROM akasha_gap_queue
        WHERE chain = $1 AND reason = $2
          AND (claimed_at IS NULL OR claimed_at < NOW() - ($3::int * INTERVAL '1 second'))
        ORDER BY id
        LIMIT $4::int
        FOR UPDATE SKIP LOCKED
     )
     UPDATE akasha_gap_queue g
        SET claimed_at = NOW(), attempts = g.attempts + 1
       FROM claimed c
      WHERE g.id = c.id
     RETURNING g.id, g.chain, g.from_height, g.to_height, g.attempts`,
    [chain, SHARD_REASON, leaseSec, limit],
  );
  return res.rows.map((r) => ({
    chain: String(r.chain) as ChainId,
    from: Number(r.from_height),
    to: Number(r.to_height),
  }));
}

/**
 * Retire a shard whose coverage is written.
 *
 * Called ONLY after the coverage run is durable. Retiring on the walk instead
 * of on the write is the same class of bug as recording coverage for a block
 * that threw halfway through: it claims work that was attempted, not work that
 * was finished.
 */
export async function retireShard(sql: ClaimSql, shard: Shard): Promise<boolean> {
  const res = await sql.query(
    `DELETE FROM akasha_gap_queue
      WHERE chain = $1 AND from_height = $2 AND to_height = $3 AND reason = $4
      RETURNING id`,
    [shard.chain, shard.from, shard.to, SHARD_REASON],
  );
  return res.rows.length > 0;
}

/**
 * Release a claim without retiring it, so it returns to the pool at once.
 *
 * A worker that fails cleanly (an RPC refusing, a seam that did not link)
 * should not make the next attempt wait out the full lease. Failing loudly and
 * immediately is better than failing silently and slowly.
 */
export async function releaseShard(sql: ClaimSql, shard: Shard): Promise<void> {
  await sql.query(
    `UPDATE akasha_gap_queue SET claimed_at = NULL
      WHERE chain = $1 AND from_height = $2 AND to_height = $3 AND reason = $4`,
    [shard.chain, shard.from, shard.to, SHARD_REASON],
  );
}
