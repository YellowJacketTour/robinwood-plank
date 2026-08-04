import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { runChainIndexer } from "@/lib/market/chain-indexer";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Manual accelerator for the permanent chain-event ledger's backfill
 * (migration 008_chain_events.sql, lib/market/chain-indexer.ts).
 *
 * The 2-minute cron already advances this on its own — this exists only so
 * an admin can fast-forward a cold backfill (e.g. right after this ledger's
 * first deploy, walking ~9.5M blocks from genesis) without waiting on
 * however many cron ticks that takes. It calls the exact same
 * runChainIndexer() the cron step does, back-to-back, inside one request,
 * bounded by a wall-clock budget so a slow upstream can't hang the request
 * forever — it is not a different code path, just more of the same one.
 *
 * Idempotent and safe to mash: runChainIndexer() is itself idempotent
 * (ON CONFLICT DO NOTHING keyed on tx_hash+log_index), so calling this
 * repeatedly, or racing it against a concurrent cron tick, never
 * double-inserts or corrupts the cursor.
 */
const WALL_CLOCK_BUDGET_MS = 45_000;
const MAX_PASSES = 40;

export async function POST(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-backfill-events",
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) return limited;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      auth?: AdminProof;
    };
    const auth = body.auth;
    if (
      !auth ||
      typeof auth.address !== "string" ||
      typeof auth.timestamp !== "number" ||
      typeof auth.signature !== "string"
    ) {
      return publicJson(
        { error: "BAD_AUTH", message: "auth requires address, timestamp, and signature." },
        400
      );
    }

    // No mutable payload to bind — the action name alone is what's signed,
    // same shape as any other zero-argument admin action.
    const verdict = verifyAdminProof("backfill-events", "{}", auth);
    if (!verdict.ok) {
      const status = verdict.error === "UNAUTHORIZED" ? 403 : 401;
      return publicJson(
        {
          error: verdict.error,
          message:
            verdict.error === "STALE"
              ? "Signature expired — sign again."
              : verdict.error === "UNAUTHORIZED"
                ? "This wallet is not an admin."
                : "Signature verification failed.",
        },
        status
      );
    }

    const startedAt = Date.now();
    let passes = 0;
    let totalRowsInserted = 0;
    let last: Awaited<ReturnType<typeof runChainIndexer>> | null = null;

    while (
      passes < MAX_PASSES &&
      Date.now() - startedAt < WALL_CLOCK_BUDGET_MS &&
      (last === null || !last.caughtUp)
    ) {
      last = await runChainIndexer();
      totalRowsInserted += last.rowsInserted;
      passes += 1;
    }

    await logAdminAction(
      verdict.address,
      "backfill-events",
      `${passes} pass(es), +${totalRowsInserted} rows, caughtUp=${last?.caughtUp ?? false}, head=${last?.head ?? "?"} confirmed=${last?.confirmedHead ?? "?"}`
    );

    return publicJson({
      ok: true,
      passes,
      rowsInserted: totalRowsInserted,
      caughtUp: last?.caughtUp ?? false,
      head: last?.head ?? null,
      confirmedHead: last?.confirmedHead ?? null,
      sources: (last?.sources ?? []).map((s) => ({
        source: s.source,
        contract: s.contract,
        fromBlock: s.fromBlock,
        toBlock: s.toBlock,
        rowsInserted: s.rowsInserted,
        logsScanned: s.logsScanned,
        error: s.error ?? null,
      })),
      elapsedMs: Date.now() - startedAt,
      note: last?.caughtUp
        ? "Ledger is fully caught up."
        : "Budget exhausted before catching up — call again to continue.",
    });
  } catch (error) {
    return publicError(error, "Backfill pass failed.");
  }
}
