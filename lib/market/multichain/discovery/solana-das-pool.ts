/**
 * Multi-PROVIDER Solana DAS capacity pool -- the real fix for a real ceiling
 * flagged live 2026-08-23: helius-key-pool.ts already pools multiple KEYS,
 * but Helius buckets credits/RPS per PROJECT (see that file's own header),
 * so every key minted under the same account still shares one real ceiling.
 * Confirmed live in the running supervisor logs that single-project
 * exhaustion stalls Solana collection discovery AND rarity scaffolding
 * simultaneously, since both drew from the one Helius project.
 *
 * The Metaplex DAS JSON-RPC contract (searchAssets/getAsset/getAssetsByGroup
 * over one POST endpoint) is identical across companies -- confirmed live
 * against each provider's own docs: Helius (mainnet.helius-rpc.com),
 * QuickNode (their per-endpoint URL, with the Metaplex DAS add-on enabled),
 * and Shyft (rpc.shyft.to). So real capacity multiplies the moment a
 * SEPARATE company's key is added, because each is billed/rate-limited on
 * its own completely independent infrastructure -- unlike minting a 2nd key
 * under the same Helius project, which does not add real headroom.
 *
 * Every entry's `url` is fully formed (key/token already embedded) so every
 * caller just POSTs the exact same DAS JSON-RPC body to `slot.url` --
 * nobody upstream needs to know or care which company answered.
 */
