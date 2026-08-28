import { randomUUID } from "node:crypto";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { cleanDisplayName, createCeremony, inviteAllowed, normalizeInvite, playtestMutationOriginAllowed, playtestPasskeysEnabled, playtestRp, sha256 } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!playtestPasskeysEnabled()) return publicJson({ error: "PASSKEYS_DISABLED", message: "Use the playtest PIN entrance." }, 404);
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-passkey-register", limit: 8, windowMs: 60_000 });
    if (limited) return limited;
    const body = await readJsonBody<{ invite?: unknown; displayName?: unknown }>(req);
    const invite = typeof body.invite === "string" ? normalizeInvite(body.invite) : "";
    const displayName = cleanDisplayName(body.displayName);
    if (!displayName || !inviteAllowed(invite)) {
      return publicJson({ error: "INVALID_INVITE", message: "A valid unused invitation and display name are required." }, 403);
    }

    const userId = randomUUID();
    const rp = playtestRp();
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: userId,
      userID: Uint8Array.from(Buffer.from(userId.replaceAll("-", ""), "hex")),
      userDisplayName: displayName,
      attestationType: "none",
      timeout: 300_000,
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      preferredAuthenticatorType: "localDevice",
    });
    const ceremonyId = await createCeremony("register", options.challenge, {
      userId,
      inviteHash: sha256(invite),
      displayName,
    });
    return publicJson({ ceremonyId, options });
  } catch (error) {
    return publicError(error, "Could not begin passkey registration.");
  }
}
