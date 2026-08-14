import { claimReferral, REFERRAL_ENABLED } from "@/lib/referral-server";
import type { WalletProof } from "@/lib/wallet-proof";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  referredWallet?: unknown;
  /** Opaque invite code, or a raw 0x address from a pre-code link. */
  ref?: unknown;
  /** Accepted for links minted before opaque codes existed. */
  referrerWallet?: unknown;
  proof?: unknown;
};

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
    // `ref` is the invite as the user saw it — an opaque code, or a raw
    // address from a link minted before codes existed. `referrerWallet` is
    // the old field name, still accepted so an early link keeps working.
    const ref =
      typeof body.ref === "string" && body.ref.trim()
        ? body.ref.trim()
        : typeof body.referrerWallet === "string"
          ? body.referrerWallet.trim()
          : "";
    if (!referredWallet || !ref) {
      throw new TradeApiError(400, "MISSING_REF", "referredWallet and ref are both required.");
    }

    // The referred wallet must PROVE it controls the address being
    // attributed. Attribution is permanent and has no repair path, so an
    // unproven claim is a land-grab someone else can never undo -- see
    // lib/referral-server.ts's verifyReferralProof for the full reasoning.
    const proof = parseProof(body.proof);

    const result = await claimReferral(referredWallet, ref, proof);
    return publicJson(result);
  } catch (err) {
    return publicError(err, "Unexpected error recording referral.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