import { postgresQuery } from "@/lib/postgres";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow, type ProviderWindow } from "@/lib/market/multichain/control-plane";
import { checkSourceBudget, readSourceBudget, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { isSourceJailed, jailRemainingMs, jailSource } from "@/lib/market/multichain/mesh/jail";

/**
 * How long a real DAS failure (429/quota-shaped error) cools this specific
 * provider entry off before it's tried again. Same order of magnitude as
 * other real per-source jails in this app (e.g. mesh/jail.ts's own default
 * via jailSource's callers elsewhere) -- long enough that a genuinely
 * exhausted provider stops being retried every 2s, short enough that a
 * transient blip self-heals same-day.
 */
const DAS_FAILURE_JAIL_MS = 5 * 60 * 1000;

/**
 * Same safety-valve reasoning as HELIUS_DAILY_ALLOWANCE in helius-key-pool.ts
 * -- sizes the plank_provider_windows reservation window's arithmetic only,
 * never a real checkSourceBudget ceiling. No DAILY_CEILING entry exists for
 * any "helius:key-N" / "quicknode:*" / "shyft:*" providerAccount -- the real
 * gate is jail state (consecutive/quota failures), not this figure.
 */
export const DAS_DAILY_ALLOWANCE = 20_000;

export type DasProvider = "helius" | "quicknode" | "shyft";

export type DasEntry = {
  id: string;
  provider: DasProvider;
  url: string;
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
 * Falls back cleanly when a provider's env var is unset -- zero regression
 * risk, exactly today's Helius-only pool when nothing else is configured.
 * HELIUS_API_KEYS (comma list, real separate accounts ideally) takes
 * priority over the single legacy HELIUS_API_KEY, same as helius-key-pool.ts.
 */
export function loadDasPool(): DasEntry[] {
  const entries: DasEntry[] = [];

  const heliusRaw = process.env.HELIUS_API_KEYS?.trim();
  const heliusKeys = heliusRaw ? parseKeyList(heliusRaw).slice(0, 10) : [];
  if (heliusKeys.length === 0) {
    const single = process.env.HELIUS_API_KEY?.trim();
    if (single) heliusKeys.push(single);
  }
  heliusKeys.forEach((apiKey, i) => {
    const id = `helius:key-${i}`;
    entries.push({ id, provider: "helius", url: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`, providerAccount: id });
  });

  // QuickNode: the full per-endpoint URL IS the credential (no separate
  // header/query key) -- requires the Metaplex DAS add-on enabled on that
  // endpoint (confirmed live 2026-08-23 against QuickNode's own docs).
  const quicknodeUrl = process.env.QUICKNODE_SOLANA_URL?.trim();
  if (quicknodeUrl) {
    entries.push({ id: "quicknode:default", provider: "quicknode", url: quicknodeUrl, providerAccount: "quicknode:default" });
  }

  // Shyft: DAS JSON-RPC lives at rpc.shyft.to with the key as an api_key
  // query param -- confirmed live against Shyft's own docs 2026-08-23.
  const shyftKey = process.env.SHYFT_API_KEY?.trim();
  if (shyftKey) {
    entries.push({ id: "shyft:default", provider: "shyft", url: `https://rpc.shyft.to/?api_key=${shyftKey}`, providerAccount: "shyft:default" });
  }

  return entries;
}

export type DasSlot = DasEntry & { window: ProviderWindow };

type EntryLoad = { providerAccount: string; load: number };

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

export type DasPriority = "live" | "background";

async function orderCandidates(priority: DasPriority, window: ProviderWindow): Promise<Array<DasEntry & EntryLoad>> {
  const pool = loadDasPool();
  const unjailed = pool.filter((entry) => checkSourceBudget(entry.providerAccount).allowed);
  if (unjailed.length === 0) return [];
  const usage = await loadTodayUsage(unjailed.map((e) => e.providerAccount), window);
  const withLoad: Array<DasEntry & EntryLoad> = unjailed.map((entry) => ({
    ...entry,
    load: usage.get(entry.providerAccount) ?? 0,
  }));
  // "live" spreads to the least-loaded entry first (lowest latency feel);
  // "background" deliberately piles onto the most-loaded entry first, so
  // background work and live traffic naturally spread across different
  // providers/keys when more than one is configured (same reasoning as
  // helius-key-pool.ts's orderCandidates).
  return priority === "background"
    ? withLoad.sort((a, b) => b.load - a.load)
    : withLoad.sort((a, b) => a.load - b.load);
}

export async function reserveDasSlot(cost = 1, opts?: { priority?: DasPriority }): Promise<DasSlot | null> {
  const priority = opts?.priority ?? "live";
  const window = utcDayWindow(DAS_DAILY_ALLOWANCE);
  const ordered = await orderCandidates(priority, window);

  for (const candidate of ordered) {
    if (await reserveProviderCapacity(candidate.providerAccount, window, cost)) {
      return { ...candidate, window };
    }
  }
  return null;
}

/**
 * REAL BUG FIXED 2026-08-24, flagged live ("why are collections not
 * continuously found for solana"): this used to only ever update the
 * plank_provider_windows capacity counters -- it never called into the
 * jail system (mesh/jail.ts / source-budget.ts) at all, on success OR
 * failure. checkSourceBudget()-based candidate ordering in
 * orderCandidates() only ever READS jail state; with nothing writing to
 * it, a provider that genuinely 429s on every real call never gets
 * jailed, so it kept winning selection forever (still had daily-window
 * "capacity" left, since that ceiling is a separate, unrelated safety
 * valve -- see DAS_DAILY_ALLOWANCE's own header) while QuickNode/Shyft
 * sat completely idle (confirmed live: usedToday 0 on both, despite
 * being configured and healthy) because a failing-but-not-jailed Helius
 * key was always tried first. Now actually jails a real failure for
 * DAS_FAILURE_JAIL_MS (durable, cross-process, via jailSource -- so a
 * fresh supervisor respawn doesn't immediately retry the same dead
 * provider either) and records a real success, matching every other
 * real provider pool in this app (alchemy-nft.ts, opensea-key-pool.ts).
 */
export async function settleDasSlot(slot: DasSlot, cost = 1, success = true): Promise<void> {
  await settleProviderCapacity(slot.providerAccount, slot.window, cost, success);
  if (success) {
    recordSourceSuccess(slot.providerAccount);
  } else {
    await jailSource(slot.providerAccount, DAS_FAILURE_JAIL_MS, true);
  }
}

export type DasEntryHealth = {
  id: string;
  provider: DasProvider;
  usedToday: number;
  allowanceToday: number;
  processJailed: boolean;
  processJailedUntil: number | null;
  processCallsToday: number;
  durableJailed: boolean;
  durableJailRemainingMs: number;
};

export type DasPoolHealth = {
  configured: number;
  healthy: number;
  jailedOrExhausted: number;
  degraded: boolean;
  entries: DasEntryHealth[];
};

/** Real-time, one-call health snapshot across every configured provider entry. */
export async function getDasPoolHealth(): Promise<DasPoolHealth> {
  const pool = loadDasPool();
  const window = utcDayWindow(DAS_DAILY_ALLOWANCE);
  const usage = await loadTodayUsage(pool.map((e) => e.providerAccount), window);
  const entries: DasEntryHealth[] = await Promise.all(
    pool.map(async (entry) => {
      const processState = readSourceBudget(entry.providerAccount);
      const durableJailed = await isSourceJailed(entry.providerAccount);
      const durableJailRemainingMs = durableJailed ? await jailRemainingMs(entry.providerAccount) : 0;
      return {
        id: entry.id,
        provider: entry.provider,
        usedToday: usage.get(entry.providerAccount) ?? 0,
        allowanceToday: DAS_DAILY_ALLOWANCE,
        processJailed: processState.jailed,
        processJailedUntil: processState.jailedUntil,
        processCallsToday: processState.callsToday,
        durableJailed,
        durableJailRemainingMs,
      };
    })
  );
  const jailedOrExhausted = entries.filter(
    (e) => e.processJailed || e.durableJailed || e.usedToday >= e.allowanceToday
  ).length;
  return {
    configured: entries.length,
    healthy: entries.length - jailedOrExhausted,
    jailedOrExhausted,
    degraded: entries.length === 0 || jailedOrExhausted >= entries.length,
    entries,
  };
}
