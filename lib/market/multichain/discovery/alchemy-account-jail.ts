/**
 * ONE real, shared, durable circuit breaker for Alchemy's actual account-
 * level (monthly compute-unit) quota -- mirrors hypersync-account-jail.ts's
 * own fix for the identical real bug class, found live 2026-08-25 during
 * the "hunt for lessons-learned recurrences" audit.
 *
 * Real gap found: this app's real Alchemy usage was tracked under at
 * least 9 separate siloed keys -- rpc-provider-pool.ts's own per-CHAIN
 * jail (`rpc-pool:<chain>:alchemy`, one per EVM chain) and alchemy-nft.ts's
 * separate `alchemy-nft:default` jail -- all hitting the exact same real
 * Alchemy account/API key. A real detected 429/monthly-quota failure on
 * ONE of those 9 keys was invisible to the other 8, each of which had to
 * independently burn its own real doomed call before self-protecting.
 *
 * Worse: alchemy-nft.ts's own jail (jailAlchemyNftUntilMonthReset) used
 * only source-budget.ts's in-memory, per-process recordSourceFailure --
 * never the durable, cross-process jail (mesh/jail.ts) every other real
 * quota-sensitive source in this app uses. For a MONTHLY quota, an
 * in-memory jail that resets on every process restart (every few minutes
 * for the short-pass mesh lanes) is close to useless -- confirmed live
 * this session that a fresh process re-discovers the same still-ongoing
 * real outage from scratch on every restart (the exact HyperSync incident
 * this same fix already solved once tonight).
 */
import { isSourceJailed, jailSource } from "@/lib/market/multichain/mesh/jail";

const ALCHEMY_ACCOUNT_SOURCE = "alchemy-account";

function nextUtcMonthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export async function isAlchemyAccountJailed(): Promise<boolean> {
  return isSourceJailed(ALCHEMY_ACCOUNT_SOURCE);
}

/** Real monthly-quota jail -- durable until the real UTC month rolls over, shared across every real Alchemy call site in this app. Each call site keeps its own existing quota-detection heuristic (alchemy-nft.ts's isAlchemyQuotaStatus, evm-log-scan.ts's isAlchemyQuotaText) and calls this only once it has already decided a real quota error occurred. */
export async function jailAlchemyAccountUntilMonthReset(): Promise<void> {
  await jailSource(ALCHEMY_ACCOUNT_SOURCE, Math.max(60_000, nextUtcMonthStartMs() - Date.now()), true);
}
