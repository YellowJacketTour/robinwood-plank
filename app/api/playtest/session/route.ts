import { cookies } from "next/headers";
import { cleanDisplayName, clearSessionCookie, createPinIdentity, currentPlaytestIdentity, playtestMutationOriginAllowed, playtestPinRole, PLAYTEST_SESSION_COOKIE, revokeSession, sessionCookie } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return publicJson({ identity: await currentPlaytestIdentity() });
  } catch (error) {
    return publicError(error, "Could not read playtest session.");
  }
}

export async function POST(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-pin-login", limit: 8, windowMs: 15 * 60_000 });
    if (limited) return limited;
    const body = await readJsonBody<{ displayName?: unknown; pin?: unknown }>(req);
    const displayName = cleanDisplayName(body.displayName);
    if (!displayName) return publicJson({ error: "BAD_NAME", message: "Choose a username between 1 and 40 characters." }, 400);
    const role = playtestPinRole(body.pin);
    if (!role) return publicJson({ error: "BAD_PIN", message: "That playtest PIN is not valid." }, 401);
    const { identity, token } = await createPinIdentity(displayName, role === "admin");
    const response = publicJson({ displayName: identity.displayName, isAdmin: identity.isAdmin }, 201);
    response.headers.append("Set-Cookie", sessionCookie(token));
    return response;
  } catch (error) {
    return publicError(error, "Could not enter the playtest.");
  }
}

export async function DELETE(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const token = (await cookies()).get(PLAYTEST_SESSION_COOKIE)?.value;
    await revokeSession(token);
    const response = publicJson({ ok: true });
    response.headers.append("Set-Cookie", clearSessionCookie());
    return response;
  } catch (error) {
    return publicError(error, "Could not end playtest session.");
  }
}
