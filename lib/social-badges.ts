import { postgresQuery } from "@/lib/postgres";
import { verifyWalletProof, type WalletProof } from "@/lib/wallet-proof";

/**
 * Wallet-signed badge attestations (verified collector / verified LP) —
 * reuses lib/wallet-proof.ts's verifyWalletProof exactly as
 * lib/plank-checks.ts does for wallet linking, with its own domain so a
 * badge-claim signature can never be replayed to authorize a Plank Checks
 * wallet link or vice versa. See migration 007_social_badges.sql.
 */

export const WALLET_PROOF_DOMAIN = "social-badges";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type BadgeType = "verified_collector" | "verified_lp";

export const BADGE_TYPES: readonly BadgeType[] = ["verified_collector", "verified_lp"];

/**
 * Verifies the claim's signature only — same split as
 * lib/plank-checks.ts's verifyWalletLinkProof: the caller still has to
 * independently re-derive real eligibility (a Plank Checks point total over
 * a threshold, a real LP position) from trusted server data before calling
 * grantBadge. This function proves control of the address, nothing else.
 */
export function verifyBadgeClaimProof(
  wallet: string,
  badgeType: BadgeType,
  proof: WalletProof,
  now?: number
): boolean {
  if (!HEX_ADDRESS.test(wallet)) return false;
  if (!BADGE_TYPES.includes(badgeType)) return false;
  const payloadJson = JSON.stringify({ wallet: wallet.toLowerCase(), badgeType });
  const verdict = verifyWalletProof(WALLET_PROOF_DOMAIN, "claim-badge", payloadJson, proof, {
    now,
  });
  return verdict.ok && verdict.address === wallet.toLowerCase();
}

export type GrantBadgeResult = { ok: true } | { ok: false; error: "BAD_PROOF" };

/**
 * TRUSTED-CALLER BOUNDARY, same posture as lib/plank-checks.ts's
 * recordPointEvent: this function does NOT check eligibility — it only
 * checks the wallet's own signature over the claim and then records the
 * grant. A route calling this must have already re-derived real
 * eligibility from trusted server data before calling it.
 */
export async function grantBadge(
  wallet: string,
  badgeType: BadgeType,
  proof: WalletProof
): Promise<GrantBadgeResult> {
  const w = wallet.toLowerCase();
  if (!verifyBadgeClaimProof(w, badgeType, proof)) return { ok: false, error: "BAD_PROOF" };

  await postgresQuery(
    `INSERT INTO social_badges (wallet_address, badge_type, proof_signature, proof_timestamp)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_address, badge_type) DO NOTHING`,
    [w, badgeType, proof.signature, proof.timestamp]
  );
  return { ok: true };
}

export async function getWalletBadges(wallet: string): Promise<BadgeType[]> {
  const w = wallet.toLowerCase();
  if (!HEX_ADDRESS.test(w)) return [];
  const result = await postgresQuery<{ badge_type: BadgeType }>(
    `SELECT badge_type FROM social_badges WHERE wallet_address = $1`,
    [w]
  );
  return result.rows.map((row) => row.badge_type);
}
