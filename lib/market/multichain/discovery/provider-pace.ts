/**
 * Generalized cross-process provider call pacer -- Unified Mesh Continuum
 * build (docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md
 * item #1's mechanism). Same atomic-claim-a-slot pattern already shipped
 * and DB-verified for OpenSea (opensea-key-pool.ts's claimOpenSeaPaceSlot,
 * 2026-08-26 -- see that file's own header for the real incident this
 * pattern fixes: a daily ceiling alone lets many concurrent callers burst
 * past a provider's true per-hour/per-second rate in seconds, each burst
 * 429 then costing a real multi-minute jail cool-down instead of just
 * pacing evenly under the real limit).
 *
 * ONLY the `min_interval_ms` mode is implemented here. Grok's original
 * draft for this file also proposed a `token_bucket` mode (for providers
 * documented as a rate-over-window rather than a flat minimum spacing,
 * e.g. Alchemy's "300 CU/s, ~10s window" framing) -- that draft had a real
 * bug (its final atomic UPDATE silently returns zero rows when the bucket
 * is empty, so the caller can't distinguish "denied" from "query error"
 * without extra work, and the refill accounting doesn't advance
 * correctly across that no-op case). Not shipped until it gets the same
 * direct-DB verification pass claimOpenSeaPaceSlot got before merging --
 * see GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md's "Build
 * decision" section.
 *
 * IMPORTANT: register a real profile in PROVIDER_PACE_PROFILES only once
 * its number is independently reconfirmed against that provider's own
 * CURRENT documentation by this app (never inherited from an external
 * research response without a live re-check) -- see source-budget.ts's own
 * header for why this app has repeatedly REMOVED self-imposed ceilings
 * that turned out to be guesses. An unregistered source is simply not
 * paced by this module (the existing daily-ceiling + reactive-jail
 * circuit breaker in source-budget.ts / mesh/jail.ts still applies
 * regardless).
 */
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";

export type PaceProfile = {
  /** Real documented minimum spacing between calls, in ms (e.g. OpenSea's
   * 600/hour == 6000ms, paced at 6200ms for a small safety margin). */
  minIntervalMs: number;
};

/** Real, live-reconfirmed provider pace profiles. Empty entries are
 * deliberately absent rather than filled with an unverified guess.
 *
 * Helius entries independently reconfirmed 2026-08-26 by direct fetch of
 * helius.dev/docs/billing/rate-limits (Free plan): RPC 10 req/s, DAS &
 * Enhanced APIs 2 req/s, getProgramAccounts 5 req/s -- matches this app's
 * own prior finding cited in helius-key-pool.ts's header (2026-08-23,
 * "Free 2 RPS / Developer 10 RPS..." for DAS specifically). Only
 * "helius-rpc" is wired to a real caller today (helius-transfer-scan.ts's
 * getSignaturesForAddress, a plain RPC method, not DAS or GPA) -- the
 * other two are registered for when a real DAS/GPA caller exists, not
 * gating anything yet.
 *
 * Alchemy's real number (300 CU/s, token-bucket, 10s rolling window, up
 * to 3,000 CU burst -- confirmed live 2026-08-26 via alchemy.com/docs/
 * reference/throughput) is NOT registered here: this module only
 * implements the min_interval_ms mode, and a flat minimum-spacing pace
 * would misrepresent a real token-bucket/burst-capacity limit (undercounts
 * real available burst headroom). Needs its own token_bucket mode, built
 * and DB-verified the same way min_interval_ms was, not approximated.
 */
export const PROVIDER_PACE_PROFILES: Record<string, PaceProfile> = {
  "opensea-stats": { minIntervalMs: 6_200 },
  "helius-rpc": { minIntervalMs: 110 }, // 10 req/s + small safety margin
};

/** Real, live-reconfirmed Alchemy token-bucket profile: 300 CU/s, ~10s
 * rolling window, up to 3,000 CU burst -- alchemy.com/docs/reference/
 * throughput, confirmed live 2026-08-26. A small safety margin (280, not
 * 300) keeps this app's own pacing a hair under the vendor's exact edge.
 * `cost` is per-call and provided by the caller (most `eth_call`/
 * `eth_getLogs` reads cost more than 1 CU each -- see Alchemy's own
 * pricing table; callers should pass the real documented cost for the
 * specific method, not assume 1). */
export const ALCHEMY_TOKEN_BUCKET_PROFILE = { capacity: 2_800, refillPerSec: 280 };

/** Real, documented per-method Compute Unit costs -- alchemy.com/docs/
 * reference/compute-unit-costs, confirmed live 2026-08-26. Never a guessed
 * flat "1" per call; a caller must name the real method to get the real
 * cost, same discipline as every other provider number in this file. */
export const ALCHEMY_CU_COST: Record<string, number> = {
  eth_call: 26,
  eth_getLogs: 60,
};

/**
 * Atomic, durable, cross-process claim of the next allowed call slot for
 * one pacing key. `GREATEST(existing next-slot, now)` means a caller who
 * finds the key already paced past `now` gets pushed to
 * (that later slot + interval), never allowed to catch up early -- a
 * burst of N simultaneous claimants gets spread N*interval apart, not let
 * through together. Direct successor to opensea-key-pool.ts's
 * claimOpenSeaPaceSlot, generalized to any pacing key/interval.
 */
