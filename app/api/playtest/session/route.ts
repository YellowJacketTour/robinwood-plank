import { cookies } from "next/headers";
import { clearSessionCookie, currentPlaytestIdentity, playtestMutationOriginAllowed, PLAYTEST_SESSION_COOKIE, revokeSession } from "@/lib/playtest-auth";
import { publicError, publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return publicJson({ identity: await currentPlaytestIdentity() });
  } catch (error) {
    return publicError(error, "Could not read playtest session.");
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
