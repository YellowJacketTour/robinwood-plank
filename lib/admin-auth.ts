import { id as keccakId, verifyMessage } from "ethers";
import { MARKET_FEE_RECIPIENT, SITE_FEE } from "@/lib/constants";

/**
 * Wallet-signature admin authorization for the /admin console and its API
 * mutations (today: the WoodAmp playlist; designed to cover future management
 * endpoints by varying `action`).
 *
 * Scheme — stateless on purpose (there is no session/cookie infrastructure in
 * this app, and multi-instance Passenger has no shared session store; see the
 * `?proof=` precedent in app/api/market/orders/route.ts):
 * - The client personal_signs a domain-prefixed message binding the exact
 *   action, a client timestamp, and the keccak256 hash of the exact payload
 *   being submitted. A captured signature therefore cannot authorize a
 *   different action, a different payload, or (outside the freshness window)
 *   a replay of the same one.
 * - The server recovers the signer with ethers' verifyMessage (EIP-191) and
 *   requires it to be on the admin allowlist. Every failure path returns
 *   false — an unparseable signature never authorizes anything.
 *
 * Allowlist: `PLANK_ADMIN_ADDRESSES` (server-only env, comma-separated hex
 * addresses). When unset, falls back to the two treasury wallets already
 * hard-coded in lib/constants.ts — the owner controls both, and they are
 * public on-chain fee recipients, so listing them reveals nothing new.
 */

/** Accept signatures whose embedded timestamp is within this window. */
export const ADMIN_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function adminAddresses(
  env: string | undefined = process.env.PLANK_ADMIN_ADDRESSES
): readonly string[] {
  const fromEnv = (env ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HEX_ADDRESS.test(entry));
  if (fromEnv.length > 0) return fromEnv;
  return [SITE_FEE.recipient.toLowerCase(), MARKET_FEE_RECIPIENT.toLowerCase()];
}

export function isAdminAddress(
  address: string | null | undefined,
  env?: string | undefined
): boolean {
  if (!address) return false;
  return adminAddresses(env).includes(address.toLowerCase());
}

/** keccak256 of the UTF-8 payload JSON — binds a signature to exact content. */
export function adminPayloadHash(payloadJson: string): string {
  return keccakId(payloadJson);
}

/**
 * The exact string the admin wallet personal_signs. Built identically on the
 * client (lib/wallet.ts signMessage) and the server so recovery matches.
 */
export function adminMessage(
  action: string,
  timestamp: number,
  payloadHash: string
): string {
  return `plank:admin:${action}:${timestamp}:${payloadHash}`;
}

export type AdminProof = {
  /** Lowercase-insensitive signer address the client claims. */
  address: string;
  /** Client clock, ms since epoch; checked against the freshness window. */
  timestamp: number;
  /** personal_sign signature over adminMessage(...). */
  signature: string;
};

export type AdminVerifyResult =
  | { ok: true; address: string }
  | { ok: false; error: "STALE" | "UNAUTHORIZED" | "BAD_SIGNATURE" };

/**
 * Verify an admin mutation. Fail closed: any malformed input, signature
 * recovery error, stale timestamp, or non-allowlisted signer rejects.
 */
export function verifyAdminProof(
  action: string,
  payloadJson: string,
  proof: AdminProof,
  options?: { now?: number; env?: string }
): AdminVerifyResult {
  const now = options?.now ?? Date.now();
  if (
    !Number.isFinite(proof.timestamp) ||
    Math.abs(now - proof.timestamp) > ADMIN_SIGNATURE_WINDOW_MS
  ) {
    return { ok: false, error: "STALE" };
  }
  let recovered: string;
  try {
    recovered = verifyMessage(
      adminMessage(action, proof.timestamp, adminPayloadHash(payloadJson)),
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
  if (!isAdminAddress(recovered, options?.env)) {
    return { ok: false, error: "UNAUTHORIZED" };
  }
  return { ok: true, address: recovered.toLowerCase() };
}
