import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "@/lib/wallet-proof";
import { signMessage } from "@/lib/wallet";

/**
 * Client-side counterpart to lib/wallet-proof.ts's verifyWalletProof --
 * builds the exact same domain-prefixed message
 * (`plank:{domain}:{action}:{timestamp}:{payloadHash}`) and signs it with
 * the connected wallet via lib/wallet.ts's signMessage (personal_sign, the
 * same primitive lib/admin-auth.ts already uses).
 *
 * Deliberately does NOT import any server module for its domain constant:
 * lib/referral-server.ts reaches lib/postgres.ts and the `pg` driver, which
 * needs node's fs/net/tls and cannot be bundled for the browser. Client-safe
 * copies of domain strings live here, and a test asserts they stay in sync
 * with the server's.
 */

/** Client-safe copy of lib/referral-server.ts's REFERRAL_PROOF_DOMAIN. */
export const REFERRAL_PROOF_DOMAIN = "plank-referral";

export async function buildWalletProof(
  address: string,
  domain: string,
  action: string,
  payload: Record<string, unknown>
): Promise<WalletProof> {
  const timestamp = Date.now();
  const payloadJson = JSON.stringify(payload);
  const message = walletProofMessage(domain, action, timestamp, walletProofPayloadHash(payloadJson));
  const signature = await signMessage(address, message);
  return { address, timestamp, signature };
}