/**
 * REAL, SEVERE bug found and fixed live 2026-08-26: the original version
 * of this function had no ceiling on how far into the future
 * `next_slot_at_ms` could drift. Under sustained real overload (this
 * app's actual situation with a single OpenSea key serving every chain's
 * opensea-membership + opensea-stats lanes at once, all sharing one
 * account-wide pace key by design), EVERY claim attempt -- successful or
 * not -- advances the shared slot by another full interval via
 * `GREATEST(existing, now) + interval`. With real demand vastly exceeding
 * real capacity, this compounds without bound: a caller from hours ago
 * that never came back to redeem its reserved slot still permanently
 * blocks every future caller behind it. Live-reproduced: this key's
 * `next_slot_at_ms` had drifted to ~382 hours (15.9 DAYS) in the future,
 * permanently denying every real claim regardless of priority -- a
 * demand-priority "live" request for a specific, actively-viewed
 * collection still failed 11 consecutive real attempts over several
 * minutes before this was found.
 *
 * Fix: `next_slot_at_ms` is now hard-capped at `now + maxBacklogMs`
 * (default 10x the interval). Once the real backlog reaches that ceiling,
 * additional claims are denied immediately (fail fast) rather than
 * reserving an ever-more-distant phantom slot -- under sustained
 * overload, excess demand is dropped, not queued forever.
 */
export async function claimProviderPaceSlot(paceKey: string, minIntervalMs: number, maxBacklogMs?: number): Promise<boolean> {
  const nowMs = Date.now();
  const backlogCeilingMs = maxBacklogMs ?? minIntervalMs * 10;
  const result = await postgresQuery<{ claimed_at: string }>(
    `INSERT INTO provider_pace_state (pace_key, next_slot_at_ms, updated_at)
     VALUES ($1, $2::bigint + $3::bigint, now())
     ON CONFLICT (pace_key) DO UPDATE SET
       next_slot_at_ms = LEAST(
         GREATEST(provider_pace_state.next_slot_at_ms, $2::bigint) + $3::bigint,
         $2::bigint + $4::bigint
       ),
       updated_at = now()
     RETURNING (next_slot_at_ms - $3::bigint)::text AS claimed_at`,
    [paceKey, nowMs, minIntervalMs, backlogCeilingMs]
  );
  const claimedAt = Number(result.rows[0]?.claimed_at ?? nowMs);
  return claimedAt <= nowMs;
}

/**
 * Convenience wrapper for a registered profile -- returns `true` (never
 * paced) for any source without a real registered profile, same
 * fail-open-to-existing-circuit-breaker behavior as an unregistered
 * DAILY_CEILING entry in source-budget.ts.
 */
export async function claimRegisteredPaceSlot(source: string): Promise<boolean> {
  const profile = PROVIDER_PACE_PROFILES[source];
  if (!profile) return true;
  return claimProviderPaceSlot(source, profile.minIntervalMs).catch(() => true);
}

/**
 * Token-bucket pacing -- for a provider documented as a rate-OVER-A-WINDOW
 * rather than a flat minimum interval (Alchemy's real "300 CU/s, ~10s
 * rolling window, up to 3,000 CU burst" -- confirmed live 2026-08-26 via
 * alchemy.com/docs/reference/throughput). A flat min-interval pace would
 * misrepresent this: it would either throttle far below the real burst
 * capacity (if paced to the steady-state rate) or let a burst through with
 * no smoothing at all (if not paced at all) -- neither matches the real
 * vendor semantics.
 *
 * Uses a real transaction with `SELECT ... FOR UPDATE` row-level locking,
 * NOT a single UPSERT-with-CTE statement: a first draft tried to do the
 * refill-then-deduct in one INSERT...ON CONFLICT DO UPDATE chained through
 * a CTE, and hit a real, live-reproduced PostgreSQL behavior before it
 * ever shipped -- a data-modifying CTE's freshly INSERTed row is NOT
 * visible to a sibling UPDATE against the same table in the same
 * statement (both operate against the snapshot as of the start of the
 * statement, not each other's writes) -- confirmed live via a direct
 * `UPDATE 0` on the very first claim for a brand-new key. `FOR UPDATE`
 * inside an explicit transaction is the standard, correct pattern for
 * this exact class of problem and avoids that gotcha entirely.
 */
export async function claimTokenBucketSlot(
  paceKey: string,
  capacity: number,
  refillPerSec: number,
  cost: number
): Promise<boolean> {
  return withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO provider_pace_state (pace_key, tokens, last_refill_at, next_slot_at_ms, updated_at)
       VALUES ($1, $2, now(), 0, now())
       ON CONFLICT (pace_key) DO NOTHING`,
      [paceKey, capacity]
    );
    const { rows } = await client.query<{ tokens: string; last_refill_at: string }>(
      `SELECT tokens, last_refill_at FROM provider_pace_state WHERE pace_key = $1 FOR UPDATE`,
      [paceKey]
    );
    const row = rows[0];
    if (!row) return false; // should be unreachable given the INSERT above, fail closed if it ever is
    const elapsedSec = Math.max(0, (Date.now() - new Date(row.last_refill_at).getTime()) / 1000);
    const refilled = Math.min(capacity, Number(row.tokens) + elapsedSec * refillPerSec);
    const allowed = refilled >= cost;
    const newTokens = allowed ? refilled - cost : refilled;
    await client.query(
      `UPDATE provider_pace_state SET tokens = $2, last_refill_at = now(), updated_at = now() WHERE pace_key = $1`,
      [paceKey, newTokens]
    );
    return allowed;
  });
}
