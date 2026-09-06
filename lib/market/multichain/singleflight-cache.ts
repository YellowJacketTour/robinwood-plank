import { durableKv } from "@/lib/market/durable-kv";
import { postgresQuery } from "@/lib/postgres";
import {
  getEffectiveTtl,
  isProviderBudgetExhausted,
  recordProviderCall,
} from "@/lib/market/multichain/freshness-budget";

/**
 * Request-coalescing / stale-while-revalidate wrapper around durableKv, for
 * live user-facing routes that call a rate-limited third-party API (Magic
 * Eden, Helius, UniSat, etc.) on every request with no cache at all today
 * -- e.g. app/api/market/multichain/collection/route.ts's Magic Eden stats
 * fetch. Built 2026-08-25 as the concrete answer to two things asked
 * together: the alpha-readiness audit's HIGH finding that rate-limit
 * assumptions are built for a single dev, not concurrent public traffic;
 * and a request for the real distributed-systems theory behind making N
 * concurrent visitors cost close to what 1 costs.
 *
 * The mechanism is not novel -- it's a direct, minimal implementation of
 * two well-established patterns:
 *
 *   1. Singleflight / request coalescing (Facebook's memcache "leases",
 *      Nishtala et al., NSDI 2013; Go's golang.org/x/sync/singleflight):
 *      concurrent callers sharing a cache key collapse into ONE upstream
 *      fetch. Handled here at two layers -- an in-memory per-process
 *      Map<key, Promise> for same-process concurrency, and a Postgres
 *      advisory lock (pg_try_advisory_lock) for cross-process/cross-
 *      instance concurrency, since this app already runs Postgres and
 *      doesn't need a second coordination system (Redis) for it.
 *
 *   2. Stale-while-revalidate (RFC 5861): a soft TTL and a hard TTL.
 *      Within the soft TTL, serve the cached value with zero upstream
 *      call. Between soft and hard TTL, serve the (still fresh enough)
 *      cached value immediately and kick a background refresh gated by
 *      the lock above. Only past the hard TTL does a request actually
 *      wait on a fresh fetch.
 *
 * Lease mechanism: a conditional UPDATE (claim only succeeds if no other
 * process's lease is currently live), not a Postgres session-scoped
 * advisory lock. Deliberate choice: this app's pool is small
 * (PGPOOL_MAX=4 in .env.inmotion.example) and a fetcher call can take up
 * to several seconds (network-bound third-party API); holding a live
 * advisory lock means holding a live pooled connection for that whole
 * span (pg_advisory_unlock only reliably pairs with the SAME connection
 * that acquired it, so it would also need withPostgresTransaction to pin
 * one). A lease row read/write instead is two quick, independent
 * postgresQuery calls that never hold a connection open across the fetch.
 *
 * Split-brain caveat (deliberately accepted, same reasoning Kleppmann's
 * Redlock critique doesn't apply to): a lease can theoretically be claimed
 * by two processes if one's fetch outlives the lease TTL. The worst case
 * is "one extra upstream call," not a correctness bug -- this isn't
 * protecting a write to a bank balance, it's coalescing reads of a public
 * price/floor value.
 *
 * FRESHNESS BUDGET CONTROLLER (added 2026-08-25, docs/marketplank/GROK-
 * FINDINGS-biggest-issues-unified-vision-2026-08-25.md "Issue 2"): an
 * OPTIONAL layer above everything described so far. Pass `provider` in
 * SingleflightCacheOptions to additionally gate refreshes on that
 * provider's shared, cross-key call budget (lib/market/multichain/
 * freshness-budget.ts) -- widening soft/hard TTL as spend approaches a
 * soft ceiling, and refusing new upstream calls once a hard ceiling is
 * hit (serving stale cache labeled "stale_budget", or failing closed only
 * if no cache exists at all). This never changes behavior for callers that
 * omit `provider` -- everything above (coalescing, lease, SWR, "never
 * discard cache on transient failure") is unmodified in that case.
 */

const inFlight = new Map<string, Promise<unknown>>();
const LEASE_MS = 15_000; // generous vs. the 10s fetch timeout used by callers

// Real production bug found live 2026-09-06 ("still no global"): this
// predicate used `(value)::bigint`, a direct jsonb->bigint cast that the
// production PostgreSQL major rejects ("cannot cast type jsonb to bigint"),
// so EVERY getOrRefresh on production threw here -- hidden for weeks by the
// callers' `.catch(() => null)`, exposed the moment the hub index went
// through the edge. `#>> '{}'` extracts the scalar as text on every
// supported major (json and jsonb alike) before the cast.
async function tryAcquireRefreshLease(key: string): Promise<boolean> {
  const leaseKey = `${key}:lease`;
  const now = Date.now();
  const result = await postgresQuery<{ claimed: boolean }>(
    `INSERT INTO plank_kv_values (key_name, value, expires_at, updated_at)
     VALUES ($1, to_jsonb($2::bigint), NULL, NOW())
     ON CONFLICT (key_name) DO UPDATE
       SET value = to_jsonb($2::bigint), updated_at = NOW()
       WHERE (plank_kv_values.value #>> '{}')::bigint < $3::bigint
     RETURNING TRUE AS claimed`,
    [leaseKey, now + LEASE_MS, now]
  );
  return result.rows.length > 0;
}

type CachedEnvelope<T> = { value: T; cachedAt: number };

export type CacheFreshness = "live" | "cached" | "stale_budget";

