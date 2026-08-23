/**
 * Generic per-source call budget + circuit breaker for every EXTERNAL
 * data source this app's discovery/stats adapters call (CoinGecko,
 * UniSat, Helius, Magic Eden, and any future source -- Bitquery, dRPC,
 * etc.). Built 2026-08-20 directly in response to a real, already-lived
 * incident this session (Alchemy's own key hit its real monthly capacity
 * limit mid-session) and a security-review critique of a proposed
 * multi-source "swarm" architecture: unbounded parallel fan-out across
 * many paid sources, with no per-source budget or circuit breaker, is a
 * real payment-leak risk, not a hypothetical one.
 *
 * Same lightweight, per-process in-memory pattern lib/market/rpc-meter.ts
 * already uses (not persisted to Postgres -- "per responding worker",
 * same honest scope CONTRIBUTING.md's own rpc-usage docs already state
 * for that file). This module is source-agnostic on purpose: rpc-meter.ts
 * stays Alchemy/CU-specific; this one covers every OTHER external call
 * this app makes for market data.
 *
 * THE THREE REAL RULES THIS ENFORCES (from this session's own hardened
 * design, not invented fresh):
 *   1. Hard daily/monthly call ceilings per source -- when exhausted, the
 *      source is skipped for the rest of the window, never silently
 *      falls through to a paid backup unless the caller explicitly opts
 *      into that.
 *   2. Circuit-breaker "jail": 3 consecutive failures, or ANY detected
 *      quota/rate-limit error, jails that source for a real cool-down
 *      window (default 15 min) -- no retry storms against an already-
 *      failing source.
 *   3. Permanent quarantine for a source is a caller decision (e.g. "this
 *      collection is confirmed dead"), never something this module
 *      infers on its own -- it only tracks call/failure state, not
 *      collection-level liveness.
 */

type SourceState = {
  callsToday: number;
  dayKey: string;
  jailedUntil: number | null;
  consecutiveFailures: number;
};

const g = globalThis as typeof globalThis & { __plankSourceBudget?: Map<string, SourceState> };
const state: Map<string, SourceState> = g.__plankSourceBudget ?? new Map();
g.__plankSourceBudget = state;

