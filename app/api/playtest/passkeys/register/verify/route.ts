import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { consumeCeremony, createSession, playtestMutationOriginAllowed, playtestPasskeysEnabled, playtestRp, sessionCookie } from "@/lib/playtest-auth";
import { withPostgresTransaction } from "@/lib/postgres";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!playtestPasskeysEnabled()) return publicJson({ error: "PASSKEYS_DISABLED", message: "Use the playtest PIN entrance." }, 404);
    if (!playtestMutationOriginAllowed(req)) return publicJson({ error: "BAD_ORIGIN", message: "Cross-origin request rejected." }, 403);
    const limited = rateLimit(req, { key: "playtest-passkey-register-verify", limit: 10, windowMs: 60_000 });
    if (limited) return limited;
    const body = await readJsonBody<{ ceremonyId?: unknown; response?: unknown }>(req);
    if (typeof body.ceremonyId !== "string" || !body.response || typeof body.response !== "object") {
      return publicJson({ error: "BAD_REQUEST", message: "Malformed registration response." }, 400);
    }
    const ceremony = await consumeCeremony(body.ceremonyId, "register");
    if (!ceremony?.userId || !ceremony.inviteHash || !ceremony.displayName) {
      return publicJson({ error: "CEREMONY_EXPIRED", message: "Registration expired or was already used." }, 409);
    }
    const rp = playtestRp();
    const verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified) return publicJson({ error: "NOT_VERIFIED", message: "Passkey verification failed." }, 401);

    const info = verification.registrationInfo;
    await withPostgresTransaction(async (client) => {
      await client.query(
        `INSERT INTO playtest_users (id, display_name, invite_hash) VALUES ($1, $2, $3)`,
        [ceremony.userId, ceremony.displayName, ceremony.inviteHash]
      );
      await client.query(
        `INSERT INTO playtest_passkeys
           (credential_id, user_id, public_key, counter, transports, device_type, backed_up)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [info.credential.id, ceremony.userId, Buffer.from(info.credential.publicKey), info.credential.counter,
          info.credential.transports || [], info.credentialDeviceType, info.credentialBackedUp]
      );
    });
    const token = await createSession(ceremony.userId);
    const response = publicJson({ ok: true, displayName: ceremony.displayName });
    response.headers.append("Set-Cookie", sessionCookie(token));
    return response;
  } catch (error) {
    return publicError(error, "Could not verify passkey registration.");
  }
}
