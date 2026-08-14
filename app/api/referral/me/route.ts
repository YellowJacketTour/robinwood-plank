import { peekReferralCode } from "@/lib/referral-codes";
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

    // READ ONLY. Allocation lives in POST /api/referral/code, not here:
    // this route takes any wallet from a query string, so minting inside it
    // meant an unauthenticated public GET that writes, and one an attacker
    // could point at an enumerated list of addresses to grow the table
    // indefinitely. `code` is null until the owner's panel asks for one.
    const [info, code] = await Promise.all([
      getReferralInfo(wallet),
      peekReferralCode(wallet),
    ]);
    return publicJson({ ...info, code });
  } catch (err) {
    return publicError(err, "Unexpected error reading referral info.");
  }
}
