import { getOrCreateReferralCode } from "@/lib/referral-codes";
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

    // The code is allocated here, on first view, rather than by a dedicated
    // endpoint: a wallet's code only matters once someone looks at their own
    // invite panel, and one round trip beats two. Stable once created, so a
    // link that has already been shared keeps resolving forever.
    const [info, code] = await Promise.all([
      getReferralInfo(wallet),
      getOrCreateReferralCode(wallet),
    ]);
    return publicJson({ ...info, code });
  } catch (err) {
    return publicError(err, "Unexpected error reading referral info.");
  }
}
