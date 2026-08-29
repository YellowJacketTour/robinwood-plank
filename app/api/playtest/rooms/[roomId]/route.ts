import { currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import { archivePlaytestRoom, playtestRoomSnapshot, PlaytestRoomError } from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    const limited = rateLimit(req, { key: "playtest-room-snapshot", limit: 180, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    const { roomId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
      return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
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
