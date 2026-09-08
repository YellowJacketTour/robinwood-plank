import { randomUUID } from "node:crypto";
import { postgresPool, postgresQuery } from "@/lib/postgres";

export type ProviderWindow = {
  key: string;
  startsAt: Date;
  endsAt: Date;
  allowance: number;
};

/** UniSat currently documents 2,000 Open API calls/day. Background work is
 * capped below that hard limit so collection pages, visitor-triggered reads,
 * and Bitcoin transaction preparation retain deterministic headroom. Every
 * background UniSat lane must share this exact account/window key. */
export const UNISAT_BACKGROUND_DAILY_ALLOWANCE = 1_800;

export function unisatBackgroundDayWindow(now = new Date()): ProviderWindow {
  return utcDayWindow(UNISAT_BACKGROUND_DAILY_ALLOWANCE, now);
}

/** Atomically reserve shared provider capacity. False means defer, never call. */
export async function reserveProviderCapacity(
  providerAccount: string,
  window: ProviderWindow,
  cost = 1
): Promise<boolean> {
  if (!providerAccount || !window.key || cost < 1 || !Number.isInteger(cost) || cost > window.allowance) return false;
  const result = await postgresQuery<{ admitted: boolean }>(
    `INSERT INTO plank_provider_windows
       (provider_account, window_key, window_started_at, window_ends_at, allowance, reserved)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider_account, window_key, window_started_at) DO UPDATE SET
       window_ends_at = EXCLUDED.window_ends_at,
       allowance = EXCLUDED.allowance,
       reserved = plank_provider_windows.reserved + EXCLUDED.reserved,
       updated_at = NOW()
     WHERE plank_provider_windows.reserved + plank_provider_windows.consumed + EXCLUDED.reserved
           <= EXCLUDED.allowance
     RETURNING TRUE AS admitted`,
    [providerAccount, window.key, window.startsAt, window.endsAt, window.allowance, cost]
  );
  return result.rows[0]?.admitted === true;
}

export async function settleProviderCapacity(
  providerAccount: string,
  window: Pick<ProviderWindow, "key" | "startsAt">,
  cost = 1,
  consumed = true
): Promise<void> {
  await postgresQuery(
    `UPDATE plank_provider_windows SET
       reserved = GREATEST(0, reserved - $4),
       consumed = consumed + CASE WHEN $5 THEN $4 ELSE 0 END,
       updated_at = NOW()
     WHERE provider_account = $1 AND window_key = $2 AND window_started_at = $3`,
    [providerAccount, window.key, window.startsAt, cost, consumed]
  );
}

export function utcDayWindow(allowance: number, now = new Date()): ProviderWindow {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endsAt = new Date(startsAt.getTime() + 86_400_000);
  return { key: "day", startsAt, endsAt, allowance };
}

export async function writeCollectionCell(input: {
  chainSlug: string;
  collectionKey: string;
  cell: string;
  source: string;
  state: "fresh" | "stale" | "partial" | "unavailable" | "unsupported" | "invalidated";
  coverage?: number | null;
  sourceBlock?: number | null;
  validUntil?: Date | null;
  lastError?: string | null;
}): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_collection_cells
       (chain_slug, collection_key, cell, source, source_observed_at, source_block,
        valid_until, coverage, state, last_error)
     VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9)
     ON CONFLICT (chain_slug, collection_key, cell) DO UPDATE SET
       source = EXCLUDED.source, source_observed_at = EXCLUDED.source_observed_at,
       source_block = COALESCE(EXCLUDED.source_block, plank_collection_cells.source_block),
       refreshed_at = NOW(), valid_until = EXCLUDED.valid_until,
       coverage = EXCLUDED.coverage, state = EXCLUDED.state,
       last_error = EXCLUDED.last_error, version = plank_collection_cells.version + 1`,
    [input.chainSlug, input.collectionKey, input.cell, input.source, input.sourceBlock ?? null,
      input.validUntil ?? null, input.coverage ?? null, input.state, input.lastError ?? null]
  );
}

export async function writeChainCoverage(input: {
  chainSlug: string;
  lane: "historical" | "forward" | "priority";
  standardGroup: string;
  rangeStart: number;
  nextBlock: number;
  targetBlock?: number | null;
  observedHead?: number | null;
  state: "backfilling" | "live" | "complete" | "stalled" | "unavailable";
  lastError?: string | null;
}): Promise<void> {
  if (input.rangeStart < 0 || input.nextBlock < input.rangeStart) {
    throw new Error("invalid chain coverage range");
  }
  await postgresQuery(
    `INSERT INTO plank_chain_coverage
       (chain_slug, lane, standard_group, range_start, next_block, target_block,
        observed_head, state, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (chain_slug, lane, standard_group) DO UPDATE SET
       range_start = LEAST(plank_chain_coverage.range_start, EXCLUDED.range_start),
       next_block = GREATEST(plank_chain_coverage.next_block, EXCLUDED.next_block),
       target_block = COALESCE(EXCLUDED.target_block, plank_chain_coverage.target_block),
       observed_head = COALESCE(EXCLUDED.observed_head, plank_chain_coverage.observed_head),
       state = EXCLUDED.state, last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [input.chainSlug, input.lane, input.standardGroup, input.rangeStart, input.nextBlock,
      input.targetBlock ?? null, input.observedHead ?? null, input.state, input.lastError ?? null]
  );
}

