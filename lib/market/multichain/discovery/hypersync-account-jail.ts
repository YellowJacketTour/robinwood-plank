/**
 * ONE real, shared, durable circuit breaker for Envio's actual account-
 * level HyperSync rate limit -- every hypersync-*-scan.ts file (evm,
 * seaport, blur, wyvern, x2y2, foundation, sudoswap, rarible,
 * cryptokitties, anchored-membership) shares exactly one real
 * ENVIO_API_TOKEN/account, but each file's own `withHypersyncReservation`
 * tracked jail state under a DIFFERENT logical source string
 * ("hypersync-evm", "hypersync-seaport", ...) via source-budget.ts's
 * per-process, per-source Map.
 *
 * Real, live-confirmed consequence, 2026-08-25: manual anchored-membership/
 * priority-window testing exhausted the real shared Envio account. Every
 * OTHER hypersync lane (genesis-seaport-backfill among them) had zero
 * visibility into that -- each had to independently burn a real, doomed
 * call and eat its OWN 429 before self-protecting, and a fresh process
 * respawn (every ~4 minutes for the short-pass lanes) reset that lane's
 * own in-memory state, so it re-discovered the SAME still-ongoing real
 * outage from scratch on every single restart. genesis-seaport-backfill
 * represents real, hard-won, multi-day cumulative progress and deserves
 * better than "silently re-eat the same real 429 forever."
 *
 * This is the fix: ONE shared, durable (cross-process, survives restarts --
 * see mesh/jail.ts) jail key. The moment ANY hypersync call site detects a
 * real quota/429 from Envio, every other hypersync call site sees it on
 * its very next check and backs off immediately, instead of needing its
 * own independent failed call to find out.
 */
import { isSourceJailed, jailSource } from "@/lib/market/multichain/mesh/jail";

const HYPERSYNC_ACCOUNT_SOURCE = "hypersync-account";

/** Real, current shared-account jail duration -- matches source-budget.ts's own DEFAULT_JAIL_MS for a single real quota strike. */
const HYPERSYNC_ACCOUNT_JAIL_MS = 15 * 60_000;

export async function isHypersyncAccountJailed(): Promise<boolean> {
  return isSourceJailed(HYPERSYNC_ACCOUNT_SOURCE);
}

export async function jailHypersyncAccount(ms: number = HYPERSYNC_ACCOUNT_JAIL_MS): Promise<void> {
  await jailSource(HYPERSYNC_ACCOUNT_SOURCE, ms, true);
}

/** Real, current shape of an Envio-side quota/rate-limit error message -- same test every real hypersync call site already applies locally, centralized here so the shared jail and each lane's own local jail always agree on what counts. */
export function isHypersyncQuotaError(message: string): boolean {
  return /rate limit|quota|429|too many/i.test(message);
}
