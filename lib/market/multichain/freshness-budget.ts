import { postgresQuery } from "@/lib/postgres";

/**
 * Freshness Budget Controller (FBC).
 *
 * docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md,
 * "Issue 2 -- Graceful degradation under hard free-tier QPS": treat each
 * provider's free-tier rate limit as a *budget*, not a cliff. As spend
 * within the current window rises toward a soft ceiling, effective cache
 * TTL widens automatically (serve stale-but-fresh-enough more often instead
 * of hammering the upstream); past a hard ceiling, refuse new upstream
 * calls entirely for the rest of the window and prefer labeled-stale cache.
 *
 * This module sits ABOVE lib/market/multichain/singleflight-cache.ts, which
 * already does request coalescing + stale-while-revalidate for ONE cache
 * key. FBC tracks spend PER PROVIDER, across every cache key that shares
 * that provider, so a traffic spike against many different keys for the
 * same provider still respects one shared quota.
 *
 * NOT the same thing as (and must not be merged with) the per-key bulk-
 * indexing budget/jail systems in lib/market/multichain/discovery/{helius,
 * alchemy,opensea}-key-pool.ts, control-plane.ts's plank_provider_windows,
 * or source-budget.ts. Those solve key rotation and circuit-breaking for
 * BACKGROUND INDEXING jobs that run for minutes/hours unattended. FBC is a
 * lighter, synchronous check on the LIVE user-facing getOrRefresh() path --
 * it must never hold a Postgres connection across a network fetch
 * (PGPOOL_MAX=4; see singleflight-cache.ts's header), so every function
 * here is a single, fast, independent query.
 *
 * WINDOW: fixed-size, truncated to a boundary (not a sliding/leaky-bucket
 * window) -- simplest correct thing for a single UPDATE-based counter with
 * no held locks. 60 seconds was chosen because every provider's real
 * documented free-tier limit below is itself expressed as a per-second (or
 * per-hour, normalized down) rate, and a 60s bucket keeps the "soft/hard
 * ceiling" numbers in the tens-to-low-hundreds range -- small, easy to
 * reason about, and still coarse enough that clock skew between app
 * instances doesn't matter (worst case: one instance's calls land in the
 * "wrong" 60s bucket, which just means the shared budget is very slightly
 * conservative or permissive for a few seconds, never wrong by more than
 * one window).
 */

const WINDOW_MS = 60_000;

function currentWindowStart(now = Date.now()): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