export type DataJobInput = {
  jobKey: string;
  kind: string;
  source: string;
  chainSlug?: string | null;
  subject?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  notBefore?: Date;
};

/** Deduplicated enqueue. New demand raises priority and may pull work forward. */
export async function enqueueDataJob(input: DataJobInput): Promise<number> {
  const result = await postgresQuery<{ id: string }>(
    `INSERT INTO plank_data_jobs
       (job_key, kind, source, chain_slug, subject, payload, priority, not_before)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (job_key) DO UPDATE SET
       priority = GREATEST(plank_data_jobs.priority, EXCLUDED.priority),
       not_before = LEAST(plank_data_jobs.not_before, EXCLUDED.not_before),
       payload = plank_data_jobs.payload || EXCLUDED.payload,
       status = CASE WHEN plank_data_jobs.status IN ('failed', 'succeeded') THEN 'queued' ELSE plank_data_jobs.status END,
       -- completed_at is kept as "last completion" (2026-09-06): a partial
       -- lane that re-enqueues itself still completed real work, and the
       -- throughput telemetry counts completions in a window, not statuses.
       updated_at = NOW()
     RETURNING id::text`,
    [input.jobKey, input.kind, input.source, input.chainSlug ?? null, input.subject ?? null,
      JSON.stringify(input.payload ?? {}), input.priority ?? 0, input.notBefore ?? new Date()]
  );
  return Number(result.rows[0].id);
}

export type ClaimedDataJob = {
  id: number;
  jobKey: string;
  kind: string;
  source: string;
  chainSlug: string | null;
  subject: string | null;
  payload: Record<string, unknown>;
  leaseOwner: string;
};

