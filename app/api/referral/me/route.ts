import { getReferralInfo, REFERRAL_ENABLED } from "@/lib/referral-server";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "referral-me", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!REFERRAL_ENABLED) {
      throw new TradeApiError(404, "REFERRAL_DISABLED", "Referral tracking is not enabled.");
    }

    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet") ?? "";
    if (!wallet) {
      throw new TradeApiError(400, "MISSING_WALLET_ADDRESS", "wallet query param is required.");
    }

    const info = await getReferralInfo(wallet);
    return publicJson(info);
  } catch (err) {
    return publicError(err, "Unexpected error reading referral info.");
  }
}
