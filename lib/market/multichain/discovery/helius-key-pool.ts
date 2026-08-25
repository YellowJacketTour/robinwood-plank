/**
 * Multi-key Helius capacity pool -- same pattern as opensea-key-pool.ts /
 * alchemy-key-pool.ts (read opensea-key-pool.ts's header first).
 *
 * DOC CHECK PERFORMED 2026-08-23: Helius's own dashboard/API surfaces
 * credit usage via a per-PROJECT `getProjectUsage()` call, and an API key
 * must belong to that same project to read it -- i.e. Helius buckets
 * credits and RPS limits per PROJECT (an account concept), with multiple
 * API keys able to share one project's pool, not per individual key. This
 * is the SAME account-bound constraint as OpenSea and (per the corrected
 * finding in alchemy-key-pool.ts) Alchemy: keys minted under the same
 * Helius project do not multiply real capacity, they only give this app
 * more knobs to round-robin one project's bucket. Real capacity only
 * multiplies with keys minted under genuinely SEPARATE Helius
 * projects/accounts.
 *
 * Built anyway, for the same reason as the Alchemy pool: zero regression
 * risk (HELIUS_API_KEYS unset -> exactly today's single HELIUS_API_KEY
 * behavior), real value the moment >1 project's keys are configured, and
 * per-key circuit-breaker isolation even within one project (one bad/
 * revoked key doesn't jail the others).
 *
 * Set HELIUS_API_KEYS to a comma-separated list of real Helius API keys.
 * Whitespace trimmed, empties dropped, duplicates de-duped.
 */
import { postgresQuery } from "@/lib/postgres";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow, type ProviderWindow } from "@/lib/market/multichain/control-plane";
import { checkSourceBudget, readSourceBudget } from "@/lib/market/multichain/discovery/source-budget";
import { isSourceJailed, jailRemainingMs } from "@/lib/market/multichain/mesh/jail";
import { claimProviderPaceSlot, PROVIDER_PACE_PROFILES } from "@/lib/market/multichain/discovery/provider-pace";

/**
 * No DAILY_CEILING entry exists for "helius:key-N" in source-budget.ts --
 * checkSourceBudget only ever gates on jail state for this key, never a
 * daily count. This constant is used ONLY to size the durable
 * plank_provider_windows reservation window (utcDayWindow), not as a
 * checkSourceBudget ceiling.
 *
 * The 20_000 figure previously cited a "helius-das": 20_000 entry in
 * source-budget.ts's DAILY_CEILING map; that entry was removed 2026-08-23
 * (dead -- no call site anywhere ever called
 * checkSourceBudget("helius-das"), and Helius's own docs
 * (helius.dev/docs/billing/rate-limits) define DAS/Enhanced limits purely
 * as requests-per-second by plan tier -- Free 2 RPS / Developer 10 RPS /
 * Business 50 RPS / Professional 100 RPS -- with no documented flat daily
 * request count to cite). 20_000 is kept here only as a generous, clearly
 * labeled safety-valve bound for the reservation window's arithmetic (a
 * window has to be sized to *something* for reserveProviderCapacity's
 * per-window accounting to work) -- at even the Free tier's 2 RPS, a day
 * has capacity for ~172,800 requests, so this number is intentionally far
 * below what any real plan tier allows and will not itself throttle
 * anything; the actual gate is jail state (consecutive/quota failures),
 * not this figure.
 */
export const HELIUS_DAILY_ALLOWANCE = 20_000;

/** Composite circuit-breaker source string for one pool key. */
export function heliusKeySource(keyId: string): string {
  return `helius:${keyId}`;
}

