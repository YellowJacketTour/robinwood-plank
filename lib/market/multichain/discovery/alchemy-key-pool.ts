/**
 * Multi-key Alchemy capacity pool -- same pattern as opensea-key-pool.ts
 * (read that file's header first; this one only documents what differs).
 *
 * DOC CHECK PERFORMED 2026-08-23, PER THIS SESSION'S OWN STANDING RULE
 * ("confirm, don't assume"): an earlier design pass claimed Alchemy issues
 * "genuinely independent per-app/per-key compute-unit buckets even under
 * one account" and named this the best next multi-key candidate. That is
 * NO LONGER ACCURATE against Alchemy's real, current docs, fetched live
 * this session:
 *   - https://www.alchemy.com/docs/reference/throughput: "Throughput is
 *     now configured at the account level (no longer per app), meaning
 *     the combined usage of all your Alchemy apps counts toward your
 *     overall throughput limit."
 *   - https://www.alchemy.com/support/free-tier-details: "Each free tier
 *     account is allocated up to 30 million Compute Units (CUs) every
 *     month. This account-wide limit..."
 * So Alchemy is now the EXACT SAME constraint OpenSea's own pool already
 * documents: keys minted under the SAME account share one throughput
 * bucket and one monthly CU pool. Multiple keys from the same account do
 * NOT multiply real capacity, only give this app more knobs to
 * round-robin a single account-wide bucket with (and, per-key, keep the
 * durable circuit breaker / plank_provider_windows bookkeeping separate
 * per key, which still has real value for isolating a bad key without
 * blocking the others). Real capacity only multiplies with keys minted
 * under genuinely SEPARATE Alchemy accounts.
 *
 * Built anyway, matching OpenSea's own precedent for an account-bound
 * provider: zero regression risk (falls back to today's single
 * ALCHEMY_API_KEY behavior when ALCHEMY_API_KEYS is unset), and real
 * value the moment the operator holds >1 account's worth of keys.
 *
 * Set ALCHEMY_API_KEYS to a comma-separated list of real Alchemy API
 * keys (ideally from separate Alchemy accounts, for the reason above) to
 * activate the pool. Whitespace trimmed, empties dropped, duplicates
 * de-duped, same as OpenSea's parser.
 */
import { postgresQuery } from "@/lib/postgres";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow, type ProviderWindow } from "@/lib/market/multichain/control-plane";
import { checkSourceBudget, readSourceBudget } from "@/lib/market/multichain/discovery/source-budget";
import { isSourceJailed, jailRemainingMs } from "@/lib/market/multichain/mesh/jail";

/**
 * No DAILY_CEILING entry exists for "alchemy:key-N" in source-budget.ts --
 * checkSourceBudget only ever gates on jail state for this key. This is an
 * APPROXIMATED, conservative PER-KEY daily allowance derived from the real
 * 30M CU/month free-tier figure (30_000_000 / 30 days = 1_000_000 CU/day);
 * paid tiers simply never hit it. It exists so plank_provider_windows has
 * a real, bounded window to reserve against, not because it is the actual
 * Alchemy-enforced number (that's account-wide throughput/CU, tracked by
 * Alchemy itself, not by us).
 */
export const ALCHEMY_DAILY_ALLOWANCE = 1_000_000;

/** Composite circuit-breaker source string for one pool key. Zero changes needed to source-budget.ts / jail.ts -- `source` is already an opaque string there. */
export function alchemyKeySource(keyId: string): string {
  return `alchemy:${keyId}`;
}

export type AlchemyKeyEntry = {
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
 * ALCHEMY_API_KEY when ALCHEMY_API_KEYS is unset -- zero behavior change
 * for every deployment that hasn't opted in. Returns [] (never a "demo"
 * placeholder entry) when nothing is configured -- callers already handle
 * "no real key" via their own demo-key / keyless fallbacks.
 */
