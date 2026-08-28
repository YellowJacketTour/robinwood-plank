import { cookies } from "next/headers";
import { adminConfigured, authenticatePersonalPin, bootstrapAdmin, cleanDisplayName, cleanPin, clearSessionCookie, currentPlaytestIdentity, playtestBootstrapAllowed, playtestMutationOriginAllowed, registerFromInvite, PLAYTEST_SESSION_COOKIE, revokeSession, sessionCookie } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return publicJson({ identity: await currentPlaytestIdentity(), adminConfigured: await adminConfigured() });
  } catch (error) {
    return publicError(error, "Could not read playtest session.");
  }
}

export async function POST(req: Request) {
  try {
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-pin-login", limit: 8, windowMs: 15 * 60_000 });
    if (limited) return limited;
    const body = await readJsonBody<{ action?: unknown; displayName?: unknown; pin?: unknown; invite?: unknown; setup?: unknown }>(req);
    const displayName = cleanDisplayName(body.displayName);
    if (!displayName) return publicJson({ error: "BAD_NAME", message: "Choose a username between 1 and 40 characters." }, 400);
    let authenticated;
    if (body.action === "bootstrap") {
      if (!playtestBootstrapAllowed(body.setup)) return publicJson({ error: "SETUP_REQUIRED", message: "A valid private host setup link is required." }, 403);
      const pin = cleanPin(body.pin, 6);
      if (!pin) return publicJson({ error: "BAD_PIN", message: "The host PIN must contain exactly six digits." }, 400);
      authenticated = await bootstrapAdmin(displayName, pin);
    } else if (body.action === "register") {
      const pin = cleanPin(body.pin, 4);
      if (!pin || typeof body.invite !== "string" || body.invite.length < 20) return publicJson({ error: "BAD_INVITE", message: "Use a valid invitation and four-digit PIN." }, 400);
      authenticated = await registerFromInvite(displayName, pin, body.invite);
    } else {
      const pin = typeof body.pin === "string" && /^\d{4}(?:\d{2})?$/.test(body.pin) ? body.pin : null;
      if (!pin) return publicJson({ error: "BAD_PIN", message: "Enter your personal PIN." }, 400);
      authenticated = await authenticatePersonalPin(displayName, pin);
      if (!authenticated) return publicJson({ error: "BAD_PIN", message: "Username or PIN is incorrect." }, 401);
    }
    const { identity, token } = authenticated;
    const response = publicJson({ displayName: identity.displayName, isAdmin: identity.isAdmin }, 201);
    response.headers.append("Set-Cookie", sessionCookie(token));
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_ALREADY_CONFIGURED") return publicJson({ error: "ADMIN_ALREADY_CONFIGURED", message: "The host account has already been claimed." }, 409);
    if (error instanceof Error && error.message === "INVITE_INVALID") return publicJson({ error: "INVITE_INVALID", message: "That invitation is invalid, expired, or already used." }, 401);
    if (typeof error === "object" && error && "code" in error && error.code === "23505") return publicJson({ error: "NAME_TAKEN", message: "That username is already taken." }, 409);
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
