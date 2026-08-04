import { id as keccakId, verifyMessage } from "ethers";

/**
 * Generic wallet-signature verification, for any feature that needs "prove
 * you control this address" without a session/cookie and without an
 * on-chain transaction. Deliberately the same shape as
 * lib/admin-auth.ts's verifyAdminProof — that file is not reused directly
 * because its existing tests (test/market/woodamp-playlist.test.ts) pin its
 * exact exports; this is a parallel, general-purpose sibling for any wallet,
 * not just the admin allowlist, starting with Plank Checks
 * (lib/plank-checks.ts).
 *
 * Scheme: the client personal_signs a domain-prefixed message binding the
 * exact action, a client timestamp, and the keccak256 hash of the exact
 * payload being submitted. A captured signature therefore cannot authorize
 * a different action, a different payload, or (outside the freshness
 * window) a replay of the same one. The server recovers the signer with
 * ethers' verifyMessage (EIP-191) — every failure path returns false, an
 * unparseable signature never authorizes anything.
 */

export const WALLET_PROOF_WINDOW_MS = 5 * 60 * 1000;

export function walletProofPayloadHash(payloadJson: string): string {
  return keccakId(payloadJson);
}

export function walletProofMessage(
  domain: string,
  action: string,
  timestamp: number,
  payloadHash: string
): string {
  return `plank:${domain}:${action}:${timestamp}:${payloadHash}`;
}

export type WalletProof = {
  /** Address the client claims signed this proof. */
  address: string;
  /** Client clock, ms since epoch; checked against the freshness window. */
  timestamp: number;
  /** personal_sign signature over walletProofMessage(...). */
  signature: string;
};

export type WalletProofResult =
  | { ok: true; address: string }
  | { ok: false; error: "STALE" | "BAD_SIGNATURE" };

/**
 * Verify a wallet's proof of control over a specific action + payload.
 * Fail closed: any malformed input, signature recovery error, or stale
 * timestamp rejects. Does not check any allowlist — the caller decides what
 * a verified address is permitted to do.
 */
export function verifyWalletProof(
  domain: string,
  action: string,
  payloadJson: string,
  proof: WalletProof,
  options?: { now?: number; windowMs?: number }
): WalletProofResult {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? WALLET_PROOF_WINDOW_MS;
  if (!Number.isFinite(proof.timestamp) || Math.abs(now - proof.timestamp) > windowMs) {
    return { ok: false, error: "STALE" };
  }
  let recovered: string;
  try {
    recovered = verifyMessage(
      walletProofMessage(domain, action, proof.timestamp, walletProofPayloadHash(payloadJson)),
      proof.signature
    );
  } catch {
    return { ok: false, error: "BAD_SIGNATURE" };
  }
  if (
    typeof proof.address !== "string" ||
    recovered.toLowerCase() !== proof.address.toLowerCase()
  ) {
    return { ok: false, error: "BAD_SIGNATURE" };
  }
  return { ok: true, address: recovered.toLowerCase() };
}