/**
 * Real, documented free-tier ceilings per provider, verified live against
 * each provider's own current docs on 2026-08-24 (not carried over from any
 * older in-repo comment) -- expressed as calls allowed per WINDOW_MS (60s).
 * See docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-
 * 25.md "Issue 2" for the FBC design this implements, and this session's
 * final report for full citations. Soft ceiling = 80% of hard ceiling
 * (matches the doc's "soft_ceiling -- e.g. 80% of known free RPS*window"
 * sketch) unless a provider-specific reason says otherwise.
 *
 *  - helius:  Free tier DAS/Enhanced APIs = 2 RPS (helius.dev/docs/billing/
 *    rate-limits, re-fetched live 2026-08-24; RPC-only calls are 10 RPS but
 *    this app's Helius traffic through singleflight is DAS/Enhanced, the
 *    tighter of the two groups). 2 RPS * 60s = 120 calls/window hard.
 *  - alchemy: Free tier throughput = 300 CU/s (alchemy.com/docs/reference/
 *    throughput, re-fetched live 2026-08-24: "a Free tier customer with a
 *    300 CU/s limit can consume up to 3,000 CUs over any 10-second
 *    period"). This module counts CALLS, not compute units, and NFT/
 *    metadata-shaped Alchemy calls typically cost roughly 10-30 CU each per
 *    Alchemy's published per-method CU table -- using a conservative 15 CU/
 *    call average keeps this budget from ever being the reason a real 300
 *    CU/s account gets throttled: 300 CU/s * 60s / 15 CU = 1,200 calls/
 *    window hard.
 *  - opensea: Free/default API-key tier = 600 read requests/hour (docs.
 *    opensea.io/reference/api-keys, re-fetched live 2026-08-24: "read":
 *    "600/h"). NOTE -- this is materially lower than the ~5 req/s figure
 *    OPENSEA_STATS_DAILY_ALLOWANCE's comment in opensea-key-pool.ts assumed
 *    (a real discrepancy worth flagging, though out of scope here: that
 *    file's own 150k/day ceiling is already far more conservative than
 *    150,000/day would require and so isn't actually broken by this). 600/
 *    h = 10/min = 10 calls/window hard.
 *  - unisat: Open API free tier = 5 calls/second AND 30,000 calls/month
 *    (docs.unisat.io/developer-support/plans, re-fetched live 2026-08-24).
 *    The per-second figure is the binding one for a 60s live-traffic
 *    window: 5 * 60 = 300 calls/window hard (the monthly 30k cap is a
 *    separate, much coarser constraint already the concern of
 *    UNISAT_BACKGROUND_DAILY_ALLOWANCE in control-plane.ts for indexing;
 *    live reads are a small fraction of that budget).
 *  - ordiscan: Ordiscan does not publish a public numeric rate-limit page
 *    (its docs host returned 403/blocked live fetches on 2026-08-24, both
 *    at /docs and /docs/rate-limits). Absent a verifiable documented
 *    number, this uses a deliberately conservative assumption consistent
 *    with other single-operator Bitcoin-data APIs of similar scale (UniSat
 *    above is the closest verified comparable) rather than inventing a
 *    specific unverified figure: 60 calls/window hard (1 req/s equivalent).
 *    Flagged explicitly as UNVERIFIED so a future pass with real access to
 *    Ordiscan's plan docs (or an account dashboard) can correct it.
 */
export const PROVIDER_BUDGET_DEFAULTS: Record<
  string,
  { softCeiling: number; hardCeiling: number }
> = {
  helius: { softCeiling: 96, hardCeiling: 120 },
  alchemy: { softCeiling: 960, hardCeiling: 1_200 },
  opensea: { softCeiling: 8, hardCeiling: 10 },
  unisat: { softCeiling: 240, hardCeiling: 300 },
  ordiscan: { softCeiling: 48, hardCeiling: 60 }, // UNVERIFIED -- see comment above.
};

// Applies to any provider not in PROVIDER_BUDGET_DEFAULTS (e.g. "magiceden",
// wired into singleflight-cache.ts from app/api/market/multichain/
// collection/route.ts but not one of the five providers this session
// verified live docs for) -- a deliberately conservative generic default
// (1.5 calls/s equivalent) rather than leaving an unlisted provider
// unbudgeted.
const FALLBACK_CEILINGS = { softCeiling: 60, hardCeiling: 90 };

function ceilingsFor(provider: string): { softCeiling: number; hardCeiling: number } {
  return PROVIDER_BUDGET_DEFAULTS[provider] ?? FALLBACK_CEILINGS;
}

type BudgetRow = { calls_used: number; soft_ceiling: number; hard_ceiling: number };

async function readCurrentWindow(provider: string, now: number): Promise<BudgetRow> {
  const windowStart = currentWindowStart(now);
  const { softCeiling, hardCeiling } = ceilingsFor(provider);
  const result = await postgresQuery<BudgetRow>(
    `INSERT INTO plank_provider_budget (provider, window_start, calls_used, soft_ceiling, hard_ceiling)
     VALUES ($1, $2, 0, $3, $4)
     ON CONFLICT (provider, window_start) DO UPDATE
       SET updated_at = plank_provider_budget.updated_at
     RETURNING calls_used, soft_ceiling, hard_ceiling`,
    [provider, windowStart, softCeiling, hardCeiling]
  );
  return result.rows[0];
}

/**
 * Record one real upstream attempt (success or failure -- the doc is
 * explicit: "Increment calls_used only on real upstream attempts"). Single
 * fast UPDATE, never awaited inside a held transaction or alongside the
 * fetch itself -- call this right after the fetcher settles, not before.
 * Best-effort: a failure to record must never surface as a caller-visible
 * error (this is a bookkeeping side-channel, not the source of truth for
 * whether the call happened).
 */
