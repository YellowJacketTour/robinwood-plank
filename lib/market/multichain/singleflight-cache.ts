import { durableKv } from "@/lib/market/durable-kv";
import { postgresQuery } from "@/lib/postgres";
import {
  getEffectiveTtl,
  isProviderBudgetExhausted,
  recordProviderCall,
} from "@/lib/market/multichain/freshness-budget";

/**
 * One shared resource fingerprint across visitors and Passenger processes.
 * Warm values return immediately. Cold followers join the durable refresh;
 * they never bypass an occupied lease by calling the provider independently.
 * Numeric leases remain compatible with existing releases. Renewable ownership
 * fences publication so an expired owner cannot replace a newer snapshot.
 * No database connection is held while waiting on a provider or another process.
 */

const inFlight = new Map<string, Promise<unknown>>();
const LEASE_MS = 15_000;
const MAX_REFRESH_MS = 90_000;
const MAX_JOIN_MS = 30_000;

// Real production bug found live 2026-09-06 ("still no global"): this
// predicate used `(value)::bigint`, a direct jsonb->bigint cast that the
// production PostgreSQL major rejects ("cannot cast type jsonb to bigint"),
// so EVERY getOrRefresh on production threw here -- hidden for weeks by the
// callers' `.catch(() => null)`, exposed the moment the hub index went
// through the edge. `#>> '{}'` extracts the scalar as text on every
// supported major (json and jsonb alike) before the cast.
async function tryAcquireRefreshLease(key: string): Promise<number | null> {
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
  return result.rows.length > 0 ? now + LEASE_MS : null;
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

  const cachedResult = (entry: CachedEnvelope<T>): EnvelopeResult<T> => ({
    value: entry.value, freshness: "cached", ageMs: Math.max(0, Date.now() - entry.cachedAt),
  });

  const refresh = async (): Promise<EnvelopeResult<T>> => {
    const existing = inFlight.get(cacheKey);
    if (existing) return existing as Promise<EnvelopeResult<T>>;

    const promise = (async (): Promise<EnvelopeResult<T>> => {
      const joinDeadline = Date.now() + MAX_JOIN_MS;
      let delayMs = 40;
      let lease = await tryAcquireRefreshLease(cacheKey);
      while (lease === null) {
        const shared = await durableKv.get<CachedEnvelope<T>>(cacheKey);
        if (shared) return cachedResult(shared);
        if (Date.now() >= joinDeadline) throw new Error("shared_refresh_pending: another process is hydrating this resource");
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs = Math.min(500, Math.ceil(delayMs * 1.6));
        // A crashed owner expires naturally; only one follower can take over.
        lease = await tryAcquireRefreshLease(cacheKey);
      }
      // A previous owner may have published between our last read and claim.
      const shared = await durableKv.get<CachedEnvelope<T>>(cacheKey);
      if (shared && Date.now() - shared.cachedAt < softTtlMs) {
        await postgresQuery(`UPDATE plank_kv_values SET value=to_jsonb(0::bigint)
          WHERE key_name=$1 AND (value #>> '{}')::bigint=$2`, [`${cacheKey}:lease`, lease]);
        return cachedResult(shared);
      }

      let stopped = false;
      let lost = false;
      let renewal: Promise<void> = Promise.resolve();
      let renewalTimer: ReturnType<typeof setTimeout> | undefined;
      const renew = () => {
        renewalTimer = setTimeout(() => {
          renewal = (async () => {
            const next = Date.now() + LEASE_MS;
            const renewed = await postgresQuery(`UPDATE plank_kv_values SET value=to_jsonb($3::bigint), updated_at=NOW()
              WHERE key_name=$1 AND (value #>> '{}')::bigint=$2 AND $2 > $4 RETURNING key_name`,
            [`${cacheKey}:lease`, lease, next, Date.now()]);
            if (renewed.rowCount !== 1) lost = true;
            else lease = next;
          })().catch(() => { lost = true; }).finally(() => { if (!stopped && !lost) renew(); });
        }, LEASE_MS / 3);
        renewalTimer.unref?.();
      };
      const stopRenewal = async () => {
        stopped = true;
        clearTimeout(renewalTimer);
        await renewal;
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      renew();
      try {
        const fresh = await Promise.race([
          runFetcherAndRecord(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("shared_refresh_timeout")), MAX_REFRESH_MS);
          }),
        ]);
        await stopRenewal();
        if (!lost) {
          // Claim consumption and publication are one transaction. Only the
          // current unexpired owner can publish, even across delayed processes.
          const published = await postgresQuery(`WITH owner AS (
            UPDATE plank_kv_values SET value=to_jsonb(0::bigint), updated_at=NOW()
            WHERE key_name=$1 AND (value #>> '{}')::bigint=$2 AND $2 > $5 RETURNING key_name
          ) INSERT INTO plank_kv_values(key_name,value,expires_at,updated_at)
            SELECT $3,$4::jsonb,NULL,NOW() FROM owner
            ON CONFLICT(key_name) DO UPDATE SET value=EXCLUDED.value,expires_at=NULL,updated_at=NOW()
            RETURNING key_name`,
          [`${cacheKey}:lease`, lease, cacheKey, JSON.stringify({value: fresh, cachedAt: Date.now()} satisfies CachedEnvelope<T>), Date.now()]);
          if (published.rowCount === 1) return {value: fresh, freshness: "live", ageMs: null};
        }
        const winner = await durableKv.get<CachedEnvelope<T>>(cacheKey);
        if (winner) return cachedResult(winner);
        throw new Error("shared_refresh_lease_lost: newer refresh owns this resource");
      } catch (error) {
        const lastGood = await durableKv.get<CachedEnvelope<T>>(cacheKey).catch(() => null) ?? cached;
        if (lastGood) return cachedResult(lastGood);
        throw error;
      } finally {
        clearTimeout(timeout);
        await stopRenewal();
        // Compare-and-release cannot unlock somebody else's newer lease.
        await postgresQuery(`UPDATE plank_kv_values SET value=to_jsonb(0::bigint), updated_at=NOW()
          WHERE key_name=$1 AND (value #>> '{}')::bigint=$2`, [`${cacheKey}:lease`, lease]).catch(() => {});
      }
    })();

    inFlight.set(cacheKey, promise);
    try { return await promise; }
    finally { if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey); }
  };

  if (cached && now - cached.cachedAt < hardTtlMs) {
    // Stale-while-revalidate: return what we have now, refresh in the
    // background without making this request wait on it.
    void refresh().catch(() => undefined);
    return { value: cached.value, freshness: "cached", ageMs: now - cached.cachedAt };
  }

  // Past hard TTL (or no cache at all) -- this request actually waits.
  return refresh();
}
