import { currentPlaytestIdentity } from "@/lib/playtest-auth";
import { playtestCommandReceipt, playtestRoomEvents, PlaytestRoomError } from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    const limited = rateLimit(req, { key: "playtest-room-replay", limit: 30, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    const { roomId } = await context.params;
    if (!UUID.test(roomId)) return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    const url = new URL(req.url);
    const commandId = url.searchParams.get("commandId");
    if (commandId) {
      if (!UUID.test(commandId)) return publicJson({ error: "BAD_COMMAND_ID", message: "Invalid command identifier." }, 400);
      return publicJson({ commandId, receipt: await playtestCommandReceipt(identity, roomId, commandId) });
    }
    const afterRaw = url.searchParams.get("after") || "0";
    const limitRaw = url.searchParams.get("limit") || "1000";
    if (!/^\d{1,20}$/.test(afterRaw) || !/^\d{1,4}$/.test(limitRaw)) {
      return publicJson({ error: "BAD_CURSOR", message: "Invalid replay cursor." }, 400);
    }
    const events = await playtestRoomEvents(identity, roomId, BigInt(afterRaw), Number(limitRaw));
    return publicJson({ schema: "plank.live-lab.replay.v1", roomId, after: afterRaw, events, nextAfter: events.at(-1)?.sequence ?? afterRaw });
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "Could not export the room replay.");
  }
}
