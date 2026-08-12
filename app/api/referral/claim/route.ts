import { claimReferral, REFERRAL_ENABLED } from "@/lib/referral-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { referredWallet?: unknown; referrerWallet?: unknown };

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "referral-claim", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    if (!REFERRAL_ENABLED) {
      throw new TradeApiError(404, "REFERRAL_DISABLED", "Referral tracking is not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const referredWallet = typeof body.referredWallet === "string" ? body.referredWallet.trim() : "";
    const referrerWallet = typeof body.referrerWallet === "string" ? body.referrerWallet.trim() : "";
    if (!referredWallet || !referrerWallet) {
      throw new TradeApiError(400, "MISSING_WALLET_ADDRESS", "referredWallet and referrerWallet are both required.");
    }

    const result = await claimReferral(referredWallet, referrerWallet);
    return publicJson(result);
  } catch (err) {
    return publicError(err, "Unexpected error recording referral.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
