import { currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import { createPlaytestRoom, joinPlaytestRoom, listPlaytestRooms, PlaytestRoomError } from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function roomError(error: unknown) {
  return error instanceof PlaytestRoomError
    ? publicJson({ error: error.code, message: error.message }, error.status)
    : publicError(error, "The game laboratory could not complete that request.");
}

export async function GET() {
  try {
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    return publicJson({ rooms: await listPlaytestRooms(identity) });
  } catch (error) { return roomError(error); }
}

export async function POST(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-rooms", limit: 30, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Playtest PIN sign-in required." }, 401);
    const body = await readJsonBody<{ action?: unknown; name?: unknown; code?: unknown }>(req);
    if (body.action === "create" && typeof body.name === "string") {
      return publicJson(await createPlaytestRoom(identity, body.name), 201);
    }
    if (body.action === "join" && typeof body.code === "string") {
      return publicJson(await joinPlaytestRoom(identity, body.code));
    }
    return publicJson({ error: "BAD_REQUEST", message: "Choose create or join." }, 400);
  } catch (error) { return roomError(error); }
}