/** Real, current, per-source daily ceilings -- conservative, well under each source's own documented free-tier limit (never the limit itself, so a burst never actually trips the provider's own 429 in the first place). Update here as real limits are confirmed live, never guessed. */
const DAILY_CEILING: Record<string, number> = {
  "coingecko-nft": 8_000, // real free Demo plan cap is 10,000/mo -- ~330/day sustainable; this ceiling is a same-day burst guard, not the monthly one
  // "unisat-indexer" (5,000/day) removed 2026-08-23: confirmed by grepping
  // the entire repo for the literal string "unisat-indexer" and for
  // `checkSourceBudget("unisat-indexer"` -- there is no caller anywhere.
  // The three real UniSat collection-indexer/auction callers
  // (unisat-collection-list-scan.ts, unisat-membership-index-runner.ts,
  // unisat-rarity-index-runner.ts, unisat-ordinals-trade.ts) gate through
  // the separate, durable, Postgres-backed reserveProviderCapacity(
  // "unisat:default", ...) mechanism in control-plane.ts instead, not this
  // in-memory module. This was a speculative number from this module's
  // original commit (80aa7c3) that was never wired up -- not a real
  // provider citation, and not gating any real request, so per the same
  // "no self-imposed number without a real reason" rule applied to
  // ordinals-wallet above, it is removed rather than "fixed" with a
  // fabricated citation. checkSourceBudget() falls through to `allowed:
  // true` for any source absent from this map, which is correct here since
  // nothing calls checkSourceBudget with this key anyway.
  // "unisat-collections" (the /v3/market/collection/auction/* collection
  // LIST endpoint backfillUnisatCollectionArt/discoverTopCollections call,
  // see unisat-collections.ts's header) had a self-imposed 400/day entry
  // here with no real provider citation, just "authenticated open-api 403s
  // hard; stay well under" -- the exact "approximated, not documented"
  // pattern already removed for unisat-indexer/helius-das above and
  // ordinals-wallet below. Checked live 2026-08-23: docs.unisat.io's
  // plan/pricing pages are JS-rendered SPAs that return blank/"undefined"
  // rate-limit fields to both WebFetch and a plain curl -- no primary
  // documented per-day number exists to cite. Reproduced the adapter's own
  // "403s hard" claim LIVE instead: a real POST to
  // /v3/market/collection/auction/collection_statistic_list with this
  // repo's real UNISAT_API_KEY returned `HTTP 403 {"code":-2006,"msg":
  // "exceeds rate limit"}` -- a genuine, real-time, provider-enforced
  // rate-limit response, not a guess. unisatFetch() in unisat-collections.ts
  // already detects this exact response (403 or "rate limit" in body) and
  // backs off/retries; mesh-lane.ts's own /429|403|rate limit|quota/i
  // failure handler already calls jailSource(..., true) for a real
  // 20-minute cool-down keyed off this exact live error. That real,
  // reproduced enforcement is the actual safety valve; a made-up 400/day
  // figure on top of it was only gating real discovery growth below the
  // provider's own real capacity (confirmed firing repeatedly in live
  // supervisor logs) without citing anything real. No entry here --
  // checkSourceBudget() falls through to `allowed: true`, same as
  // ordinals-wallet below.
  // "helius-das" had a 20_000/day entry here previously -- REMOVED
  // 2026-08-23 after checking real call sites and Helius's own docs. Two
  // findings, either one alone would justify removal: (1) no call site in
  // this codebase ever calls checkSourceBudget("helius-das") -- grepped
  // clean across lib/market/multichain; the real DAS traffic all goes
  // through helius-key-pool.ts's per-key composite source strings
  // ("helius:key-N" via heliusKeySource()), which is a separate,
  // already-correct gate. (2) Helius's own docs
  // (helius.dev/docs/billing/rate-limits, confirmed live 2026-08-23)
  // define DAS/Enhanced API limits purely as requests-per-second by plan
  // tier (Free 2 RPS, Developer 10 RPS, Business 50 RPS, Professional 100
  // RPS, Enterprise custom) -- there is no documented flat daily request
  // count for any plan, so 20_000/day was never a real provider citation,
  // just a guess. Per EXPLICIT owner direction (same as the
  // ordinals-wallet entries below), no self-imposed ceiling is kept
  // without a real documented limit backing it -- this key is
  // deliberately absent from DAILY_CEILING now.
  // turbo.ordinalswallet.com ("ordinals-wallet" = bitcoin-art-rotator.ts's
  // per-inscription art-lookup lane; "ordinalswallet-ordinals" = the
  // collection/snapshot/rarity adapter lane in ordinalswallet-ordinals.ts,
  // ordinalswallet-collection-scan.ts, ordinalswallet-rarity-index-runner.ts)
  // is fully keyless (no auth header at all) and documents NO rate limit --
  // confirmed live 2026-08-23, not a guess. Per EXPLICIT owner direction,
  // this app never self-imposes a limit/ceiling/pacing delay unless it maps
  // to a REAL, documented provider-side limit -- there is deliberately NO
  // entry for either of these two keys in this map (not even a large
  // placeholder number): checkSourceBudget() falls through to `allowed:
  // true` for any source absent from DAILY_CEILING, which is exactly the
  // "no throttle" behavior wanted here. The circuit breaker (jail on
  // consecutive/quota failures) still applies regardless of ceiling. The
  // durable reserveProviderCapacity/settleProviderCapacity window (a
  // separate mechanism, Postgres-backed) still records real usage in
  // plank_provider_windows for observability, with its own allowance
  // parameter set high enough it never blocks -- see each file's own
  // comment for that number.
  // "magiceden-solana" real call sites (magiceden-solana.ts's discoverTopCollections,
  // hydrate-all-collection-art.ts's hydrateSolanaFromMagicEden) all hit
  // stats-mainnet.magiceden.io/collection_stats/search/all -- a fully
  // keyless, undocumented endpoint. Confirmed live 2026-08-23: this host
  // is NOT part of Magic Eden's documented public API
  // (docs.magiceden.io/v4.0, served from api-mainnet.magiceden.dev, whose
  // documented default is 120 QPM / 2 QPS per help.magiceden.io's own
  // rate-limit article at
  // help.magiceden.io/en/articles/6533403-how-to-use-the-magic-eden-api-access-keys-rate-limits-docs)
  // -- stats-mainnet.magiceden.io is a separate, undocumented public stats
  // host with no published rate limit anywhere. The previous 2,000/day
  // entry here was an unsourced guess (same "approximated, not a real
  // documented limit" pattern already fixed for OpenSea, HyperSync, and
  // Ordinals Wallet this session). Per EXPLICIT owner direction, this app
  // never self-imposes a limit/ceiling/pacing delay unless it maps to a
  // REAL, documented provider-side limit -- there is deliberately NO entry
  // for "magiceden-solana" in this map (same as "ordinals-wallet" above):
  // checkSourceBudget() falls through to `allowed: true` for it. The
  // circuit breaker (jail on 429/403/consecutive failures) still applies
  // regardless. The durable reserveProviderCapacity/settleProviderCapacity
  // window still records real usage for observability, with its own
  // allowance parameter raised to a genuine safety-valve number that never
  // blocks real throughput -- see hydrate-all-collection-art.ts's own
  // comment for that number.
  // Free plan is 1,000 requests/month. 24/day leaves reserve and prevents a
  // restarted supervisor from treating the monthly plan as a daily budget;
  // the durable control plane is the authoritative cross-process ceiling.
  "ordiscan": 24,
};

