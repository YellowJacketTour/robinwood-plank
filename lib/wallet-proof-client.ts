import { walletProofMessage, walletProofPayloadHash, type WalletProof } from "@/lib/wallet-proof";
import { signMessage } from "@/lib/wallet";

/**
 * Client-safe copy of lib/social-endorsements.ts's WALLET_PROOF_DOMAIN.
 * Deliberately NOT imported from that module — lib/social-endorsements.ts
 * pulls in lib/postgres.ts (the `pg` package, which requires Node core
 * modules like `tls`/`net` that don't exist in the browser bundle). A
 * client component importing the domain constant from the server module
 * dragged all of Postgres into the client bundle and broke `next build`.
 * Keep this in sync with lib/social-endorsements.ts's WALLET_PROOF_DOMAIN —
 * both are asserted equal in test/market/social-endorsements.test.ts.
 */
export const SOCIAL_ENDORSEMENTS_WALLET_PROOF_DOMAIN = "social-endorsements";

/**
 * Client-side counterpart to lib/wallet-proof.ts's verifyWalletProof —
 * builds the exact same domain-prefixed message (plank:{domain}:{action}:
 * {timestamp}:{payloadHash}) and signs it with the connected wallet via
 * lib/wallet.ts's signMessage (personal_sign, the same primitive the /admin
 * console already uses for lib/admin-auth.ts). Used by the endorse UI
 * (lib/social-endorsements.ts's WALLET_PROOF_DOMAIN) and can be reused by
 * any future client-side wallet-proof flow (badge claims, etc).
 */
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
