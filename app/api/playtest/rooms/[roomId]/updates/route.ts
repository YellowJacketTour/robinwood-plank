import { currentPlaytestIdentity } from "@/lib/playtest-auth";
import { playtestRoomSnapshot, playtestRoomVersion, PlaytestRoomError } from "@/lib/playtest-rooms";
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
    const limited = rateLimit(req, { key: "playtest-room-updates", limit: 90, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Passkey sign-in required." }, 401);
    const { roomId } = await context.params;
    if (!UUID.test(roomId)) return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    const url = new URL(req.url);
    const after = url.searchParams.get("after") || "-1";
    if (!/^-?\d{1,20}$/.test(after)) return publicJson({ error: "BAD_VERSION", message: "Invalid room version." }, 400);
    const deadline = Date.now() + 20_000;
    let version = await playtestRoomVersion(identity, roomId);
    while (!req.signal.aborted && version === after && Date.now() < deadline) {
      await pause(250, req.signal);
      if (!req.signal.aborted) version = await playtestRoomVersion(identity, roomId);
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    if (version === after) return publicJson({ unchanged: true, version, serverNow: new Date().toISOString() });
    return publicJson({ unchanged: false, snapshot: await playtestRoomSnapshot(identity, roomId) });
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "Could not resume room updates.");
  }
}