export type HeliusKeyEntry = {
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

/** Falls back to the single existing HELIUS_API_KEY when HELIUS_API_KEYS is unset -- zero behavior change for every deployment that hasn't opted in. */
export function loadHeliusKeyPool(): HeliusKeyEntry[] {
  const raw = process.env.HELIUS_API_KEYS?.trim();
  if (raw) {
    const keys = parseKeyList(raw).slice(0, 10);
    if (keys.length > 0) {
      return keys.map((apiKey, i) => ({ id: `key-${i}`, apiKey, providerAccount: heliusKeySource(`key-${i}`) }));
    }
  }
  const single = process.env.HELIUS_API_KEY?.trim();
  if (!single) return [];
  return [{ id: "key-0", apiKey: single, providerAccount: heliusKeySource("key-0") }];
}

export type HeliusKeySlot = HeliusKeyEntry & { window: ProviderWindow };

type KeyLoad = { providerAccount: string; load: number };

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

export type HeliusKeyPriority = "live" | "background";

async function orderCandidates(priority: HeliusKeyPriority, window: ProviderWindow): Promise<Array<HeliusKeyEntry & KeyLoad>> {
  const pool = loadHeliusKeyPool();
  const unjailed = pool.filter((entry) => checkSourceBudget(entry.providerAccount).allowed);
  if (unjailed.length === 0) return [];
  const usage = await loadTodayUsage(unjailed.map((e) => e.providerAccount), window);
  const withLoad: Array<HeliusKeyEntry & KeyLoad> = unjailed.map((entry) => ({
    ...entry,
    load: usage.get(entry.providerAccount) ?? 0,
  }));
  return priority === "background"
    ? withLoad.sort((a, b) => b.load - a.load)
    : withLoad.sort((a, b) => a.load - b.load);
}

/** Select the best key WITHOUT reserving capacity -- for call sites that never tracked plank_provider_windows to begin with. */
export async function pickHeliusKey(priority: HeliusKeyPriority = "live"): Promise<HeliusKeyEntry | null> {
  const window = utcDayWindow(HELIUS_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);
  return ordered[0] ?? null;
}

/**
 * Real per-key pacing (Unified Mesh Continuum build, 2026-08-26): every
 * current real caller (helius-transfer-scan.ts) uses plain RPC methods
 * (getSignaturesForAddress), so this paces at the real "10 req/s" RPC tier
 * -- see provider-pace.ts's "helius-rpc" profile header for the exact
 * source and for why DAS/getProgramAccounts aren't paced here yet (no real
 * caller uses them through this pool today).
 */
export async function reserveHeliusKey(cost = 1, opts?: { priority?: HeliusKeyPriority }): Promise<HeliusKeySlot | null> {
  const priority = opts?.priority ?? "live";
  const window = utcDayWindow(HELIUS_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);
  const rpcInterval = PROVIDER_PACE_PROFILES["helius-rpc"].minIntervalMs;

  for (const candidate of ordered) {
    if (!(await claimProviderPaceSlot(candidate.providerAccount, rpcInterval).catch(() => true))) continue;
    if (await reserveProviderCapacity(candidate.providerAccount, window, cost)) {
      return { id: candidate.id, apiKey: candidate.apiKey, providerAccount: candidate.providerAccount, window };
    }
  }
  return null;
}

export async function settleHeliusKey(slot: HeliusKeySlot, cost = 1, success = true): Promise<void> {
  await settleProviderCapacity(slot.providerAccount, slot.window, cost, success);
}

export type HeliusKeyHealth = {
  id: string;
  providerAccount: string;
  usedToday: number;
  allowanceToday: number;
  processJailed: boolean;
  processJailedUntil: number | null;
  processCallsToday: number;
  durableJailed: boolean;
  durableJailRemainingMs: number;
};

export type HeliusPoolHealth = {
  configured: number;
  healthy: number;
  jailedOrExhausted: number;
  degraded: boolean;
  keys: HeliusKeyHealth[];
};

/** Real-time, one-call health snapshot for every configured pool key. */
export async function getHeliusPoolHealth(): Promise<HeliusPoolHealth> {
  const pool = loadHeliusKeyPool();
  const window = utcDayWindow(HELIUS_DAILY_ALLOWANCE);
  const usage = await loadTodayUsage(pool.map((e) => e.providerAccount), window);
  const keys: HeliusKeyHealth[] = await Promise.all(
    pool.map(async (entry) => {
      const processState = readSourceBudget(entry.providerAccount);
      const durableJailed = await isSourceJailed(entry.providerAccount);
      const durableJailRemainingMs = durableJailed ? await jailRemainingMs(entry.providerAccount) : 0;
      return {
        id: entry.id,
        providerAccount: entry.providerAccount,
        usedToday: usage.get(entry.providerAccount) ?? 0,
        allowanceToday: HELIUS_DAILY_ALLOWANCE,
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
