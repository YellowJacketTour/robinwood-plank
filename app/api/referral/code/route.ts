import { getOrCreateReferralCode } from "@/lib/referral-codes";
import { REFERRAL_ENABLED } from "@/lib/referral-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Body = { wallet?: unknown };

/**
 * Issue this wallet's invite code. POST because it writes.
 *
 * Deliberately NOT called "minting": on this site that word means the NFT
 * mint (app/mint, lib/mint-contract.ts, and every mint event the chain
 * indexer parses). Borrowing it for a database row would collide with a real
 * domain concept the moment anyone greps for it.
 *
 * This used to happen inside GET /api/referral/me, which takes any wallet
 * from a query string — so reading someone's referral info created a row for
 * them, and an attacker with a list of addresses could grow the table
 * through a public read. Splitting it out keeps the read a read and puts the
 * write behind its own, much tighter limit.
 *
 * NO wallet proof, deliberately. A code grants nothing: it is a public
 * pointer that credits its owner when someone else uses it, so issuing one
 * for a wallet you do not control hands that wallet a referral link and
 * takes nothing from anyone. The real cost of abuse is junk rows, and a rate
 * limit is the proportionate control for that — a signature here would be
 * friction on the one action a growth feature depends on, buying a security
 * property that is not actually at stake.
 *
 * Idempotent: a wallet's code is stable once allocated, so repeat calls
 * return the same value rather than rotating a link that may already have
 * been shared.
 */
export async function POST(req: Request) {
  try {
    // Tighter than the 60/min reads: this one writes, and nothing legitimate
    // needs it more than once per wallet in the lifetime of that wallet.
    const limited = rateLimit(req, { key: "referral-code-issue", limit: 10, windowMs: 60_000 });
    if (limited) return limited;

    if (!REFERRAL_ENABLED) {
      throw new TradeApiError(404, "REFERRAL_DISABLED", "Referral tracking is not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!HEX_ADDRESS.test(wallet)) {
      throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "Valid wallet address required.");
    }

    const code = await getOrCreateReferralCode(wallet);
    return publicJson({ ok: true, code });
  } catch (err) {
    return publicError(err, "Failed to allocate a referral code.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
