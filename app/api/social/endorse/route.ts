import {
  endorseTarget,
  unendorseTarget,
  type EndorsementTargetType,
} from "@/lib/social-endorsements";
import type { WalletProof } from "@/lib/wallet-proof";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type EndorseBody = {
  voterWallet?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  action?: unknown;
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

function parseTargetType(raw: unknown): EndorsementTargetType {
  if (raw === "wallet" || raw === "collection") return raw;
  throw new TradeApiError(400, "BAD_TARGET_TYPE", "targetType must be 'wallet' or 'collection'.");
}

/**
 * Endorse a wallet or collection ("I back this"). Wallet-proof verified with
 * its own domain (lib/social-endorsements.ts's WALLET_PROOF_DOMAIN =
 * "social-endorsements"), distinct from plank-checks and social-badges so a
 * captured signature can never be replayed across features.
 *
 * Storage enforces one live endorsement per (voter, target) pair (migration
 * 008's UNIQUE constraint) — POST is idempotent, calling it again for an
 * already-endorsed target is a no-op, not an error.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "social-endorse", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<EndorseBody>(req);
    const voterWallet = typeof body.voterWallet === "string" ? body.voterWallet.trim() : "";
    if (!HEX_ADDRESS.test(voterWallet)) {
      throw new TradeApiError(400, "BAD_VOTER", "Valid voter wallet address required.");
    }
    const targetType = parseTargetType(body.targetType);
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    if (!targetId) throw new TradeApiError(400, "BAD_TARGET", "targetId required.");
    const action = body.action === "unendorse" ? "unendorse" : "endorse";
    const proof = parseProof(body.proof);

    const result =
      action === "unendorse"
        ? await unendorseTarget(voterWallet, targetType, targetId, proof)
        : await endorseTarget(voterWallet, targetType, targetId, proof);

    if (!result.ok) {
      const status = result.error === "BAD_PROOF" ? 401 : 400;
      throw new TradeApiError(status, result.error, "Endorsement request rejected.");
    }

    return publicJson({ ok: true, action });
  } catch (err) {
    return publicError(err, "Failed to record endorsement.");
  }
}
