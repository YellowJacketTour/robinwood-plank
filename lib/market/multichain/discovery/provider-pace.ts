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
import { postgresQuery } from "@/lib/postgres";

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

/**
 * Atomic, durable, cross-process claim of the next allowed call slot for
 * one pacing key. `GREATEST(existing next-slot, now)` means a caller who
 * finds the key already paced past `now` gets pushed to
 * (that later slot + interval), never allowed to catch up early -- a
 * burst of N simultaneous claimants gets spread N*interval apart, not let
 * through together. Direct successor to opensea-key-pool.ts's
 * claimOpenSeaPaceSlot, generalized to any pacing key/interval.
 */
export async function claimProviderPaceSlot(paceKey: string, minIntervalMs: number): Promise<boolean> {
  const nowMs = Date.now();
  const result = await postgresQuery<{ claimed_at: string }>(
    `INSERT INTO provider_pace_state (pace_key, next_slot_at_ms, updated_at)
     VALUES ($1, $2::bigint + $3::bigint, now())
     ON CONFLICT (pace_key) DO UPDATE SET
       next_slot_at_ms = GREATEST(provider_pace_state.next_slot_at_ms, $2::bigint) + $3::bigint,
       updated_at = now()
     RETURNING (next_slot_at_ms - $3::bigint)::text AS claimed_at`,
    [paceKey, nowMs, minIntervalMs]
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