export type EnvelopeResult<T> = {
  value: T;
  /**
   * "live" -- this call actually hit the upstream fetcher just now.
   * "cached" -- served from cache within normal soft/hard TTL rules.
   * "stale_budget" -- the Freshness Budget Controller's hard ceiling was
   * hit for this provider, so a cached value (possibly past its own hard
   * TTL) was served instead of attempting another upstream call. See
   * lib/market/multichain/freshness-budget.ts.
   */
  freshness: CacheFreshness;
  /** Age of the served value in ms, or null for a fresh "live" fetch. */
  ageMs: number | null;
};

export type SingleflightCacheOptions = {
  /** Serve straight from cache with zero upstream call inside this window. */
  softTtlMs: number;
  /** Past this window, a request blocks on a fresh fetch instead of serving stale. */
  hardTtlMs: number;
  /**
   * Optional Freshness Budget Controller provider name (e.g. "helius",
   * "alchemy", "opensea", "unisat", "ordiscan" -- see
   * PROVIDER_BUDGET_DEFAULTS in freshness-budget.ts). When set: (1) both
   * TTLs are widened based on that provider's current-window pressure
   * before any cache-age comparison, and (2) if the provider's hard
   * ceiling has been hit, no new upstream call is attempted at all --
   * cache is served (however stale) labeled "stale_budget", or the call
   * fails closed with a `provider_budget_exhausted` error if there is
   * truly no cache. Omitting this preserves the exact prior behavior
   * (plain soft/hard TTL, no budget involvement) for any caller not yet
   * migrated.
   */
  provider?: string;
};

/**
 * Get-or-refresh a durable-KV-backed value with request coalescing and
 * stale-while-revalidate semantics.
 *
 * `key` should be a normalized cache key (e.g. `magiceden-stats:solana-
 * mainnet:mad-lads`) -- see this file's own header on why key
 * normalization matters (irrelevant request variance in the key defeats
 * coalescing entirely).
 */
export async function getOrRefresh<T>(
  key: string,
  options: SingleflightCacheOptions,
  fetcher: () => Promise<T>
): Promise<T> {
  const result = await getOrRefreshWithMeta(key, options, fetcher);
  return result.value;
}

/**
 * Same as getOrRefresh, but returns the full freshness envelope instead of
 * just the value -- for call sites that want to surface `as_of` /
 * `freshness` to the UI per the FBC doc's "UI contract" (every market
 * number carries `as_of` + optional `freshness: live | cached |
 * stale_budget`).
 */
export async function getOrRefreshWithMeta<T>(
  key: string,
  options: SingleflightCacheOptions,
  fetcher: () => Promise<T>
): Promise<EnvelopeResult<T>> {
  const cacheKey = `plank:singleflight:${key}`;
  const now = Date.now();
  const cached = await durableKv.get<CachedEnvelope<T>>(cacheKey);

  const provider = options.provider;
  const softTtlMs = provider ? await getEffectiveTtl(provider, options.softTtlMs) : options.softTtlMs;
  const hardTtlMs = provider ? await getEffectiveTtl(provider, options.hardTtlMs) : options.hardTtlMs;

  if (cached && now - cached.cachedAt < softTtlMs) {
    return { value: cached.value, freshness: "cached", ageMs: now - cached.cachedAt };
  }

  // Freshness Budget Controller hard-ceiling check: only ever gates whether
  // a NEW upstream call is attempted -- it never discards or refuses to
  // serve a cache that already exists (same "never discard cache on
  // transient failure" discipline this file already follows for real
  // upstream errors, just triggered by budget exhaustion instead).
  if (provider && (await isProviderBudgetExhausted(provider))) {
    if (cached) {
      return { value: cached.value, freshness: "stale_budget", ageMs: now - cached.cachedAt };
    }
    throw new Error(
      `provider_budget_exhausted: ${provider} has hit its Freshness Budget Controller hard ceiling and no cached value exists for "${key}"`
    );
  }

  async function runFetcherAndRecord(): Promise<T> {
    try {
      const value = await fetcher();
      if (provider) void recordProviderCall(provider);
      return value;
    } catch (error) {
      if (provider) void recordProviderCall(provider);
      throw error;
    }
  }

  const refresh = async (): Promise<T> => {
    const existing = inFlight.get(cacheKey);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      const gotLease = await tryAcquireRefreshLease(cacheKey);
      if (!gotLease) {
        // Another process already holds the refresh lease -- if we have any
        // cached value at all (even past hard TTL), ride on it rather than
        // adding a second concurrent upstream call; only fetch directly if
        // there's truly nothing to serve. No explicit release: the lease
        // expires on its own (LEASE_MS) even if the leaseholder crashes
        // mid-fetch, so a stuck lease self-heals instead of deadlocking.
        if (cached) return cached.value;
        return runFetcherAndRecord();
      }
      try {
        const fresh = await runFetcherAndRecord();
        await durableKv.set(cacheKey, { value: fresh, cachedAt: Date.now() } satisfies CachedEnvelope<T>);
        return fresh;
      } catch (error) {
        // Same discipline as this session's earlier CryptoPunks fixes: a
        // transient upstream failure must not discard/overwrite a real
        // cached value, however stale. Fall back to it if one exists;
        // only propagate the error when there's truly nothing to serve.
        if (cached) return cached.value;
        throw error;
      }
    })();

    inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(cacheKey);
    }
  };

  if (cached && now - cached.cachedAt < hardTtlMs) {
    // Stale-while-revalidate: return what we have now, refresh in the
    // background without making this request wait on it.
    void refresh().catch(() => undefined);
    return { value: cached.value, freshness: "cached", ageMs: now - cached.cachedAt };
  }

  // Past hard TTL (or no cache at all) -- this request actually waits.
  const fresh = await refresh();
  return { value: fresh, freshness: "live", ageMs: null };
}
