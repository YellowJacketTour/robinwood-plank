import { claimReferral, REFERRAL_ENABLED } from "@/lib/referral-server";
import type { WalletProof } from "@/lib/wallet-proof";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { referredWallet?: unknown; referrerWallet?: unknown; proof?: unknown };

function parseProof(raw: unknown): WalletProof {
  if (!raw || typeof raw !== "object") {
    throw new TradeApiError(400, "BAD_PROOF", "Wallet proof required.");
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.address !== "string" ||
    typeof obj.timestamp !== "number" ||
    typeof obj.signature !== "string"
  ) {
    throw new TradeApiError(400, "BAD_PROOF", "Malformed wallet proof.");
  }
  return { address: obj.address, timestamp: obj.timestamp, signature: obj.signature };
}

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

    // The referred wallet must PROVE it controls the address being
    // attributed. Attribution is permanent and has no repair path, so an
    // unproven claim is a land-grab someone else can never undo -- see
    // lib/referral-server.ts's verifyReferralProof for the full reasoning.
    const proof = parseProof(body.proof);

    const result = await claimReferral(referredWallet, referrerWallet, proof);
    return publicJson(result);
  } catch (err) {
    return publicError(err, "Unexpected error recording referral.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
