import { cleanDisplayName, cleanPin, createPlaytestCohost, currentPlaytestIdentity, playtestMutationOriginAllowed } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-create-cohost", limit: 5, windowMs: 60 * 60_000 });
    if (limited) return limited;
    const actor = await currentPlaytestIdentity();
    if (!actor?.isAdmin) return publicJson({ error: "ADMIN_ONLY", message: "Host account required." }, 403);
    const body = await readJsonBody<{ displayName?: unknown; pin?: unknown }>(req);
    const displayName = cleanDisplayName(body.displayName);
    const pin = cleanPin(body.pin, 6);
    if (!displayName || !pin) return publicJson({ error: "BAD_ACCOUNT", message: "Use a unique username and exactly six PIN digits." }, 400);
    const identity = await createPlaytestCohost(actor, displayName, pin);
    return publicJson({ displayName: identity.displayName, isAdmin: true }, 201);
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") return publicJson({ error: "NAME_TAKEN", message: "That username is already taken." }, 409);
    return publicError(error, "Could not create the co-host account.");
  }
}
