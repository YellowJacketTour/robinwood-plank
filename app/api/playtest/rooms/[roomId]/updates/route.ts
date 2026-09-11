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
    const limited = rateLimit(req, { key: `playtest-room-updates:${identity.id}`, limit: 120, windowMs: 60_000 });
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
    // 2s was the wrong number and it rate-limited live tables. The client
    // re-polls immediately on every return (crash.html's update loop has no
    // success-path delay), so an idle tab spent ~30 req/min of its 120/min
    // budget, and a LIVE round -- where the version changes every tick, so
    // every poll returns at once -- ran a tight fetch loop bounded only by
    // RTT. At 100ms that is ~600 req/min: the round going live is precisely
    // what pushed the table over its own ceiling, and the player got up to a
    // 20s "Table busy" blackout mid-flight. 15s matches the surrounding
    // comment's own claim, sits inside maxDuration=30, and leaves an idle tab
    // at ~4 req/min. A changed version still returns instantly, so this
    // lengthens only the NO-CHANGE wait -- responsiveness is unaffected.
    const deadline = Date.now() + 15_000;
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