const DEFAULT_JAIL_MS = 15 * 60_000;
const CONSECUTIVE_FAILURE_JAIL_THRESHOLD = 3;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getState(source: string): SourceState {
  const existing = state.get(source);
  const today = todayKey();
  if (existing && existing.dayKey === today) return existing;
  const fresh: SourceState = { callsToday: 0, dayKey: today, jailedUntil: existing?.jailedUntil ?? null, consecutiveFailures: existing?.consecutiveFailures ?? 0 };
  state.set(source, fresh);
  return fresh;
}

export type SourceGate = { allowed: true } | { allowed: false; reason: "jailed" | "daily-ceiling" };

/**
 * Call BEFORE making a real external request. Never make the request if
 * this returns `allowed: false` -- that's the entire point of a circuit
 * breaker; checking after the fact defeats it.
 */
export function checkSourceBudget(source: string): SourceGate {
  const s = getState(source);
  if (s.jailedUntil != null && Date.now() < s.jailedUntil) {
    return { allowed: false, reason: "jailed" };
  }
  const ceiling = DAILY_CEILING[source];
  if (ceiling != null && s.callsToday >= ceiling) {
    return { allowed: false, reason: "daily-ceiling" };
  }
  return { allowed: true };
}

/** Call after a real request that completed without a quota/rate-limit error, whether or not the DATA itself was a hit (a 200 with "not found" still counts as a successful, budget-relevant call). */
export function recordSourceSuccess(source: string): void {
  const s = getState(source);
  s.callsToday += 1;
  s.consecutiveFailures = 0;
}

/**
 * Call after any failed request. `isQuotaError` should be true for a 429,
 * a "rate limit"/"quota"/"capacity" message, or an HTTP 402/403 that's
 * actually a billing gate -- those jail IMMEDIATELY (one strike), never
 * waiting for the 3-consecutive-failure threshold a generic timeout/500
 * gets, because a quota error means every subsequent call in the same
 * window will fail too and is pure wasted spend.
 */
export function recordSourceFailure(source: string, isQuotaError: boolean, jailMs?: number): void {
  const s = getState(source);
  s.callsToday += 1;
  s.consecutiveFailures += 1;
  if (isQuotaError || s.consecutiveFailures >= CONSECUTIVE_FAILURE_JAIL_THRESHOLD) {
    s.jailedUntil = Date.now() + (jailMs ?? DEFAULT_JAIL_MS);
  }
}

/** Real, current state for one source -- for an admin/coverage view, never for gating logic itself (use checkSourceBudget for that). */
export function readSourceBudget(source: string): { callsToday: number; ceiling: number | null; jailed: boolean; jailedUntil: number | null } {
  const s = getState(source);
  return {
    callsToday: s.callsToday,
    ceiling: DAILY_CEILING[source] ?? null,
    jailed: s.jailedUntil != null && Date.now() < s.jailedUntil,
    jailedUntil: s.jailedUntil,
  };
}

/** Test-only reset -- never called from production code paths. */
export function _resetSourceBudgetForTests(source?: string): void {
  if (source) state.delete(source);
  else state.clear();
}
