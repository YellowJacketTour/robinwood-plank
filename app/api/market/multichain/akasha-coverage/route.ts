import { NextRequest, NextResponse } from "next/server";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The archive's own coverage, read back so a stranger can falsify it.
 *
 * The hose writes `akasha_cursor` and `akasha_coverage_run`, and migration
 * 104 defines `akasha_coverage_health` over them -- but nothing outside the
 * database could read any of it. The tape was being written and never
 * quoted, which is the worst arrangement of the two: the UI kept saying
 * things (names, floors, badges) with no way to check what the archive
 * actually holds underneath them.
 *
 * The single sanctioned sentence is `complete_from_protocol`, and the view
 * computes it -- NOT this route. It is true only when all four hold:
 *
 *   backfill_tail <= protocol_t0     walked all the way left, and
 *   run_count = 1                    the run-list is ONE span, not fragments
 *   run_from <= protocol_t0          that span starts at the protocol origin
 *   run_to   >= finalized_height     and reaches the finalized head
 *
 * `run_count = 1` is the load-bearing clause. Without it an archive with
 * holes could satisfy the endpoints and still claim completeness; counting
 * the runs is what makes a gap impossible to hide. This route must never
 * recompute that boolean from the other columns -- one definition, in SQL,
 * next to the data.
 *
 * Until a chain is complete, `sentence` is "complete from block N", never
 * "complete". That is the §9 rule: do not widen the speech beyond what the
 * tape supports.
 */

type HealthRow = {
  chain: string;
  protocol_t0: string | number | null;
  archive_origin: string | number | null;
  backfill_tail: string | number | null;
  finalized_height: string | number | null;
  tip_height: string | number | null;
  stream_alive: boolean | null;
  run_count: string | number | null;
  run_from: string | number | null;
  run_to: string | number | null;
  complete_from_protocol: boolean | null;
};

/**
 * pg returns int8/COUNT as a STRING to avoid silently losing precision past
 * 2^53. Number(null) is 0 and Number(undefined) is NaN, and a height of 0
 * is a real, meaningful value (it is genesis), so "missing" has to stay
 * distinguishable from "zero" rather than collapsing into it.
 */
function num(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-akasha-coverage", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  if (!hasPostgresConfig()) {
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await postgresQuery<HealthRow>(
      `SELECT chain, protocol_t0, archive_origin, backfill_tail, finalized_height,
              tip_height, stream_alive, run_count, run_from, run_to,
              complete_from_protocol
         FROM akasha_coverage_health
        ORDER BY chain`
    );

    const chains = result.rows.map((r) => {
      const protocolT0 = num(r.protocol_t0);
      const backfillTail = num(r.backfill_tail);
      const finalized = num(r.finalized_height);
      const tip = num(r.tip_height);
      const complete = r.complete_from_protocol === true;

      // Blocks still to walk LEFT before the archive reaches the protocol
      // origin. This is the number that must fall for the backfill to be
      // working; if it holds still, the past worker is not moving.
      const blocksToProtocolT0 =
        backfillTail !== null && protocolT0 !== null ? Math.max(0, backfillTail - protocolT0) : null;

      // How far the finalized head trails the chain tip. Small and steady is
      // healthy; growing means the forward worker is falling behind.
      const behindTip = tip !== null && finalized !== null ? tip - finalized : null;

      return {
        chain: r.chain,
        protocolT0,
        archiveOrigin: num(r.archive_origin),
        backfillTail,
        finalizedHeight: finalized,
        tipHeight: tip,
        streamAlive: r.stream_alive === true,
        runCount: num(r.run_count),
        runFrom: num(r.run_from),
        runTo: num(r.run_to),
        blocksToProtocolT0,
        behindTip,
        completeFromProtocol: complete,
        // The ONLY sentence the UI may render for this chain.
        sentence: complete
          ? "complete from protocol origin"
          : backfillTail !== null
            ? `complete from block ${backfillTail}`
            : "coverage unknown",
      };
    });

    return NextResponse.json(
      { chains, asOf: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } }
    );
  } catch (err) {
    return publicError(err, "Could not read the archive's coverage.");
  }
}
