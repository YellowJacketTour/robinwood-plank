import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { consumeCeremony, createSession, playtestMutationOriginAllowed, playtestPasskeysEnabled, playtestRp, sessionCookie } from "@/lib/playtest-auth";
import { postgresQuery } from "@/lib/postgres";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PasskeyRow = {
  credential_id: string; user_id: string; public_key: Buffer; counter: string;
  transports: string[]; display_name: string;
};

export async function POST(req: Request) {
  try {
    if (!playtestPasskeysEnabled()) return publicJson({ error: "PASSKEYS_DISABLED", message: "Use the playtest PIN entrance." }, 404);
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-passkey-auth-verify", limit: 20, windowMs: 60_000 });
    if (limited) return limited;
    const body = await readJsonBody<{ ceremonyId?: unknown; response?: unknown }>(req);
    if (typeof body.ceremonyId !== "string" || !body.response || typeof body.response !== "object") {
      return publicJson({ error: "BAD_REQUEST", message: "Malformed authentication response." }, 400);
    }
    const credential = body.response as AuthenticationResponseJSON;
    const ceremony = await consumeCeremony(body.ceremonyId, "authenticate");
    if (!ceremony) return publicJson({ error: "CEREMONY_EXPIRED", message: "Authentication expired or was already used." }, 409);
    const found = await postgresQuery<PasskeyRow>(
      `SELECT p.credential_id, p.user_id, p.public_key, p.counter::text, p.transports, u.display_name
         FROM playtest_passkeys p JOIN playtest_users u ON u.id = p.user_id
        WHERE p.credential_id = $1 AND u.disabled_at IS NULL`,
      [credential.id]
    );
    const passkey = found.rows[0];
    if (!passkey) return publicJson({ error: "UNKNOWN_PASSKEY", message: "This passkey is not invited." }, 401);
    const rp = playtestRp();
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: Uint8Array.from(passkey.public_key),
        counter: Number(passkey.counter),
        transports: passkey.transports as never,
      },
    });
    if (!verification.verified) return publicJson({ error: "NOT_VERIFIED", message: "Passkey verification failed." }, 401);
    await postgresQuery(
      `UPDATE playtest_passkeys SET counter = $2, last_used_at = NOW() WHERE credential_id = $1`,
      [passkey.credential_id, verification.authenticationInfo.newCounter]
    );
    const token = await createSession(passkey.user_id);
    const response = publicJson({ ok: true, displayName: passkey.display_name });
    response.headers.append("Set-Cookie", sessionCookie(token));
    return response;
  } catch (error) {
    return publicError(error, "Could not authenticate passkey.");
  }
}
