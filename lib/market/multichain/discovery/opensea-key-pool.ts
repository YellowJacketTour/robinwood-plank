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
import { checkSourceBudget, readSourceBudget } from "@/lib/market/multichain/discovery/source-budget";
import { isSourceJailed, jailRemainingMs } from "@/lib/market/multichain/mesh/jail";

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
 */
export const OPENSEA_STATS_DAILY_ALLOWANCE = 150_000;

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
  const unjailed = pool.filter((entry) => checkSourceBudget(entry.providerAccount).allowed);
  if (unjailed.length === 0) return [];
  const usage = await loadTodayUsage(unjailed.map((e) => e.providerAccount), window);
  const withLoad: Array<OpenSeaKeyEntry & KeyLoad> = unjailed.map((entry) => ({
    ...entry,
    load: usage.get(entry.providerAccount) ?? 0,
  }));
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

export async function reserveOpenSeaKey(cost = 1, opts?: { priority?: OpenSeaKeyPriority }): Promise<OpenSeaKeySlot | null> {
  const priority = opts?.priority ?? "live";
  const window = utcDayWindow(OPENSEA_STATS_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);

  for (const candidate of ordered) {
    if (await reserveProviderCapacity(candidate.providerAccount, window, cost)) {
      return { id: candidate.id, apiKey: candidate.apiKey, providerAccount: candidate.providerAccount, window };
    }
  }
  return null;
}

export async function settleOpenSeaKey(slot: OpenSeaKeySlot, cost = 1, success = true): Promise<void> {
  await settleProviderCapacity(slot.providerAccount, slot.window, cost, success);
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
  const keys: OpenSeaKeyHealth[] = await Promise.all(
    pool.map(async (entry) => {
      const processState = readSourceBudget(entry.providerAccount);
      const durableJailed = await isSourceJailed(entry.providerAccount);
      const durableJailRemainingMs = durableJailed ? await jailRemainingMs(entry.providerAccount) : 0;
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