export async function claimDataJob(kinds?: string[], leaseMs = 300_000, minPriority?: number, maxPriority?: number, jobKeyPrefix?: string, sources?: string[]): Promise<ClaimedDataJob | null> {
  const owner = `${process.pid}:${randomUUID()}`;
  const pool = postgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE plank_data_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE status = 'running' AND lease_expires_at < NOW()`
    );
    const params: unknown[] = [];
    const kindClause = kinds?.length ? `AND j.kind = ANY($1::text[])` : "";
    if (kinds?.length) params.push(kinds);
    // Express lane (2026-09-06): a worker may claim only jobs at or above a
    // priority floor, so a visitor's own open collection never waits behind
    // rankings backfill for a free slot.
    let priorityClause = "";
    if (typeof minPriority === "number" && Number.isFinite(minPriority)) {
      params.push(minPriority);
      priorityClause = `AND j.priority >= $${params.length}`;
    }
    // Standing-lane worker (2026-09-06): discovery/stats/fills lanes sit at
    // priority 20-60 and were starved by hundreds of demand jobs at 100+, so
    // no new collections were being discovered while visitors browsed. A
    // worker may cap the priority it claims so those lanes always get a slot.
    if (typeof maxPriority === "number" && Number.isFinite(maxPriority)) {
      params.push(maxPriority);
      priorityClause += ` AND j.priority <= $${params.length}`;
    }
    // Standing-slot claim by IDENTITY (2026-09-07): the standing worker used
    // to claim "priority <= 60", and production's next candidates at that
    // bound were hundreds of demand:evm-metadata jobs at exactly 60, so the
    // priority-20 standing lanes (hunters, parity, discovery, the Solana
    // catalog walk) had never been claimed once. A prefix on job_key
    // ("mesh:") names the standing lanes themselves, whatever the demand
    // tiers do.
    if (jobKeyPrefix) {
      params.push(`${jobKeyPrefix}%`);
      priorityClause += ` AND j.job_key LIKE $${params.length}`;
    }
    // Restrict a worker to specific lane sources (2026-09-07). The standing
    // slot rotates fairly over ALL 154 standing lanes, of which only 26
    // discover collections, so each discovery lane got roughly one turn in
    // 154 -- measured live at ~4 new collections in 3 minutes across every
    // chain combined. A dedicated discovery worker claims only these.
    if (sources?.length) {
      params.push(sources);
      priorityClause += ` AND j.source = ANY($${params.length}::text[])`;
    }
    // Fair rotation for the standing slot (2026-09-07, second probe): with
    // priority ordering the three priority-60 standing lanes (seaport-live
    // per chain) finished instantly, re-enqueued, and were claimed again
    // ahead of every priority-20 lane, 213 times in ten minutes. Standing
    // lanes are peers: the one that ran least recently goes next.
    // Third probe (2026-09-07): completed_at is only set on success, so a lane
    // that FAILS every time (hypersync-backfill:base-mainnet, client read
    // timeout) sorted first on every claim and took the slot repeatedly.
    // mesh_lane_health.last_claim_at is written on every claim whatever the
    // outcome; least-recently-CLAIMED is the fair key.
    // Fair rotation for the standing slot, take four (2026-09-07, live: NO
    // standing lane was claimed for six hours after take three shipped).
    // Take three put a CORRELATED SUBQUERY in the ORDER BY of a SELECT ...
    // FOR UPDATE. Postgres rejects that combination outright ("FOR UPDATE
    // is not allowed with ... subquery"), so every standing claim threw,
    // the worker's claim returned nothing, and only lanes that some other
    // path re-enqueued ever ran. The same ordering as an explicit LEFT JOIN
    // with FOR UPDATE OF j is valid, and locks only the job row.
    const standingOrder = jobKeyPrefix;
    const orderClause = standingOrder
      ? "h.last_claim_at NULLS FIRST, j.attempts, j.not_before, j.id"
      : "j.priority DESC, j.attempts, j.not_before, j.id";
    params.push(leaseMs);
    const leaseParam = `$${params.length}`;
    params.push(owner);
    const ownerParam = `$${params.length}`;
    const result = await client.query<{
      id: string; job_key: string; kind: string; source: string; chain_slug: string | null;
      subject: string | null; payload: Record<string, unknown>;
    }>(
      // Real starvation found live 2026-08-27: within one priority tier,
      // ties broke on (not_before, id) alone -- a job that keeps FAILING
      // and getting re-claimed (same job_key, same low id, unchanged
      // not_before) permanently out-competes a newer, never-yet-tried job
      // at the identical priority, forever. Confirmed live: CloneX's
      // anchored-membership job (HyperSync-backed, genuinely unrestricted,
      // no OpenSea dependency at all) sat at max priority (120) with ZERO
      // claims the entire session while dozens of older opensea-membership
      // rows at the same tier, some already 20 attempts deep into a real
      // OpenSea-contention retry loop, kept winning the id tiebreak every
      // single round. Ordering by attempts first within a priority tier
      // means every job gets a real first try before any job gets a
      // second -- a fair round-robin instead of a queue where early
      // failures compound into permanent starvation of untried work.
      `WITH candidate AS (
         SELECT j.id FROM plank_data_jobs j
         ${standingOrder ? "LEFT JOIN mesh_lane_health h ON h.lane_key = j.source || ':' || j.chain_slug" : ""}
         WHERE j.status = 'queued' AND j.not_before <= NOW() ${kindClause} ${priorityClause}
         ORDER BY ${orderClause}
         FOR UPDATE OF j SKIP LOCKED LIMIT 1
       )
       UPDATE plank_data_jobs j SET status = 'running', attempts = attempts + 1,
         lease_owner = ${ownerParam}, lease_expires_at = NOW() + (${leaseParam}::text || ' milliseconds')::interval,
         updated_at = NOW()
       FROM candidate WHERE j.id = candidate.id
       RETURNING j.id::text, j.job_key, j.kind, j.source, j.chain_slug, j.subject, j.payload`,
      params
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    return row ? { id: Number(row.id), jobKey: row.job_key, kind: row.kind, source: row.source,
      chainSlug: row.chain_slug, subject: row.subject, payload: row.payload, leaseOwner: owner } : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Put a running job back in the queue to be claimed no earlier than
 * `notBefore` (2026-09-06, AUDIT lens 5 E/F). enqueueDataJob's LEAST()
 * ratchet can never push not_before forward, so "retry after the jail
 * lifts" or "retry in 10 s" was impossible; lanes slept inside a slot
 * instead. This releases the slot immediately.
 */
export async function deferDataJob(job: Pick<ClaimedDataJob, "id" | "leaseOwner">, notBefore: Date, reason?: string | null): Promise<void> {
  await postgresQuery(
    `UPDATE plank_data_jobs SET status = 'queued', not_before = $2, last_error = $3, lease_owner = NULL,
       lease_expires_at = NULL, updated_at = NOW()
     WHERE id = $1 AND lease_owner = $4`,
    [job.id, notBefore, reason ?? null, job.leaseOwner]
  );
}

export async function finishDataJob(job: Pick<ClaimedDataJob, "id" | "leaseOwner">, error?: string): Promise<void> {
  await postgresQuery(
    `UPDATE plank_data_jobs SET status = $3, last_error = $4, lease_owner = NULL,
       lease_expires_at = NULL, completed_at = CASE WHEN $3 = 'succeeded' THEN NOW() ELSE NULL END,
       updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2`,
    [job.id, job.leaseOwner, error ? "failed" : "succeeded", error ?? null]
  );
}