export function loadAlchemyKeyPool(): AlchemyKeyEntry[] {
  const raw = process.env.ALCHEMY_API_KEYS?.trim();
  if (raw) {
    const keys = parseKeyList(raw).slice(0, 10);
    if (keys.length > 0) {
      return keys.map((apiKey, i) => ({ id: `key-${i}`, apiKey, providerAccount: alchemyKeySource(`key-${i}`) }));
    }
  }
  const single = process.env.ALCHEMY_API_KEY?.trim();
  if (!single) return [];
  return [{ id: "key-0", apiKey: single, providerAccount: alchemyKeySource("key-0") }];
}

export type AlchemyKeySlot = AlchemyKeyEntry & { window: ProviderWindow };

type KeyLoad = { providerAccount: string; load: number };

/** Real reserved+consumed for today's UTC window, for every pool key, in one query. Keys with no row yet load as 0. */
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

export type AlchemyKeyPriority = "live" | "background";

async function orderCandidates(priority: AlchemyKeyPriority, window: ProviderWindow): Promise<Array<AlchemyKeyEntry & KeyLoad>> {
  const pool = loadAlchemyKeyPool();
  const unjailed = pool.filter((entry) => checkSourceBudget(entry.providerAccount).allowed);
  if (unjailed.length === 0) return [];
  const usage = await loadTodayUsage(unjailed.map((e) => e.providerAccount), window);
  const withLoad: Array<AlchemyKeyEntry & KeyLoad> = unjailed.map((entry) => ({
    ...entry,
    load: usage.get(entry.providerAccount) ?? 0,
  }));
  return priority === "background"
    ? withLoad.sort((a, b) => b.load - a.load)
    : withLoad.sort((a, b) => a.load - b.load);
}

/** Select the best key WITHOUT reserving capacity -- for call sites (most of them) that never tracked plank_provider_windows to begin with. Still load-balances by the same ordering reserveAlchemyKey uses. */
export async function pickAlchemyKey(priority: AlchemyKeyPriority = "live"): Promise<AlchemyKeyEntry | null> {
  const window = utcDayWindow(ALCHEMY_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);
  return ordered[0] ?? null;
}

export async function reserveAlchemyKey(cost = 1, opts?: { priority?: AlchemyKeyPriority }): Promise<AlchemyKeySlot | null> {
  const priority = opts?.priority ?? "live";
  const window = utcDayWindow(ALCHEMY_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);

  for (const candidate of ordered) {
    if (await reserveProviderCapacity(candidate.providerAccount, window, cost)) {
      return { id: candidate.id, apiKey: candidate.apiKey, providerAccount: candidate.providerAccount, window };
    }
  }
  return null;
}

export async function settleAlchemyKey(slot: AlchemyKeySlot, cost = 1, success = true): Promise<void> {
  await settleProviderCapacity(slot.providerAccount, slot.window, cost, success);
}

export type AlchemyKeyHealth = {
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

export type AlchemyPoolHealth = {
  configured: number;
  healthy: number;
  jailedOrExhausted: number;
  degraded: boolean;
  keys: AlchemyKeyHealth[];
};

/** Real-time, one-call health snapshot for every configured pool key. Same durable sources every real reservation checks -- never a derived approximation. */
export async function getAlchemyPoolHealth(): Promise<AlchemyPoolHealth> {
  const pool = loadAlchemyKeyPool();
  const window = utcDayWindow(ALCHEMY_DAILY_ALLOWANCE);
  const usage = await loadTodayUsage(pool.map((e) => e.providerAccount), window);
  const keys: AlchemyKeyHealth[] = await Promise.all(
    pool.map(async (entry) => {
      const processState = readSourceBudget(entry.providerAccount);
      const durableJailed = await isSourceJailed(entry.providerAccount);
      const durableJailRemainingMs = durableJailed ? await jailRemainingMs(entry.providerAccount) : 0;
      return {
        id: entry.id,
        providerAccount: entry.providerAccount,
        usedToday: usage.get(entry.providerAccount) ?? 0,
        allowanceToday: ALCHEMY_DAILY_ALLOWANCE,
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
