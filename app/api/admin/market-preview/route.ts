/**
 * Admin-only bypass for the market kill-switch -- see
 * lib/market-preview-auth.ts's own header for the full scheme. POST signs
 * in (issues the cookie), DELETE signs out (clears it). GET reports whether
 * PLANK_ADMIN_PREVIEW_SECRET is configured, so the console can disable the
 * control with a clear reason instead of failing silently on click.
 */
import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { consumeAdminProof } from "@/lib/admin-proof-nonce";
import { logAdminAction } from "@/lib/admin-log";
import {
  buildPreviewCookieValue,
  marketPreviewConfigured,
  MARKET_PREVIEW_COOKIE_MAX_AGE_S,
  MARKET_PREVIEW_COOKIE_NAME,
} from "@/lib/market-preview-auth";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { auth?: unknown };

export async function GET() {
  return publicJson({ configured: marketPreviewConfigured() });
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "admin-market-preview", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    if (!marketPreviewConfigured()) {
      throw new TradeApiError(503, "NOT_CONFIGURED", "PLANK_ADMIN_PREVIEW_SECRET is not set on this deploy.");
    }

    const body = await readJsonBody<Body>(req);
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

    // Payload is fixed (empty object) -- this action grants no data, just a
    // browsing bypass, so there's nothing per-request to bind beyond the
    // action name itself. Matches lib/admin-auth.ts's adminPayloadHash("{}").
    const verdict = verifyAdminProof("market-preview", "{}", auth as AdminProof);
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

    const fresh = await consumeAdminProof("market-preview", verdict.address, (auth as AdminProof).signature);
    if (!fresh) {
      return publicJson(
        { error: "REPLAY", message: "This request was already submitted — sign a new one." },
        409
      );
    }

    const cookieValue = buildPreviewCookieValue(verdict.address);
    if (!cookieValue) {
      throw new TradeApiError(503, "NOT_CONFIGURED", "PLANK_ADMIN_PREVIEW_SECRET is not set on this deploy.");
    }

    await logAdminAction(verdict.address, "market-preview", "enabled market preview bypass");

    const res = publicJson({ ok: true });
    res.headers.append(
      "Set-Cookie",
      `${MARKET_PREVIEW_COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${MARKET_PREVIEW_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`
    );
    return res;
  } catch (err) {
    return publicError(err, "Failed to enable market preview.");
  }
}

export async function DELETE() {
  const res = publicJson({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${MARKET_PREVIEW_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
  return res;
}
