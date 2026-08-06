import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getKingOfTheHill } from "@/lib/market/king-of-the-hill";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The single authoritative source for the King of the Hill round: the live
 * deadline (mutated only by the grace-extension rule), the current leading
 * sale, and — once real time has passed the deadline with no further
 * qualifying extension — the permanent winner.
 *
 * Replaces components/market/EventCountdown.tsx's hardcoded client-only
 * TARGET_ISO constant and its separate /api/market/sales-stats "highest
 * sale" read with this one real, server-persisted state (see
 * lib/market/king-of-the-hill.ts and migration 009_king_of_the_hill.sql).
 *
 * A GET here is itself sufficient to finalize a timed-out round
 * (getKingOfTheHill lazily finalizes on read before returning) — no separate
 * cron entry needed just for that, though the ledger's own sale-ingestion
 * path (lib/market/chain-indexer.ts) also finalizes eagerly on every new
 * sale, so a round closes out even if nobody hits this endpoint again after
 * the deadline.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-king-of-the-hill", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const state = await getKingOfTheHill();
    if (!state) {
      return publicJson({
        available: false,
        note: "King of the Hill requires PostgreSQL, which is not configured on this deployment.",
      });
    }

    return publicJson({
      available: true,
      deadline: new Date(state.deadlineMs).toISOString(),
      leadingSale: state.leadingSale
        ? {
            txHash: state.leadingSale.txHash,
            tokenId: state.leadingSale.tokenId,
            wallet: state.leadingSale.wallet,
            priceWei: state.leadingSale.priceWei,
          }
        : null,
      finalized: state.winnerFinalizedAtMs != null,
      winnerFinalizedAt:
        state.winnerFinalizedAtMs == null ? null : new Date(state.winnerFinalizedAtMs).toISOString(),
      winner: state.winnerSale
        ? {
            txHash: state.winnerSale.txHash,
            tokenId: state.winnerSale.tokenId,
            wallet: state.winnerSale.wallet,
            priceWei: state.winnerSale.priceWei,
          }
        : null,
    });
  } catch (error) {
    return publicError(error, "Could not load King of the Hill state.");
  }
}
