import { NextRequest, NextResponse } from "next/server";
import { postgresQuery } from "@/lib/postgres";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * The worker's own account of what it did, readable over HTTP.
 *
 * WHY THIS EXISTS
 * ---------------
 * Bitcoin's backfill sat frozen at blocksToProtocolT0 = 198,651 across three
 * investigations, each producing a plausible-but-wrong root cause. The reason
 * is that from outside the process, three very different states look
 * identical -- a frozen number, a healthy site, no error anywhere:
 *
 *   1. the akasha-hose worker is not running
 *   2. it runs, but a phase before the backfill throws every tick
 *   3. it runs, the backfill executes, and cannot advance
 *
 * The worker knew which one it was the whole time and said so on stdout, where
 * no route can read it. This endpoint is that knowledge, made reachable.
 *
 * It is a DIAGNOSIS, not a dump: `verdict` names the case and `nextStep` says
 * what to do about it, because a number that still needs interpreting is how
 * this stayed unresolved for so long.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-worker-health", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const [heartbeats, phases] = await Promise.all([
      postgresQuery<{
        worker: string;
        pid: number | null;
        boot_at: string;
        last_tick_at: string | null;
        tick_count: string;
        chains: string | null;
        version: string | null;
        seconds_since_tick: number | null;
        uptime_seconds: number | null;
      }>(
        `SELECT worker, pid, boot_at, last_tick_at, tick_count, chains, version,
                EXTRACT(EPOCH FROM (NOW() - last_tick_at))::float8 AS seconds_since_tick,
                EXTRACT(EPOCH FROM (NOW() - boot_at))::float8 AS uptime_seconds
           FROM akasha_worker_heartbeat`
      ).catch(() => ({ rows: [] })),
      postgresQuery<{
        chain: string;
        phase: string;
        attempts: string;
        completions: string;
        failures: string;
        last_reason: string | null;
        last_error: string | null;
        last_detail: unknown;
        last_attempt_at: string | null;
        last_success_at: string | null;
        last_failure_at: string | null;
      }>(
        `SELECT chain, phase, attempts, completions, failures,
                last_reason, last_error, last_detail,
                last_attempt_at, last_success_at, last_failure_at
           FROM akasha_worker_phase
          ORDER BY chain, phase`
      ).catch(() => ({ rows: [] })),
    ]);

    const hb = heartbeats.rows[0] ?? null;
    const backfill = phases.rows.find((p) => p.phase === "backfill") ?? null;

    // THE DIAGNOSIS. Ordered so the first matching case is the real one:
    // a dead worker explains everything downstream, so it must be checked
    // before anything about the backfill's own counters.
    let verdict = "unknown";
    let nextStep = "No telemetry yet. Deploy this build and let one tick run.";
    const STALE_TICK_SECONDS = 300;

    if (!hb) {
      verdict = "no-heartbeat";
      nextStep =
        "The worker has never written a heartbeat. Either it is not running, " +
        "or it is running a build older than this telemetry. Check that the " +
        "akasha-hose process exists and is on this commit.";
    } else if ((hb.seconds_since_tick ?? Infinity) > STALE_TICK_SECONDS) {
      verdict = "worker-stalled-or-dead";
      nextStep =
        `Last tick was ${Math.round(hb.seconds_since_tick ?? 0)}s ago. The ` +
        "process is dead, hung, or was never restarted. This alone explains a " +
        "frozen tail -- nothing downstream needs investigating until it ticks.";
    } else if (!backfill) {
      verdict = "backfill-never-attempted";
      nextStep =
        "The worker is ticking but the backfill phase has no row at all, so it " +
        "is not being reached. Check the phases that run before it.";
    } else if (Number(backfill.attempts) > Number(backfill.completions) + Number(backfill.failures)) {
      verdict = "backfill-hangs";
      nextStep =
        "The backfill starts more often than it finishes: it is hanging, not " +
        "failing. Suspect an un-timed-out RPC call inside the epoch walk.";
    } else if (Number(backfill.failures) > 0 && backfill.last_error) {
      verdict = "backfill-throws";
      nextStep = `The backfill is throwing: ${backfill.last_error}`;
    } else if (Number(backfill.completions) > 0) {
      verdict = "backfill-runs-but-cannot-advance";
      nextStep =
        "The backfill runs and returns cleanly, so the stall is inside the " +
        `walk itself. Its own reason: ${backfill.last_reason ?? "(none recorded)"}`;
    }

    return NextResponse.json(
      {
        verdict,
        nextStep,
        heartbeat: hb
          ? {
              worker: hb.worker,
              pid: hb.pid,
              bootAt: hb.boot_at,
              lastTickAt: hb.last_tick_at,
              secondsSinceTick: hb.seconds_since_tick,
              uptimeSeconds: hb.uptime_seconds,
              tickCount: Number(hb.tick_count),
              chains: hb.chains,
              version: hb.version,
            }
          : null,
        phases: phases.rows.map((p) => ({
          chain: p.chain,
          phase: p.phase,
          attempts: Number(p.attempts),
          completions: Number(p.completions),
          failures: Number(p.failures),
          // attempts - (completions + failures): a phase that starts and
          // neither finishes nor throws is HANGING, which no single counter
          // can express.
          inFlightOrHung: Number(p.attempts) - Number(p.completions) - Number(p.failures),
          lastReason: p.last_reason,
          lastError: p.last_error,
          lastDetail: p.last_detail,
          lastAttemptAt: p.last_attempt_at,
          lastSuccessAt: p.last_success_at,
          lastFailureAt: p.last_failure_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Could not read worker health right now.");
  }
}
