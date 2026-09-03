import { currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import { archivePlaytestRoom, playtestRoomPollState, playtestRoomSnapshot, PlaytestRoomError, tickPlaytestRound } from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    // Per signed-in player (not per IP) so devices sharing a network never
    // starve each other's table reads.
    const limited = rateLimit(req, { key: `playtest-room-snapshot:${identity.id}`, limit: 180, windowMs: 60_000 });
    if (limited) return limited;
    const { roomId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
      return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    }
    // Any member's snapshot read also drives the round keeper when the room is
    // due (a running round past its crash point, or a settled intermission
    // past 30s). Progression must never depend on a long-poll surviving —
    // the same idempotent, row-locked transaction the long-poll worker uses.
    const state = await playtestRoomPollState(identity, roomId);
    if (state.due) {
      try { await tickPlaytestRound(identity, roomId, randomUUID()); } catch (error) {
        if (!(error instanceof PlaytestRoomError) || !["ROUND_ACTIVE", "NOT_RUNNING", "NOT_READY", "INTERMISSION_ACTIVE", "MINIMUM_PLAYERS"].includes(error.code)) throw error;
      }
    }
    return publicJson(await playtestRoomSnapshot(identity, roomId));
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "Could not read the game room.");
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-room-archive", limit: 20, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    const { roomId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
      return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    }
    return publicJson(await archivePlaytestRoom(identity, roomId));
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "Could not archive the game room.");
  }
}