export async function recordProviderCall(provider: string): Promise<void> {
  try {
    const windowStart = currentWindowStart();
    const { softCeiling, hardCeiling } = ceilingsFor(provider);
    await postgresQuery(
      `INSERT INTO plank_provider_budget (provider, window_start, calls_used, soft_ceiling, hard_ceiling)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (provider, window_start) DO UPDATE
         SET calls_used = plank_provider_budget.calls_used + 1,
             updated_at = NOW()`,
      [provider, windowStart, softCeiling, hardCeiling]
    );
  } catch {
    // Never let budget bookkeeping fail a real request -- see this
    // module's header: it's a side-channel, not the source of truth.
  }
}

export type BudgetPressure = {
  callsUsed: number;
  softCeiling: number;
  hardCeiling: number;
  /** calls_used / soft_ceiling, unclamped -- can exceed 1.0 under real pressure. */
  pressure: number;
  exhausted: boolean;
};

/** Read current-window spend and pressure for a provider without incrementing anything. */
export async function readProviderBudget(provider: string): Promise<BudgetPressure> {
  const row = await readCurrentWindow(provider, Date.now());
  const pressure = row.soft_ceiling > 0 ? row.calls_used / row.soft_ceiling : 0;
  return {
    callsUsed: row.calls_used,
    softCeiling: row.soft_ceiling,
    hardCeiling: row.hard_ceiling,
    pressure,
    exhausted: row.calls_used >= row.hard_ceiling,
  };
}

export async function isProviderBudgetExhausted(provider: string): Promise<boolean> {
  try {
    const budget = await readProviderBudget(provider);
    return budget.exhausted;
  } catch {
    // Fail OPEN on a budget-read error, not closed -- an unreachable
    // Postgres row must not itself become the reason a live user-facing
    // read starts refusing upstream calls it would otherwise be entitled
    // to make; singleflight-cache.ts's own "never discard cache on
    // transient failure" discipline already covers real upstream outages.
    return false;
  }
}

/** Widening coefficient from the doc's formula: TTL_eff = TTL_base * (1 + k * p^2). */
const PRESSURE_COEFFICIENT = 3;
/** Cap effective TTL at 4x base by default (matches the doc's k=3 worked example: "at full soft ceiling, TTL ~= 4x base"), separately hard-capped below. */
const MAX_TTL_MULTIPLIER = 4;
/** Absolute ceiling regardless of base TTL or pressure, per the doc: "Cap at a max (e.g. 15-30 min for floors)." */
const ABSOLUTE_MAX_TTL_MS = 30 * 60_000;

/**
 * TTL_eff = TTL_base x (1 + k x pressure^2), pressure clamped to [0, 1] so
 * a provider already past its soft ceiling (pressure > 1) widens no
 * further than the capped-at-hard-ceiling case -- once calls_used reaches
 * hard_ceiling, isProviderBudgetExhausted() takes over and stops upstream
 * calls entirely rather than relying on an ever-growing TTL to do it.
 */
export function widenTtl(baseTtlMs: number, pressure: number): number {
  const clamped = Math.max(0, Math.min(1, pressure));
  const widened = baseTtlMs * (1 + PRESSURE_COEFFICIENT * clamped * clamped);
  return Math.min(widened, baseTtlMs * MAX_TTL_MULTIPLIER, ABSOLUTE_MAX_TTL_MS);
}

/**
 * Pressure-adjusted TTL for a provider's current window. Reads (does not
 * increment) calls_used. On a Postgres error, returns baseTtlMs unchanged
 * (fail open -- same reasoning as isProviderBudgetExhausted).
 */
export async function getEffectiveTtl(provider: string, baseTtlMs: number): Promise<number> {
  try {
    const budget = await readProviderBudget(provider);
    return widenTtl(baseTtlMs, budget.pressure);
  } catch {
    return baseTtlMs;
  }
}
