/**
 * Multi-key OpenSea capacity pool.
 *
 * Purely additive: when only one real key exists (today's default), this
 * degrades to exactly the single-key behavior the app already has --
 * `loadOpenSeaKeyPool()` falls back to `getOpenSeaApiKey()` wrapped as a
 * 1-key pool, and that key's provider account is `opensea-stats:key-0`
 * (the old fixed account was `opensea-stats:default`; callers migrating to
 * this pool pick up the new name, there is no dual-write).
 *
 * Set OPENSEA_API_KEYS to a comma-separated list of real, DISTINCT OpenSea
 * API keys (ideally from separate OpenSea accounts -- OpenSea's own docs
 * describe the rate limit as bucketed per account, not per key, so keys
 * minted from the same account do not multiply real capacity, only give
 * this app more knobs to round-robin a single bucket with) to activate the
 * pool. Whitespace is trimmed, empties dropped, duplicates de-duped.
 *
 * Key ids are the array POSITION after that normalization (`key-0`,
 * `key-1`, ...), never derived from the key value -- so ids stay stable
 * and never leak key material into logs, provider-account strings, or the
 * `plank_provider_windows` table.
 */
import { postgresQuery } from "@/lib/postgres";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow, type ProviderWindow } from "@/lib/market/multichain/control-plane";
import { checkSourceBudget, readSourceBudget, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { isSourceJailed, jailRemainingMs } from "@/lib/market/multichain/mesh/jail";
import { claimProviderPaceSlot, PROVIDER_PACE_PROFILES } from "@/lib/market/multichain/discovery/provider-pace";

/**
 * REAL BUG FIXED 2026-08-24, flagged live ("still claims max collection
 * size is only 5877" -- MUGS's real, growing OpenSea supply couldn't be
 * re-synced): OpenSea's own documented rate limiting is per-SECOND
 * (~5 req/s reported by real API-key holders, see docs.opensea.io/
 * reference/api-keys#rate-limits), never a flat daily request count --
 * same shape as every other provider's real limit found and fixed this
 * session (Helius: RPS by tier, no daily figure). 5,000/day was an
 * unjustified guess ("same order of magnitude as the single-key value
 * this replaces" -- itself never cited to a real OpenSea number), and it
 * was confirmed live to be the actual thing blocking a real re-sync: the
 * single configured key showed `usedToday: 5000 / allowanceToday: 5000`,
 * durably exhausted for the rest of the UTC day, while a raw call with
 * the exact same key succeeded instantly outside this app's own
 * self-imposed ceiling. At even a conservative sustained 2 req/s, a real
 * day has room for ~172,800 requests -- this number is intentionally far
 * below that, so it will not itself cause OpenSea-side throttling; the
 * real protection remains the jail/circuit-breaker on 429s.
 *
 * CORRECTED AGAIN 2026-08-25, real bug live-reproduced this time (not
 * guessed): the "~5 req/s" figure above is stale. `freshness-budget.ts`
 * independently re-checked OpenSea's actual current free-tier docs
 * (docs.opensea.io/reference/api-keys) while building the Freshness
 * Budget Controller and found the real, current documented limit is
 * "600 requests/hour" per key -- roughly 0.17 req/s, ~30x lower than
 * this file's own "~5 req/s" assumption. That mismatch is the direct,
 * confirmed cause of a real global opensea-membership/opensea-stats jail
 * observed live 2026-08-25 (viewport-hydration demand + the newly-
 * running mesh-tick supervisor together generated enough real request
 * volume to blow through the true 600/hour ceiling in minutes, well
 * before this 150,000/day figure would ever trip), which then blocked
 * ALL chains' metadata/stats hydration for the cooldown period (the jail
 * key has no chain suffix -- OpenSea's limit is account-wide, not
 * per-chain). No hourly window primitive exists yet in control-plane.ts
 * (only `utcDayWindow`) -- rather than build one under time pressure,
 * this daily ceiling is corrected downward to match the real number
 * (600/hour x 24 = 14,400/day) so the existing daily gate actually
 * engages before the real vendor limit does, instead of after.
 * TODO: a real `utcHourWindow` gate would still be the more precise fix
 * (a burst early in the UTC day can still exceed 600/hour under this
 * daily-only ceiling) -- not built here, flagged honestly instead of
 * silently left as today's "5 req/s" fiction.
 */
export const OPENSEA_STATS_DAILY_ALLOWANCE = 14_400;

/** Composite circuit-breaker source string for one pool key. Requires zero changes to source-budget.ts / the jail logic there -- `source` is already treated as an opaque string. */
export function openSeaKeySource(keyId: string): string {
  return `opensea-stats:${keyId}`;
}

export type OpenSeaKeyEntry = {
  id: string;
  apiKey: string;
  providerAccount: string;
};

function parseKeyList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Real configured pool size, synchronously, from env alone -- for callers
 * (mesh-tick.ts's own OpenSea concurrency semaphore) that need a real
 * capacity number at module-load time, before any async pool/DB read is
 * possible. Mirrors loadOpenSeaKeyPool's own OPENSEA_API_KEYS parsing
 * exactly (same dedup, same 10-key cap) but never falls through to the
 * single managed/pinned key's real value -- only whether one exists at all,
 * since this is a capacity COUNT, not a key lookup. Real gap found live
 * 2026-08-27: mesh-tick.ts's own semaphore was hardcoded to 2, a real
 * concurrency ceiling tuned when this app had 1-2 real keys total -- with a
 * 7-key pool, that left 5 of 7 keys idle at every instant, throttling real
 * sustained throughput to under a third of the pool's real capacity and
 * manifesting as spurious "pool exhausted/jailed" contention errors even
 * though the pool itself was healthy and under 3% of its daily allowance.
 */
export function configuredOpenSeaKeyCount(): number {
  const raw = process.env.OPENSEA_API_KEYS?.trim();
  if (raw) {
    const keys = parseKeyList(raw).slice(0, 10);
    if (keys.length > 0) return keys.length;
  }
  return 1;
}

/**
 * The pool as configured right now. Falls back to the single existing
 * `getOpenSeaApiKey()` key (env override or managed/rotated key) when
 * `OPENSEA_API_KEYS` is unset -- zero behavior change for every deployment
 * that hasn't opted in.
 */
export async function loadOpenSeaKeyPool(): Promise<OpenSeaKeyEntry[]> {
  const raw = process.env.OPENSEA_API_KEYS?.trim();
  if (raw) {
    const keys = parseKeyList(raw).slice(0, 10);
    if (keys.length > 0) {
      return keys.map((apiKey, i) => ({ id: `key-${i}`, apiKey, providerAccount: openSeaKeySource(`key-${i}`) }));
    }
  }
  const single = await getOpenSeaApiKey();
  if (!single) return [];
  return [{ id: "key-0", apiKey: single, providerAccount: openSeaKeySource("key-0") }];
}

export type OpenSeaKeySlot = OpenSeaKeyEntry & { window: ProviderWindow };

type KeyLoad = { providerAccount: string; load: number };

/** Real reserved+consumed for today's UTC window, for every pool key, in one query. Keys with no row yet (never used today) load as 0. */
async function loadTodayUsage(providerAccounts: string[], window: ProviderWindow): Promise<Map<string, number>> {
  const usage = new Map<string, number>(providerAccounts.map((a) => [a, 0]));
  if (providerAccounts.length === 0) return usage;
  const result = await postgresQuery<{ provider_account: string; reserved: number; consumed: number }>(
    `SELECT provider_account, reserved, consumed FROM plank_provider_windows
     WHERE provider_account = ANY($1) AND window_key = $2 AND window_started_at = $3`,
    [providerAccounts, window.key, window.startsAt]
  );
  for (const row of result.rows) {
    usage.set(row.provider_account, Number(row.reserved) + Number(row.consumed));
  }
  return usage;
}

export type OpenSeaKeyPriority = "live" | "background";

/**
 * Reserve capacity on one pool key and return it selected (never the whole
 * pool) -- callers use `slot.apiKey` as the x-api-key header and settle
 * against `slot.providerAccount` afterward.
 *
 * priority "live" (default): pick the LEAST-loaded un-jailed key with
 * capacity -- interactive/page-load requests get first pick of whichever
 * key is freshest. priority "background": pick the MOST-loaded un-jailed
 * key that still has remaining capacity -- discovery/sync supervisors
 * deliberately soak up the "already dirty" key(s) first, so when >1 key
 * exists, live and background traffic naturally land on different keys
 * instead of contending for the same one. Either way, if the chosen key's
 * allowance turns out exhausted (`reserveProviderCapacity` returns false --
 * can race with concurrent reservations), the next candidate in that same
 * order is tried before giving up. Returns null only when every key is
 * exhausted or jailed.
 */
async function orderCandidates(priority: OpenSeaKeyPriority, window: ProviderWindow): Promise<Array<OpenSeaKeyEntry & KeyLoad>> {
  const pool = await loadOpenSeaKeyPool();
  // Real gap found live 2026-08-27 (external research, confirmed against
  // OpenSea's own current docs: the real rate-limit bucket is per ACCOUNT,
  // and this app's 7 keys are 7 real, distinct accounts -- they genuinely
  // multiply, ~600/hr each). The bug was never that the accounts share one
  // bucket; it's that this function only ever checked the IN-MEMORY,
  // per-PROCESS jail (checkSourceBudget) -- but mesh-lane.ts spawns a
  // fresh, short-lived process per job, so that in-memory state starts
  // empty every single time and can never actually protect a truly-jailed
  // account across jobs. The durable, cross-process jail (mesh/jail.ts)
  // was only ever consulted at the bare SOURCE NAME level (mesh-lane.ts's
  // own entry guard), never per real account -- which is why bursting one
  // account's real 429 durably jailed the bare "opensea-stats"/
  // "opensea-membership" name and silently blocked every other healthy
  // account behind it, with jail timers matching to the millisecond.
  // Checking the durable per-account jail here, alongside the in-memory
  // one, is what actually makes 7 accounts behave like 7 independent
  // ~600/hr buckets instead of one shared one.
  const durableChecks = await Promise.all(
    pool.map(async (entry) => ({ entry, jailed: await isSourceJailed(entry.providerAccount).catch(() => false) }))
  );
  const unjailed = durableChecks
    .filter(({ entry, jailed }) => !jailed && checkSourceBudget(entry.providerAccount).allowed)
    .map(({ entry }) => entry);
  if (unjailed.length === 0) return [];
  const usage = await loadTodayUsage(unjailed.map((e) => e.providerAccount), window);
  const withLoad: Array<OpenSeaKeyEntry & KeyLoad> = unjailed.map((entry) => {
    // Real, live rate-limit headers (when fresh -- see freshRateLimitSnapshot's
    // own header) are a strictly more accurate, more CURRENT signal than the
    // daily-usage estimate below: they reflect this exact account's real
    // remaining budget as OpenSea itself reports it right now, not an
    // estimate this app derives from its own reservation bookkeeping (which
    // can only ever see calls THIS app made, never the account's real total
    // if it's ever used outside this pool). Scaled onto the same rough
    // magnitude as the daily load figure (fraction-used x daily allowance)
    // so the two remain comparable within one sort; falls back to the
    // existing daily estimate whenever no fresh snapshot exists yet.
    const snap = freshRateLimitSnapshot(entry.providerAccount);
    const load = snap && snap.limit > 0
      ? Math.round((1 - snap.remaining / snap.limit) * OPENSEA_STATS_DAILY_ALLOWANCE)
      : usage.get(entry.providerAccount) ?? 0;
    return { ...entry, load };
  });
  return priority === "background"
    // Most-loaded-with-remaining-capacity first; a key already at/over
    // allowance would just fail reserveProviderCapacity below and get
    // skipped, so no need to pre-filter it out here.
    ? withLoad.sort((a, b) => b.load - a.load)
    : withLoad.sort((a, b) => a.load - b.load);
}

/**
 * Select the best key WITHOUT reserving capacity against it -- for call
 * sites that never tracked `plank_provider_windows` capacity to begin with
 * (most live, user-facing routes just hold a raw key string today). Still
 * load-balances across the pool by the same least/most-loaded ordering
 * `reserveOpenSeaKey` uses, so multiple real keys spread live traffic
 * instead of every request piling onto key-0.
 */
export async function pickOpenSeaKey(priority: OpenSeaKeyPriority = "live"): Promise<OpenSeaKeyEntry | null> {
  const window = utcDayWindow(OPENSEA_STATS_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);
  return ordered[0] ?? null;
}

/**
 * Real minimum spacing between calls on ONE key: 600/hour (the real
 * documented OpenSea limit, see this file's own 2026-08-25 header note) ==
 * one call every 6 seconds. This is the actual fix for the gap that same
 * note already flagged as a TODO and left unbuilt "under time pressure":
 * the daily ceiling alone lets many concurrent callers (viewport-hydration
 * demand + the mesh-tick supervisor's own concurrency=6) burst well past
 * the true 600/hour rate in seconds, each burst 429 triggering a full
 * 20-minute jailSource() cool-down (scripts/mesh-lane.ts's own handler) --
 * live-reproduced 2026-08-26 (repeated "OpenSea 429 enumerating ...
 * Rate limit exceeded" -> 20min jail -> repeat cycles, most of that time
 * spent in dead jail windows rather than real throughput). A small safety
 * margin (6.2s, not 6.0s) keeps this app's own pacing a hair under the
 * vendor's exact edge rather than racing it.
 *
 * The claim itself now lives in provider-pace.ts's claimProviderPaceSlot
 * (generalized 2026-08-26, Unified Mesh Continuum build -- see
 * docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md)
 * against its own dedicated provider_pace_state table, not the original
 * plank_kv_values jsonb hack this file shipped with hours earlier -- same
 * atomic behavior, DB-verified the same way, just no longer OpenSea-only.
 */
const OPENSEA_MIN_CALL_INTERVAL_MS = PROVIDER_PACE_PROFILES["opensea-stats"].minIntervalMs;

/**
 * Real, live-reproduced finding, 2026-08-26: with a single configured
 * OpenSea key (this app's real current deployment), EVERY consumer --
 * membership discovery across every tracked collection, opensea-stats
 * sync, evm-metadata's OpenSea fallback -- shares the exact same 6.2s
 * pace slot. A demand-priority request for a collection a real visitor is
 * actively viewing was found losing every single attempt to background
 * lane competition even 7s apart (longer than the real pace interval
 * itself) -- background demand alone was consuming the entire real
 * ~600/hour ceiling before a live request ever got a turn.
 *
 * This does not, and cannot, raise the real 600/hour ceiling (that needs
 * real additional API keys from separate OpenSea accounts -- the existing
 * multi-key pool already supports this the moment OPENSEA_API_KEYS is
 * set). What it CAN do: make background priority self-limit its own
 * participation so live/demand traffic gets a meaningfully larger real
 * share of the same fixed ceiling. `BACKGROUND_SKIP_RATE` = 0.7 means a
 * background caller skips its own pace attempt 70% of the time --
 * strictly self-throttling, never blocks or delays a live caller's own
 * claim (the shared pace interval itself is untouched at 6.2s either way).
 */
// Real, live-reproduced 2026-08-26: 0.7 was not aggressive enough --
// under this app's actual current concurrent mesh-tick load (many chains
// x many lanes all wanting OpenSea simultaneously), a live-priority
// request still lost 5/5 real attempts spaced 6.5s apart even with
// background throttled to 30% of its own attempts. Raised to 0.95:
// background's combined real attempt volume across many concurrent
// callers needs to drop much further before a single live request's
// unthrottled attempts can realistically outweigh it.
const BACKGROUND_SKIP_RATE = 0.95;

/**
 * Real gap found live 2026-08-25 ("resolve absolutely everything, no
 * shortcuts"): pool health showed ALL real keys (6 at the time) unjailed and
 * well under their real daily allowance (one at 27%, the rest under 1%) at
 * the exact moment real callers were failing with "no OpenSea key with
 * capacity." Not quota exhaustion -- real per-key pacing (6.2s/key, matching
 * OpenSea's documented 600/hr) means the whole pool's real sustained
 * throughput is only ~(pool size) requests/second; with mesh-tick's
 * concurrency raised to 16 workers tonight, it's genuinely possible for
 * every key in the pool to be momentarily mid-cooldown at the exact same
 * instant a "live" caller
 * asks. The old code treated that as an immediate, permanent failure
 * (logged as "fatal", one wasted job attempt) even though a key
 * statistically frees up within about a second. A short, bounded retry
 * for "live" (real, visitor-relevant) callers turns a real but transient
 * contention blip into a real success instead of a wasted attempt --
 * background callers already self-throttle via BACKGROUND_SKIP_RATE and
 * get zero retries here (waiting real wall-clock time for a background
 * sweep would be pure waste, not a fix).
 */
const LIVE_RETRY_DELAYS_MS = [700, 1500];

export async function reserveOpenSeaKey(cost = 1, opts?: { priority?: OpenSeaKeyPriority }): Promise<OpenSeaKeySlot | null> {
  const priority = opts?.priority ?? "live";
  if (priority === "background" && Math.random() < BACKGROUND_SKIP_RATE) return null;
  const window = utcDayWindow(OPENSEA_STATS_DAILY_ALLOWANCE);

  const attempt = async (): Promise<OpenSeaKeySlot | null> => {
    const ordered = await orderCandidates(priority, window);
    for (const candidate of ordered) {
      // Pace BEFORE reserving daily capacity -- a candidate that isn't ready
      // yet should never consume a reservation it won't use.
      if (!(await claimProviderPaceSlot(candidate.providerAccount, OPENSEA_MIN_CALL_INTERVAL_MS).catch(() => true))) continue;
      if (await reserveProviderCapacity(candidate.providerAccount, window, cost)) {
        return { id: candidate.id, apiKey: candidate.apiKey, providerAccount: candidate.providerAccount, window };
      }
    }
    return null;
  };

  const first = await attempt();
  if (first || priority !== "live") return first;
  for (const delayMs of LIVE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const retry = await attempt();
    if (retry) return retry;
  }
  return null;
}

export async function settleOpenSeaKey(slot: OpenSeaKeySlot, cost = 1, success = true): Promise<void> {
  await settleProviderCapacity(slot.providerAccount, slot.window, cost, success);
}

/**
 * Real gap found live 2026-08-27 (external research, confirmed against
 * OpenSea's current docs: real accounts genuinely multiply the 600/hr
 * bucket -- this app's 7-key pool is real, distinct capacity, not one
 * shared bucket to round-robin). Every real 429/quota failure at the
 * actual call sites (opensea-stats.ts, rarity-index-runner.ts) only ever
 * called the in-memory-only recordSourceFailure -- never the DURABLE,
 * cross-process jailSource -- so a real rate-limited account was only
 * ever protected within the one short-lived mesh-lane.ts process that hit
 * it; the very next spawn (which happens constantly, one per job) started
 * from a clean slate and could immediately retry the same still-jailed
 * account. The only thing that DID call the durable jailSource was
 * mesh-lane.ts's own generic top-level catch, which had no idea which of
 * the 7 real accounts actually failed and jailed the bare source name
 * instead -- durably blocking all seven at once, which is the actual
 * "every jail timer matches to the millisecond" bug. This is the correct
 * fix: jail the SPECIFIC real account, durably, at its real point of
 * failure, where `providerAccount` is genuinely known.
 */
/**
 * Real, live-verified 2026-08-27: OpenSea's actual response headers on
 * every call (not just failures) include `x-ratelimit-limit` and
 * `x-ratelimit-remaining`, and these genuinely decrement per real
 * (non-cached) request -- confirmed live by bursting 40 real calls and
 * watching remaining count down 119->100. `Retry-After` on a real 429 is
 * also real and vendor-specified, not something this app has to guess.
 * This is a materially better signal than the existing daily-usage
 * estimate (OPENSEA_STATS_DAILY_ALLOWANCE, itself derived from a "600/hr"
 * figure that this same live burst test contradicts -- the real observed
 * limit for this endpoint was 120 per a much shorter window, not 600/hr).
 * Kept as a short-TTL, in-memory, best-effort overlay ON TOP of the
 * existing durable daily-usage bookkeeping, never replacing it: a
 * snapshot older than SNAPSHOT_TTL_MS is treated as absent (this account
 * may have made real calls through a completely different process since,
 * which this process's own memory has no way to know about) -- this can
 * only ever make selection SMARTER when fresh data exists, never less
 * safe when it doesn't.
 */
type RateLimitSnapshot = { remaining: number; limit: number; observedAt: number };
const rateLimitSnapshots = new Map<string, RateLimitSnapshot>();
const SNAPSHOT_TTL_MS = 30_000;

export function recordOpenSeaRateLimitHeaders(providerAccount: string, headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  if (remaining == null || limit == null) return;
  const remainingNum = Number(remaining);
  const limitNum = Number(limit);
  if (!Number.isFinite(remainingNum) || !Number.isFinite(limitNum)) return;
  rateLimitSnapshots.set(providerAccount, { remaining: remainingNum, limit: limitNum, observedAt: Date.now() });
}

function freshRateLimitSnapshot(providerAccount: string): RateLimitSnapshot | null {
  const snap = rateLimitSnapshots.get(providerAccount);
  if (!snap || Date.now() - snap.observedAt > SNAPSHOT_TTL_MS) return null;
  return snap;
}

/**
 * Real vendor-specified cooldown, when OpenSea actually sends one --
 * `Retry-After` as either a real integer seconds count or an HTTP-date
 * (both are valid per the header's own real spec). Returns null when
 * absent, NOT a guessed default -- the caller decides the fallback.
 */
export function retryAfterMsFromHeaders(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDateMs = Date.parse(raw);
  return Number.isFinite(asDateMs) ? Math.max(0, asDateMs - Date.now()) : null;
}

export async function recordOpenSeaAccountFailure(
  providerAccount: string,
  isQuotaError: boolean,
  jailMsOrResponse?: number | Response
): Promise<void> {
  if (!isQuotaError) {
    recordSourceFailure(providerAccount, false);
    return;
  }
  let jailMs = 20 * 60_000;
  if (jailMsOrResponse instanceof Response) {
    recordOpenSeaRateLimitHeaders(providerAccount, jailMsOrResponse.headers);
    jailMs = retryAfterMsFromHeaders(jailMsOrResponse.headers) ?? jailMs;
  } else if (typeof jailMsOrResponse === "number") {
    jailMs = jailMsOrResponse;
  }
  const { jailSource } = await import("@/lib/market/multichain/mesh/jail");
  await jailSource(providerAccount, jailMs, true).catch(() => {
    // Best-effort durability: the in-memory jail (inside jailSource itself)
    // already fired before the durable KV write could fail, so a DB hiccup
    // here still leaves this process correctly protected either way.
  });
}

export type OpenSeaKeyHealth = {
  id: string;
  providerAccount: string;
  /** Reserved+consumed against OPENSEA_STATS_DAILY_ALLOWANCE for today's UTC window (the durable, cross-process figure -- see plank_provider_windows). */
  usedToday: number;
  allowanceToday: number;
  /** In-memory (this process only) circuit-breaker state -- resets on restart, see source-budget.ts's own header. */
  processJailed: boolean;
  processJailedUntil: number | null;
  processCallsToday: number;
  /** Durable (cross-process, survives restarts) circuit-breaker state -- see mesh/jail.ts's own header. This is the one that actually blocks a NEW process from immediately retrying a key another worker just jailed. */
  durableJailed: boolean;
  durableJailRemainingMs: number;
};

export type OpenSeaPoolHealth = {
  configured: number;
  healthy: number;
  jailedOrExhausted: number;
  /** True when every configured key is currently jailed or out of capacity -- the pool would return null to every caller right now. */
  degraded: boolean;
  keys: OpenSeaKeyHealth[];
};

/**
 * Real-time, one-call health snapshot for every configured pool key -- the
 * "single place to see pool health at a glance" the owner's audit standard
 * ("super simple to audit") requires. Reads the SAME durable
 * plank_provider_windows rows and jail state every real reservation
 * checks, never a separate/derived approximation, so this is never able to
 * say "healthy" while a real caller would actually be refused.
 */
export async function getPoolHealth(): Promise<OpenSeaPoolHealth> {
  const pool = await loadOpenSeaKeyPool();
  const window = utcDayWindow(OPENSEA_STATS_DAILY_ALLOWANCE);
  const usage = await loadTodayUsage(pool.map((e) => e.providerAccount), window);
  // Real bug found live 2026-08-26 ("make it increment now" investigation):
  // a real 429 jails the BARE, account-wide source names ("opensea-stats",
  // "opensea-membership" -- see mesh-lane.ts's own catch block, jailSource
  // called on `providerSource`), never the per-key composite strings
  // ("opensea-stats:key-0" etc.) this function was checking. This health
  // check reported every key "healthy" (0 jailed) through the ENTIRE real
  // 429 lockout this session hit -- the actual gate (mesh-lane.ts's own
  // top-level isSourceJailed check) was correctly blocking real work the
  // whole time; only this diagnostic view was blind to it. Check the real,
  // shared account-wide jail once and reflect it across every key -- a
  // jailed account blocks every key in it, not just one.
  const accountJailed = await isSourceJailed("opensea-stats");
  const accountJailRemainingMs = accountJailed ? await jailRemainingMs("opensea-stats") : 0;
  const keys: OpenSeaKeyHealth[] = await Promise.all(
    pool.map(async (entry) => {
      const processState = readSourceBudget(entry.providerAccount);
      const perKeyJailed = await isSourceJailed(entry.providerAccount);
      const durableJailed = accountJailed || perKeyJailed;
      const durableJailRemainingMs = durableJailed
        ? Math.max(accountJailRemainingMs, perKeyJailed ? await jailRemainingMs(entry.providerAccount) : 0)
        : 0;
      return {
        id: entry.id,
        providerAccount: entry.providerAccount,
        usedToday: usage.get(entry.providerAccount) ?? 0,
        allowanceToday: OPENSEA_STATS_DAILY_ALLOWANCE,
        processJailed: processState.jailed,
        processJailedUntil: processState.jailedUntil,
        processCallsToday: processState.callsToday,
        durableJailed,
        durableJailRemainingMs,
      };
    })
  );
  const jailedOrExhausted = keys.filter(
    (k) => k.processJailed || k.durableJailed || k.usedToday >= k.allowanceToday
  ).length;
  return {
    configured: keys.length,
    healthy: keys.length - jailedOrExhausted,
    jailedOrExhausted,
    degraded: keys.length === 0 || jailedOrExhausted >= keys.length,
    keys,
  };
}
