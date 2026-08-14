import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { getReferralInfo, revokeReferral } from "@/lib/referral-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Body = { referredWallet?: unknown; auth?: unknown };

/**
 * Admin correction path for referral attribution — REVOKE only.
 *
 * Attribution is permanent by construction and every row is signed by the
 * wallet it names (lib/referral-server.ts). Without any correction path, the
 * first person who confirms an invite they regret can only be helped by
 * hand-written SQL against production. With an UPDATE path, an operator
 * could silently hand an attribution to a referrer of their choosing and the
 * "every row was signed by its wallet" property would be false.
 *
 * Revoking is the shape that resolves both: it clears the row, and the only
 * way that wallet gets a new referrer afterwards is the normal flow — the
 * user signing a fresh claim. Deliberately NOT wired into any UI; this is an
 * operator tool, logged like every other admin action.
 *
 * DELETE, not POST, because that is exactly what it does.
 */
export async function DELETE(req: Request) {
  try {
    const limited = rateLimit(req, { key: "admin-referral-revoke", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<Body>(req);
    const referredWallet =
      typeof body.referredWallet === "string" ? body.referredWallet.trim() : "";
    if (!HEX_ADDRESS.test(referredWallet)) {
      throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "Valid referredWallet required.");
    }

    // Shape-check before verifying: verifyAdminProof reads fields off the
    // proof, so handing it an absent or malformed `auth` throws and surfaces
    // as a 500 — an unauthenticated caller must get a clean 401, not a
    // server error that looks like we broke.
    const auth = body.auth;
    if (
      !auth ||
      typeof auth !== "object" ||
      typeof (auth as Record<string, unknown>).address !== "string" ||
      typeof (auth as Record<string, unknown>).timestamp !== "number" ||
      typeof (auth as Record<string, unknown>).signature !== "string"
    ) {
      throw new TradeApiError(401, "BAD_PROOF", "Admin signature required.");
    }

    // The signed payload names the exact wallet being revoked, so a captured
    // admin signature cannot be replayed against a different one.
    const verdict = verifyAdminProof(
      "referral-revoke",
      JSON.stringify({ referredWallet: referredWallet.toLowerCase() }),
      auth as AdminProof
    );
    if (!verdict.ok) {
      const status = verdict.error === "UNAUTHORIZED" ? 403 : 401;
      return publicJson(
        {
          error: verdict.error,
          message:
            verdict.error === "STALE"
              ? "Signature expired — sign again."
              : verdict.error === "UNAUTHORIZED"
                ? "This wallet is not an admin."
                : "Could not verify admin signature.",
        },
        status
      );
    }

    // Captured before the delete — after it the previous referrer is gone,
    // and an audit entry that cannot say what was undone is not an audit
    // entry.
    const before = await getReferralInfo(referredWallet);
    const result = await revokeReferral(referredWallet);

    await logAdminAction(
      verdict.address,
      "referral-revoke",
      `${referredWallet.toLowerCase()} previously referred by ${before.referredBy ?? "(none)"}${
        result.revoked ? "" : " — nothing on file, no-op"
      }`
    );

    return publicJson({ ok: true, ...result, previousReferrer: before.referredBy });
  } catch (err) {
    return publicError(err, "Failed to revoke referral attribution.");
  }
}
