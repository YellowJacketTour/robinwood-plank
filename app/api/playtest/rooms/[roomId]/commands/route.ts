import { currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import {
  lockPlaytestBet, placePlaytestBet, PlaytestRoomError,
  settlePlaytestRound, startPlaytestRound, tickPlaytestRound,
} from "@/lib/playtest-rooms";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CommandBody = {
  action?: unknown; commandId?: unknown; stake?: unknown;
  targetBps?: unknown; lotteryOutcome?: unknown;
};

function integer(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw new PlaytestRoomError(400, "BAD_INTEGER", `${field} must be an integer string.`);
  }
  return BigInt(value);
}

export async function POST(req: Request, context: { params: Promise<{ roomId: string }> }) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-room-command", limit: 120, windowMs: 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity) return publicJson({ error: "UNAUTHENTICATED", message: "Passkey sign-in required." }, 401);
    const body = await readJsonBody<CommandBody>(req);
    if (typeof body.commandId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.commandId)) {
      return publicJson({ error: "BAD_COMMAND_ID", message: "A UUID command ID is required." }, 400);
    }
    const { roomId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
      return publicJson({ error: "BAD_ROOM_ID", message: "Invalid room identifier." }, 400);
    }
    let result: unknown;
    if (body.action === "bet") {
      result = await placePlaytestBet(identity, roomId, body.commandId, integer(body.stake, "stake"), integer(body.targetBps, "targetBps"));
    } else if (body.action === "start") {
      result = await startPlaytestRound(identity, roomId, body.commandId);
    } else if (body.action === "lock") {
      result = await lockPlaytestBet(identity, roomId, body.commandId);
    } else if (body.action === "settle" && ["none", "miss", "hit"].includes(String(body.lotteryOutcome))) {
      result = await settlePlaytestRound(identity, roomId, body.commandId, body.lotteryOutcome as "none" | "miss" | "hit");
    } else if (body.action === "tick") {
      result = await tickPlaytestRound(identity, roomId, body.commandId);
    } else {
      return publicJson({ error: "BAD_ACTION", message: "Unknown laboratory command." }, 400);
    }
    return publicJson({ ok: true, result });
  } catch (error) {
    return error instanceof PlaytestRoomError
      ? publicJson({ error: error.code, message: error.message }, error.status)
      : publicError(error, "The game command failed.");
  }
}
