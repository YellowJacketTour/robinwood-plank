import { createRoomInvite, currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-invites", limit: 20, windowMs: 60 * 60_000 });
    if (limited) return limited;
    const identity = await currentPlaytestIdentity();
    if (!identity?.isAdmin) return publicJson({ error: "ADMIN_ONLY", message: "Host account required." }, 403);
    const body = await readJsonBody<{ roomId?: unknown }>(req);
    const roomId = typeof body.roomId === "string" ? body.roomId : null;
    const token = await createRoomInvite(identity, roomId);
    const origin = new URL(req.url).origin;
    return publicJson({ url: `${origin}/playtest?invite=${encodeURIComponent(token)}` }, 201);
  } catch (error) { return publicError(error, "Could not create an invitation."); }
}
