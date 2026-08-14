import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { verifyWalletProof, type WalletProof } from "@/lib/wallet-proof";
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

export const REFERRAL_PROOF_DOMAIN = "plank-referral";

/**
 * Verifies that the caller controls the wallet BEING REFERRED.
 *
 * WHY THIS IS REQUIRED, and why it is required on the referred side
 * specifically. Attribution here is permanent by construction: the first
 * claim wins, no code path updates or deletes a row. Without a proof, both
 * addresses were plain strings in a POST body, so anyone could walk a list
 * of wallets -- every holder and trader is public chain data -- and claim
 * the entire userbase as their own referrals from `curl`, before those
 * users ever arrived. The real referrer would then be permanently locked
 * out, and because the schema has no UPDATE or DELETE path, the only repair
 * would be hand-written SQL against production.
 *
 * The referred wallet is the right side to prove: the claim is an assertion
 * ABOUT that wallet ("I was referred by X"), and it is the wallet actually
 * connected in the browser when the claim fires. The referrer proves
 * nothing and needs to prove nothing -- being named as a referrer is not a
 * capability, and a referrer cannot forge an attribution without the
 * referred user's signature.
 *
 * Note this is the opposite call from the MoonPay ramp, which deliberately
 * does NOT verify its destination address (see lib/moonpay-server.ts): there
 * the caller pays for their own delivery so a forged destination harms
 * nobody, and an attacker can sign for a wallet they control anyway. Here a
 * forgery takes something from someone else and cannot be undone.
 */
export function verifyReferralProof(
  referredWallet: string,
  referrerWallet: string,
  proof: WalletProof,
  now?: number
): boolean {
  const referred = normalizeAddress(referredWallet);
  if (!isEthAddress(referred)) return false;
  const payloadJson = JSON.stringify({
    referred,
    referrer: normalizeAddress(referrerWallet),
  });
  const verdict = verifyWalletProof(REFERRAL_PROOF_DOMAIN, "claim", payloadJson, proof, { now });
  return verdict.ok && verdict.address === referred;
}

/**
 * Records that `referredWallet` was referred by `referrerWallet`. Permanent
 * by construction -- ON CONFLICT DO NOTHING means the FIRST successful
 * claim for a given wallet is the one that sticks; this function has no
 * code path that ever overwrites an existing row (see the migration's own
 * header for why that's sufficient without a trigger).
 *
 * Requires a wallet proof from the REFERRED wallet -- see
 * verifyReferralProof above for why permanence makes that non-optional.
 *
 * @returns the attribution that is now on file for this wallet -- either
 *   the one just inserted, or the pre-existing one if this wallet already
 *   had a referrer (never silently switches it). `alreadyClaimed` is true
 *   whenever a row existed BEFORE this call, including when the existing
 *   referrer is the same one being claimed -- callers need "did I record
 *   this" to be distinguishable from "this was already on file".
 */
export async function claimReferral(
  referredWallet: string,
  referrerWallet: string,
  proof: WalletProof
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
  if (!verifyReferralProof(referred, referrer, proof)) {
    throw new TradeApiError(401, "BAD_PROOF", "Could not verify control of the referred wallet.");
  }

  // RETURNING tells us whether THIS statement inserted the row. Without it
  // the old code inferred "already claimed" by comparing the stored
  // referrer to the one just submitted, which reported a fresh claim
  // whenever the same referrer was resubmitted -- indistinguishable from
  // actually recording it.
  const inserted = await postgresQuery<{ referred_wallet: string }>(
    `INSERT INTO plank_referrals (referred_wallet, referrer_wallet)
     VALUES ($1, $2)
     ON CONFLICT (referred_wallet) DO NOTHING
     RETURNING referred_wallet`,
    [referred, referrer]
  );
  if (inserted.rows.length > 0) {
    return { referrerWallet: referrer, alreadyClaimed: false };
  }

  const existing = await postgresQuery<{ referrer_wallet: string }>(
    `SELECT referrer_wallet FROM plank_referrals WHERE referred_wallet = $1`,
    [referred]
  );
  return {
    referrerWallet: existing.rows[0]?.referrer_wallet ?? referrer,
    alreadyClaimed: true,
  };
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
