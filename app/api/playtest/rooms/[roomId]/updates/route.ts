import { currentPlaytestIdentity } from "@/lib/playtest-auth";
import { randomUUID } from "node:crypto";
import { playtestRoomPollState, playtestRoomSnapshot, PlaytestRoomError, tickPlaytestRound } from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Resumable long poll. PostgreSQL remains authoritative across Passenger
 * workers; no process-local emitter can silently omit another worker's event. */
export async function GET(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    // Per-IP: a whole household / venue on one NAT shares this bucket, and the
    // long-poll worker IS the round keeper. 90/min starved multi-device tables
    // (every 429 dropped the poll, so nobody advanced the settled room).
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    // Keyed by player AND IP, not player alone: rateLimit appends the client
    // IP to every key (lib/security.ts), so a household or venue on one NAT
    // DOES share a bucket per identity. Survivable now the poll holds for 15s
    // rather than 2s, but it is not the per-player isolation an earlier
    // comment here claimed. The poll worker IS the round keeper — a starved
    // poll freezes a settled table at 0:00 — so keep the budget comfortably
    // above what one live round costs.
    // 2s holds cost ~30 req/min per tab at idle. 120 left almost no headroom
    // once a round's version bumps made polls return early, and the bucket is
    // shared by every tab behind one NAT (see above), so a household hit 429s
    // and froze mid-flight. 300 keeps ~10x headroom for one player and still
    // bounds abuse well below what a scripted client could do.
    const limited = rateLimit(req, { key: `playtest-room-updates:${identity.id}`, limit: 300, windowMs: 60_000 });
    if (limited) return limited;
    const { roomId } = await context.params;
    if (!UUID.test(roomId)) return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    const url = new URL(req.url);
    const after = url.searchParams.get("after") || "-1";
    if (!/^-?\d{1,20}$/.test(after)) return publicJson({ error: "BAD_VERSION", message: "Invalid room version." }, 400);
    // A short heartbeat is an economic UX boundary, not decorative traffic:
    // it lets clients interpolate smoothly while bounding how far a stale
    // tab may visually run ahead of authoritative server time.
    //
    // This number is load-bearing for the ANIMATION, not just for traffic.
    //
    // PrivateLiveClock may extrapolate at most maxPredictionLeadMs (2,500ms)
    // past the newest server heartbeat, then it freezes -- deliberately, so a
    // stalled tab cannot invent a multiplier. A running round does NOT bump
    // the room version (nothing writes between start and tick; see
    // playtestRoomPollState), so the ONLY heartbeat mid-flight is this
    // poll returning. Hold longer than the prediction lead and the client
    // starves: the multiplier stops dead at exp(0.22 * 2.5) = 1.73x, every
    // single round, which is exactly what the owner reported.
    //
    // The earlier 2s was too short for a different reason -- the client
    // re-polls with no success-path delay, so a round whose version DOES
    // change (tick, settle) span-looped at RTT speed into the 120/min limit.
    // 2,000ms sits under the 2,500ms lead with margin for one RTT, and an
    // idle tab costs ~30 req/min against a limit now raised to match.
    const deadline = Date.now() + 2_000;
    let state = await playtestRoomPollState(identity, roomId);
    while (!req.signal.aborted && state.version === after && Date.now() < deadline) {
      if (state.due) {
        // The long-poll worker is the blind keeper: clients receive neither
        // crashAt nor a "due" bit. Concurrent workers safely converge through
        // the room row lock and idempotent settlement transaction.
        try { await tickPlaytestRound(identity, roomId, randomUUID()); } catch (error) {
          if (!(error instanceof PlaytestRoomError) || !["ROUND_ACTIVE", "NOT_RUNNING", "NOT_READY", "INTERMISSION_ACTIVE", "MINIMUM_PLAYERS"].includes(error.code)) throw error;
        }
        state = await playtestRoomPollState(identity, roomId);
        if (state.version !== after) break;
      }
      await pause(250, req.signal);
      if (!req.signal.aborted) state = await playtestRoomPollState(identity, roomId);
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    if (state.version === after) return publicJson({ unchanged: true, version: state.version, serverNow: new Date().toISOString() });
    return publicJson({ unchanged: false, snapshot: await playtestRoomSnapshot(identity, roomId) });
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "Could not resume room updates.");
  }
}
