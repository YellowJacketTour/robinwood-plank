/**
 * Manual marketplace-points grant -- the one legitimate manual write into
 * the Plank Checks ledger (lib/plank-checks.ts's "admin_grant" category,
 * recordManualGrant's own header on why this route IS a safe caller of
 * recordPointEvent despite that module's blanket trusted-caller warning:
 * the trust boundary is real admin wallet authentication, checked here
 * before anything is written, not client-supplied data taken on faith).
 */
import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { consumeAdminProof } from "@/lib/admin-proof-nonce";
import { logAdminAction } from "@/lib/admin-log";
import { recordManualGrant } from "@/lib/plank-checks";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_GRANT_POINTS = 1_000_000; // one ceiling per grant -- a real ceiling, not unlimited, so a compromised/misused admin key can't mint an arbitrary amount in one call

type Body = { wallet?: unknown; points?: unknown; reason?: unknown; auth?: unknown };

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "admin-points-grant", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<Body>(req);
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!HEX_ADDRESS.test(wallet)) {
      throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "Valid wallet address required.");
    }
    const points = typeof body.points === "number" ? body.points : Number.NaN;
    if (!Number.isFinite(points) || points <= 0 || points > MAX_GRANT_POINTS) {
      throw new TradeApiError(400, "BAD_POINTS", `Points must be a positive number up to ${MAX_GRANT_POINTS}.`);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 500) {
      throw new TradeApiError(400, "BAD_REASON", "A reason (1-500 chars) is required for every manual grant.");
    }

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

    // Must match the client's EXACT JSON.stringify key order/values -- see
    // components/admin/api.ts's grantPoints.
    const verdict = verifyAdminProof(
      "points-grant",
      JSON.stringify({ wallet: wallet.toLowerCase(), points, reason }),
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

    // SINGLE-USE (audit finding M2). verifyAdminProof is stateless, so a
    // captured-but-valid request could otherwise be replayed for the full
    // 5-minute window, minting the grant again each time -- and this
    // ledger's own (source_tx_hash, ...) dedup index does not apply to
    // admin_grant rows, which carry no tx hash. Consumed BEFORE the grant,
    // and fails closed.
    const fresh = await consumeAdminProof("points-grant", verdict.address, (auth as AdminProof).signature);
    if (!fresh) {
      return publicJson(
        { error: "REPLAY", message: "This request was already submitted — sign a new one." },
        409
      );
    }

    await recordManualGrant({ wallet, points, grantedBy: verdict.address, reason });
    await logAdminAction(verdict.address, "points-grant", `${points} points to ${wallet.toLowerCase()} — ${reason}`);

    return publicJson({ ok: true });
  } catch (err) {
    return publicError(err, "Failed to grant points.");
  }
}
