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
    // Keyed per signed-in player, not per IP: a household or venue on one NAT
    // must never starve each other's long-poll (the poll worker IS the round
    // keeper — starved polls froze settled tables at 0:00). 120/min per player
    // still bounds abuse; a long-poll returns at most every 20s or on change.
    const limited = rateLimit(req, { key: `playtest-room-updates:${identity.id}`, limit: 120, windowMs: 60_000 });
    if (limited) return limited;
    const { roomId } = await context.params;
    if (!UUID.test(roomId)) return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    const url = new URL(req.url);
    const after = url.searchParams.get("after") || "-1";
    if (!/^-?\d{1,20}$/.test(after)) return publicJson({ error: "BAD_VERSION", message: "Invalid room version." }, 400);
    const deadline = Date.now() + 20_000;
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
