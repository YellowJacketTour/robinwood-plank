import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { TradeApiError } from "@/lib/uniswap-server";

/**
 * Referral ATTRIBUTION only -- who referred whom, real and permanent
 * (deploy/inmotion/postgres/migrations/010_referral_attribution.sql). This
 * module deliberately does NOT compute or credit any rebate/payout value.
 *
 * WHY THE PAYOUT SIDE IS NOT HERE YET (a scoping decision, not an omission):
 *
 * 1. Correctness: /api/uniswap/swap only BUILDS a swap transaction -- it
 *    never learns whether the client actually signed and broadcast it, or
 *    whether it landed on-chain vs. reverted (SwapWidget.tsx's own header:
 *    "Success is proven by a balance delta, not just a receipt", checked
 *    CLIENT-SIDE via lib/wallet.ts's waitForTransaction). Crediting a
 *    referral rebate at swap-build time, before any of that is known, would
 *    pay out for trades that never happened. A real payout mechanism needs
 *    server-side verification of a confirmed on-chain receipt first --
 *    a real, separate piece of infrastructure, not a one-line add here.
 * 2. Compliance: referral payouts are the kind of feature that has real
 *    legal shape (referral-as-compensation / MSB-adjacent questions) that
 *    this repo has not had reviewed for this specific mechanic. Attribution
 *    tracking alone carries none of that risk -- it moves no value.
 *
 * Building attribution now, with the payout math deliberately deferred, is
 * the same "off-chain scoring first, no new on-chain surface until the
 * design and legal review are actually done" call already made for the
 * unrelated plank-love sandbox on this same account -- consistent judgment
 * on the same open question, not a shortcut.
 */

export const REFERRAL_ENABLED =
  process.env.NEXT_PUBLIC_REFERRAL_ENABLED?.trim().toLowerCase() === "true";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isReferralConfigured(): boolean {
  return hasPostgresConfig();
}

/**
 * Records that `referredWallet` was referred by `referrerWallet`. Permanent
 * by construction -- ON CONFLICT DO NOTHING means the FIRST successful
 * claim for a given wallet is the one that sticks; this function has no
 * code path that ever overwrites an existing row (see the migration's own
 * header for why that's sufficient without a trigger).
 *
 * @returns the attribution that is now on file for this wallet -- either
 *   the one just inserted, or the pre-existing one if this wallet already
 *   had a referrer (never silently switches it).
 */
export async function claimReferral(
  referredWallet: string,
  referrerWallet: string
): Promise<{ referrerWallet: string; alreadyClaimed: boolean }> {
  if (!isReferralConfigured()) {
    throw new TradeApiError(503, "REFERRAL_NOT_CONFIGURED", "Referral tracking is not configured on the server.");
  }
  const referred = normalizeAddress(referredWallet);
  const referrer = normalizeAddress(referrerWallet);
  if (!isEthAddress(referred) || !isEthAddress(referrer)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "Both wallet addresses must be valid 0x addresses.");
  }
  if (referred === referrer) {
    throw new TradeApiError(400, "SELF_REFERRAL", "You cannot refer yourself.");
  }

  await postgresQuery(
    `INSERT INTO plank_referrals (referred_wallet, referrer_wallet)
     VALUES ($1, $2)
     ON CONFLICT (referred_wallet) DO NOTHING`,
    [referred, referrer]
  );

  const existing = await postgresQuery<{ referrer_wallet: string }>(
    `SELECT referrer_wallet FROM plank_referrals WHERE referred_wallet = $1`,
    [referred]
  );
  const onFile = existing.rows[0]?.referrer_wallet ?? referrer;
  return { referrerWallet: onFile, alreadyClaimed: onFile !== referrer };
}

export async function getReferralInfo(
  wallet: string
): Promise<{ referredBy: string | null; referredCount: number }> {
  if (!isReferralConfigured()) {
    throw new TradeApiError(503, "REFERRAL_NOT_CONFIGURED", "Referral tracking is not configured on the server.");
  }
  const address = normalizeAddress(wallet);
  if (!isEthAddress(address)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "wallet must be a valid 0x address.");
  }

  const [referredByResult, countResult] = await Promise.all([
    postgresQuery<{ referrer_wallet: string }>(
      `SELECT referrer_wallet FROM plank_referrals WHERE referred_wallet = $1`,
      [address]
    ),
    postgresQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM plank_referrals WHERE referrer_wallet = $1`,
      [address]
    ),
  ]);

  return {
    referredBy: referredByResult.rows[0]?.referrer_wallet ?? null,
    referredCount: Number(countResult.rows[0]?.count ?? "0"),
  };
}
