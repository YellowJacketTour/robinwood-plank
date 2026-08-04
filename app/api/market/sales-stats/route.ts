import { publicError, publicJson, rateLimit } from "@/lib/security";
import { salesStatsFromLedger, type LedgerSalesStats } from "@/lib/market/chain-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Highest sale / volume / count — reads the permanent chain-event ledger
 * exclusively (lib/market/chain-events.ts salesStatsFromLedger, the same
 * complete, evidence-based history the Activity feed reads — migration
 * 008_chain_events.sql).
 *
 * Deliberately does NOT fall back to the pre-ledger sales-catalog.ts. That
 * system is not just incomplete, it is actively WRONG for this purpose: it
 * requires EIP-2981 royalty payment as its "is this a real sale" proxy,
 * which silently excludes any genuine sale that went through a venue that
 * didn't route royalty — exactly the kind of gap that made a real 0.11 ETH
 * sale look never-happened. Falling back to it here would mean occasionally
 * showing a confidently WRONG highest-sale figure instead of an honestly
 * "still catching up" one. A stale-but-real cached ledger answer is always
 * preferable to a fresh-but-wrong legacy one.
 *
 * Cold-cache handling, same discipline as app/api/market/activity/route.ts:
 * - In-memory cache with a TTL, so a burst of requests doesn't hit Postgres
 *   on every single one.
 * - NEVER overwrite a real cached result with an empty one. A transient
 *   read failure or a genuinely cold ledger must not blank a page that was
 *   showing correct data a moment ago — the last real answer stays live
 *   until a new real one supersedes it.
 * - Only when there is truly no cache yet (first request after a fresh
 *   deploy, ledger still backfilling) does this return an honest empty
 *   state with a note explaining why, rather than inventing or borrowing a
 *   number from a different, less trustworthy source.
 */
const CACHE_MS = 30_000;
/** How long a stale-but-real cached answer is preferred over a fresh EMPTY
 *  one before we accept that maybe the ledger genuinely has nothing (yet). */
const STALE_GRACE_MS = 10 * 60 * 1000;

let cache: { at: number; stats: LedgerSalesStats } | null = null;

function payloadFor(stats: LedgerSalesStats, extra: Record<string, unknown>) {
  return { ...stats, ...extra };
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-sales-stats", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return publicJson(
      payloadFor(cache.stats, {
        royaltyRequired: false,
        source: "ledger",
        cached: true,
        note: "Complete ledger history — every real marketplace fill this ledger has evidence for.",
      })
    );
  }

  try {
    const stats = await salesStatsFromLedger();

    if (stats.saleCount > 0) {
      cache = { at: Date.now(), stats };
      return publicJson(
        payloadFor(stats, {
          royaltyRequired: false,
          source: "ledger",
          cached: false,
          note: "Complete ledger history — every real marketplace fill this ledger has evidence for.",
        })
      );
    }

    // Fresh read came back empty. If we have a real cached answer that
    // isn't ancient, prefer it over presenting an empty/zeroed page.
    if (cache && Date.now() - cache.at < STALE_GRACE_MS) {
      return publicJson(
        payloadFor(cache.stats, {
          royaltyRequired: false,
          source: "ledger",
          cached: true,
          stale: true,
          note: "Complete ledger history (serving the last known-good read while re-checking).",
        })
      );
    }

    // Genuinely nothing yet, and nothing recent to fall back to — say so
    // honestly rather than borrow a number from the royalty-gated legacy
    // catalog, which can be wrong in a way that reads as confidently right.
    return publicJson(
      payloadFor(stats, {
        royaltyRequired: false,
        source: "ledger",
        cached: false,
        ledgerPending: true,
        note:
          "The permanent sales ledger hasn't indexed a sale yet on this deployment — it backfills automatically, or an admin can accelerate it from /admin's System section.",
      })
    );
  } catch (error) {
    // A DB hiccup must not blank a page that was correct a moment ago.
    if (cache) {
      return publicJson(
        payloadFor(cache.stats, {
          royaltyRequired: false,
          source: "ledger",
          cached: true,
          stale: true,
          note: "Complete ledger history (serving the last known-good read after a read error).",
        })
      );
    }
    return publicError(error, "Could not load sales stats.");
  }
}
