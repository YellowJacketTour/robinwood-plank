import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { createCeremony, playtestMutationOriginAllowed, playtestPasskeysEnabled, playtestRp } from "@/lib/playtest-auth";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!playtestPasskeysEnabled()) return publicJson({ error: "PASSKEYS_DISABLED", message: "Use the playtest PIN entrance." }, 404);
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-passkey-auth", limit: 15, windowMs: 60_000 });
    if (limited) return limited;
    const rp = playtestRp();
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      timeout: 300_000,
      userVerification: "required",
      allowCredentials: [],
    });
    const ceremonyId = await createCeremony("authenticate", options.challenge);
    return publicJson({ ceremonyId, options });
  } catch (error) {
    return publicError(error, "Could not begin passkey authentication.");
  }
}
