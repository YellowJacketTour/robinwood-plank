import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import { MARKET_FEE_RECIPIENT } from "@/lib/constants";
import { rpcCall } from "@/lib/market/fetch-rpc";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import { verifyWalletProof, type WalletProof } from "@/lib/wallet-proof";

/**
 * Plank Checks — the vanity points/referral engine. See
 * docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md §1 for the full design.
 *
 * Points have no redemption value today. This module only ever reads chain
 * state and writes to our own Postgres ledger — it never holds funds, never
 * sends a transaction, and never requires a wallet approval. The only real
 * money that ever moves is the optional 0.01 ETH additional-wallet-link fee,
 * sent by the user directly to the existing treasury address; this module
 * only verifies that a specific, already-broadcast transaction really paid
 * it, the same "read a real on-chain fact before granting a permission"
 * shape lib/admin-auth.ts already uses for admin actions.
 */

export const WALLET_PROOF_DOMAIN = "plank-checks";

export const FREE_WALLET_LIMIT = 2;
export const ADDITIONAL_WALLET_FEE_WEI = BigInt("10000000000000000"); // 0.01 ETH
/** Same wallet every other vault/marketplace fee already flows to — see
 * lib/constants.ts's MARKET_FEE_RECIPIENT and the confirmed on-chain
 * treasury() read against all three deployed vaults. */
export const WALLET_LINK_FEE_RECIPIENT = MARKET_FEE_RECIPIENT;

export type PointCategory =
  | "swap"
  | "lp_hold"
  | "deposit"
  | "redeem"
  | "sale"
  | "referral"
  | "meme"
  | "volume_bounty"
  // Marketplace points/social-rank -- see docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md
  // §1.3 (the existing "sale" category already covers marketplace buying;
  // this is the operator-facing manual grant path noted as the "least
  // text, most trust" pattern for the one caller with no independent
  // on-chain verification behind it -- see recordManualGrant's own header
  // and app/api/admin/points/route.ts).
  | "admin_grant";

/**
 * Published, adjustable weights — one unit of "real revenue" (wei) or
 * "real value" (wei) converts to this many points. Adjustable like other
 * runtime constants (Flags-admin-editable later); never silently changed —
 * see the spec's transparency requirement.
 */
export const POINT_WEIGHTS: Record<PointCategory, bigint> = {
  // Tier 1 — direct revenue signal.
  swap: BigInt(1_000_000), // points per ETH of factory fee actually paid
  lp_hold: BigInt(1), // points per (wei held * hour), see lpHoldPoints below
  deposit: BigInt(50_000), // points per ETH of floor value deposited
  redeem: BigInt(500_000), // points per ETH of redeem fee actually paid
  sale: BigInt(20_000), // points per ETH of sale price (Marketplank-attributed)
  referral: BigInt(1_000_000), // same rate as a direct swap, credited to the referrer too
  // Tier 2 — free/low-barrier participation.
  meme: BigInt(100),
  volume_bounty: BigInt(20_000), // points per ETH of the brought-in collection's ongoing fee revenue
  // Not wei-converted via weiToPoints (an admin grant specifies a raw point
  // amount directly, no on-chain value behind it) -- present only so
  // PointCategory's Record stays exhaustively typed. See recordManualGrant.
  admin_grant: BigInt(0),
};

/** Sales not confirmed as a Marketplank-attributed fill earn a reduced rate —
 * a real sale, just not independently verified as ours. */
export const UNATTRIBUTED_SALE_MULTIPLIER = 0.6;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function weiToPoints(wei: bigint, weightPerEth: bigint): number {
  if (wei <= BigInt(0)) return 0;
  // (wei * weight) / 1e18, kept in bigint math until the final division to
  // avoid float precision loss on large fee/value amounts.
  const scaled = (wei * weightPerEth) / BigInt("1000000000000000000");
  return Number(scaled);
}

export function swapPoints(feeWeiPaid: bigint): number {
  return weiToPoints(feeWeiPaid, POINT_WEIGHTS.swap);
}

export function depositPoints(floorValueWeiAtDeposit: bigint): number {
  return weiToPoints(floorValueWeiAtDeposit, POINT_WEIGHTS.deposit);
}

export function redeemPoints(feeWeiPaid: bigint): number {
  return weiToPoints(feeWeiPaid, POINT_WEIGHTS.redeem);
}

export function salePoints(salePriceWei: bigint, marketplankAttributed: boolean): number {
  const base = weiToPoints(salePriceWei, POINT_WEIGHTS.sale);
  return marketplankAttributed ? base : Math.floor(base * UNATTRIBUTED_SALE_MULTIPLIER);
}

export function referralPoints(feeWeiPaid: bigint): number {
  return weiToPoints(feeWeiPaid, POINT_WEIGHTS.referral);
}

export function volumeBountyPoints(collectionFeeRevenueWei: bigint): number {
  return weiToPoints(collectionFeeRevenueWei, POINT_WEIGHTS.volume_bounty);
}

/**
 * Points for a marketplace fill, scored on the fee that PROVABLY REACHED
 * this app's treasury in that fill -- not on the sale price.
 *
 * This is the anti-farming design (audit findings H2/H3, 2026-08-19).
 * Scoring sale price let anyone wash-trade with themselves at gas cost, or
 * invent a price in a token they minted, for unlimited points. Scoring
 * received fee makes every point cost its earner real money paid to us, so
 * abuse is bounded by arithmetic rather than by detection heuristics --
 * the one mitigation the research consistently found actually holds up.
 *
 * The rate is deliberately generous relative to the other categories: a
 * fee is only ~1.8% of a sale, so at the plain `sale` weight a real
 * purchase would score ~50x less than before. MARKETPLACE_FEE_POINT_WEIGHT
 * restores roughly the previous points-per-real-purchase while keeping the
 * farming cost intact -- a wash trader still pays full freight for every
 * point.
 */
export const MARKETPLACE_FEE_POINT_WEIGHT = BigInt(1_000_000); // points per ETH of fee actually received

export function marketplaceFeePoints(feeWeiReceived: bigint): number {
  return weiToPoints(feeWeiReceived, MARKETPLACE_FEE_POINT_WEIGHT);
}

/**
 * Time-integrated LP scoring: points = lpValueWei * hoursHeld * weight,
 * scaled down to a sane magnitude. Deliberately NOT a flat per-deposit
 * score — see the spec's anti-flash-farming rationale. Called incrementally
 * (e.g. once per cron tick) with the elapsed hours since the last tick for
 * each still-open LP position, not computed once at withdrawal.
 */
export function lpHoldPoints(lpValueWei: bigint, hoursHeld: number): number {
  if (lpValueWei <= BigInt(0) || hoursHeld <= 0) return 0;
  const perHour = weiToPoints(lpValueWei, POINT_WEIGHTS.lp_hold);
  return perHour * hoursHeld;
}

export function memePoints(originalityMultiplier: number): number {
  const clamped = Math.max(0, Math.min(1, originalityMultiplier));
  return Math.round(Number(POINT_WEIGHTS.meme) * clamped);
}

// --- wallet linking ---------------------------------------------------

export type WalletLinkRequest = {
  profileId: number;
  wallet: string;
  proof: WalletProof;
  /** Required once the profile already has FREE_WALLET_LIMIT wallets. */
  paymentTxHash?: string;
};

export type WalletLinkResult =
  | { ok: true }
  | { ok: false; error: "BAD_ADDRESS" | "BAD_PROOF" | "PAYMENT_REQUIRED" | "BAD_PAYMENT" };

/**
 * Verifies a wallet-link request's signature only — the free-vs-paid
 * decision and the actual payment check need the caller's current wallet
 * count and a chain read, both handled in linkWallet() below. Split out so
 * the signature-only path is unit-testable without Postgres or an RPC call.
 */
export function verifyWalletLinkProof(
  wallet: string,
  proof: WalletProof,
  payloadJson: string,
  now?: number
): boolean {
  if (!HEX_ADDRESS.test(wallet)) return false;
  const verdict = verifyWalletProof(WALLET_PROOF_DOMAIN, "link-wallet", payloadJson, proof, {
    now,
  });
  return verdict.ok && verdict.address === wallet.toLowerCase();
}

/**
 * Reads a specific transaction and confirms it really sent at least
 * ADDITIONAL_WALLET_FEE_WEI to WALLET_LINK_FEE_RECIPIENT, from the wallet
 * being linked. Never trusts a client-supplied amount — the same posture
 * CONTRIBUTING.md requires for every wallet-facing value.
 */
export async function verifyWalletLinkPayment(
  txHash: string,
  fromWallet: string
): Promise<boolean> {
  if (!HEX_TX_HASH.test(txHash) || !HEX_ADDRESS.test(fromWallet)) return false;
  try {
    const tx = await rpcCall<{ to?: string; from?: string; value?: string }>(
      "eth_getTransactionByHash",
      [txHash],
      { timeoutMs: 8_000, urls: SERVER_DISPLAY_RPC_URLS }
    );
    if (!tx) return false;
    const to = (tx.to || "").toLowerCase();
    const from = (tx.from || "").toLowerCase();
    const value = BigInt(tx.value || "0x0");
    return (
      to === WALLET_LINK_FEE_RECIPIENT.toLowerCase() &&
      from === fromWallet.toLowerCase() &&
      value >= ADDITIONAL_WALLET_FEE_WEI
    );
  } catch {
    return false;
  }
}

export async function linkWallet(req: WalletLinkRequest): Promise<WalletLinkResult> {
  const wallet = req.wallet.toLowerCase();
  if (!HEX_ADDRESS.test(wallet)) return { ok: false, error: "BAD_ADDRESS" };

  const payloadJson = JSON.stringify({ profileId: req.profileId, wallet });
  if (!verifyWalletLinkProof(wallet, req.proof, payloadJson)) {
    return { ok: false, error: "BAD_PROOF" };
  }

  return withPostgresTransaction(async (client) => {
    // Lock the profile row first so concurrent link attempts for the SAME
    // profile serialize instead of racing. Without this, Postgres's default
    // READ COMMITTED isolation lets several concurrent transactions each
    // read the free-wallet count as still under the limit before any of
    // their inserts commit — a phantom-read race that could land more than
    // FREE_WALLET_LIMIT wallets as "free". FOR UPDATE forces every other
    // concurrent linkWallet call for this profile to wait for this one to
    // commit or roll back before it can even read the count.
    await client.query(`SELECT profile_id FROM plank_checks_profiles WHERE profile_id = $1 FOR UPDATE`, [
      req.profileId,
    ]);
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM plank_checks_wallets WHERE profile_id = $1`,
      [req.profileId]
    );
    const existing = countResult.rows[0]?.n ?? 0;

    let linkTxHash: string | null = null;
    let linkFeeWei = "0";
    if (existing >= FREE_WALLET_LIMIT) {
      if (!req.paymentTxHash) return { ok: false, error: "PAYMENT_REQUIRED" };
      const paid = await verifyWalletLinkPayment(req.paymentTxHash, wallet);
      if (!paid) return { ok: false, error: "BAD_PAYMENT" };
      linkTxHash = req.paymentTxHash;
      linkFeeWei = ADDITIONAL_WALLET_FEE_WEI.toString();
    }

    await client.query(
      `INSERT INTO plank_checks_wallets (wallet_address, profile_id, link_tx_hash, link_fee_wei)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wallet_address) DO NOTHING`,
      [wallet, req.profileId, linkTxHash, linkFeeWei]
    );
    return { ok: true };
  });
}

// --- point recording ----------------------------------------------------
//
// TRUSTED-CALLER-ONLY BOUNDARY. Every function below this line takes
// `points` / fee amounts as plain parameters and performs NO independent
// verification that they correspond to a real on-chain event — that
// verification is the CALLER'S job, always, the same way the rest of this
// codebase's chain-indexing code (lib/market/sales-catalog.ts,
// lib/market/vault-stats.ts) verifies real events server-side before
// writing anything durable. This is safe only as long as every caller is
// trusted, chain-verifying server code (a cron job reading real swap/LP/
// deposit events), never a route that accepts a client-supplied amount
// directly. If a future API route calls recordPointEvent with anything
// derived from client input without first re-deriving it from a real chain
// read, that route lets any wallet mint arbitrary points for itself.

export type PointEvent = {
  wallet: string;
  category: PointCategory;
  points: number;
  sourceTxHash?: string | null;
  referredWallet?: string | null;
  metadata?: Record<string, unknown>;
  earnedAt: Date;
};

/**
 * Idempotent: the (source_tx_hash, category, wallet_address) unique index
 * (migration 005) means re-processing the same cron pass over the same
 * transaction never double-credits it. Events with no source_tx_hash (e.g.
 * incremental LP-hold accrual ticks) are never deduped this way by design —
 * each tick is a genuinely new, distinct event.
 */
export async function recordPointEvent(event: PointEvent): Promise<void> {
  const wallet = event.wallet.toLowerCase();
  if (!HEX_ADDRESS.test(wallet)) throw new Error("Invalid wallet address.");
  if (!Number.isFinite(event.points) || event.points < 0) {
    throw new Error("Points must be a non-negative finite number.");
  }
  await postgresQuery(
    `INSERT INTO plank_checks_events
       (wallet_address, category, points, source_tx_hash, referred_wallet, metadata, earned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_tx_hash, category, wallet_address)
       WHERE source_tx_hash IS NOT NULL
       DO NOTHING`,
    [
      wallet,
      event.category,
      event.points,
      event.sourceTxHash ?? null,
      event.referredWallet?.toLowerCase() ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.earnedAt.toISOString(),
    ]
  );
}

/**
 * A referral-linked swap credits BOTH parties at the same rate a direct
 * swap would earn — see the spec: a referred swap is exactly as valuable to
 * the protocol as a direct one, so both sides earn identically, not a split.
 */
export async function recordReferredSwap(opts: {
  buyer: string;
  referrer: string;
  feeWeiPaid: bigint;
  txHash: string;
  earnedAt: Date;
}): Promise<void> {
  const points = referralPoints(opts.feeWeiPaid);
  await recordPointEvent({
    wallet: opts.buyer,
    category: "swap",
    points,
    sourceTxHash: opts.txHash,
    earnedAt: opts.earnedAt,
  });
  // A wallet cannot refer itself. Without this, tagging your own trade with
  // your own address as the referral code would double the same real swap's
  // points for free — no extra cost, effort, or economic activity, unlike
  // two genuinely different wallets referring each other's real trades.
  if (opts.buyer.toLowerCase() === opts.referrer.toLowerCase()) return;
  await recordPointEvent({
    wallet: opts.referrer,
    category: "referral",
    points,
    sourceTxHash: opts.txHash,
    referredWallet: opts.buyer,
    earnedAt: opts.earnedAt,
  });
}

// --- leaderboard ----------------------------------------------------

export type LeaderboardRow = {
  profileId: number;
  vanityName: string | null;
  totalPoints: number;
};

/**
 * Always a live SUM over the permanent event ledger — never a separately
 * maintained score column that could drift from real history. `season`
 * is a pure read-time filter; omitting it reads all-time totals.
 */
export async function getLeaderboard(opts?: {
  season?: { start: Date; end: Date };
  limit?: number;
}): Promise<LeaderboardRow[]> {
  const limit = opts?.limit ?? 100;
  const params: unknown[] = [];
  let seasonClause = "";
  if (opts?.season) {
    params.push(opts.season.start.toISOString(), opts.season.end.toISOString());
    seasonClause = `AND e.earned_at >= $${params.length - 1} AND e.earned_at < $${params.length}`;
  }
  params.push(limit);

  const result = await postgresQuery<{
    profile_id: number;
    vanity_name: string | null;
    total_points: string;
  }>(
    `SELECT p.profile_id, p.vanity_name, SUM(e.points)::numeric AS total_points
     FROM plank_checks_events e
     JOIN plank_checks_wallets w ON w.wallet_address = e.wallet_address
     JOIN plank_checks_profiles p ON p.profile_id = w.profile_id
     WHERE TRUE ${seasonClause}
     GROUP BY p.profile_id, p.vanity_name
     ORDER BY total_points DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    profileId: row.profile_id,
    vanityName: row.vanity_name,
    totalPoints: Number(row.total_points),
  }));
}

/**
 * One wallet's real point total -- same profile-join getLeaderboard uses
 * (a wallet's rank reflects its WHOLE linked profile, not just that one
 * address, consistent with how the leaderboard itself already groups).
 * Zero for an unlinked/unknown wallet, never an error -- "no points yet"
 * is a normal state, not a failure.
 */
export async function getPointTotalForWallet(wallet: string): Promise<number> {
  const address = wallet.trim().toLowerCase();
  if (!HEX_ADDRESS.test(address)) return 0;
  const result = await postgresQuery<{ total_points: string | null }>(
    `SELECT SUM(e.points)::numeric AS total_points
     FROM plank_checks_events e
     JOIN plank_checks_wallets w ON w.wallet_address = e.wallet_address
     JOIN plank_checks_profiles p ON p.profile_id = w.profile_id
     WHERE p.profile_id = (
       SELECT profile_id FROM plank_checks_wallets WHERE wallet_address = $1
     )`,
    [address]
  );
  const total = result.rows[0]?.total_points;
  return total ? Number(total) : 0;
}

// --- social rank tier -----------------------------------------------------
//
// A visible tier label over a wallet's real Plank Checks point total --
// flagged by the owner as wanting "a points and ranking system purely
// social rank earned thru economic energy like we do with gamble games."
// Named/spirited after the retired on-chain PlankProgression rank ladder
// (Sapling->Wooden Whale; deleted 2026-09-04 because per-wallet privileges
// are incompatible with the partition-invariant CCS-2L rule), but this is a
// UI-only derivation with no contract-level effect: a vanity display over
// Plank Checks' off-chain point
// ledger, same "vanity only, for now" posture the whole module already
// has (SPEC-PLANK-CHECKS-AND-INDEX.md §1.1). No privilege is gated by this
// -- see that spec's §1.7 for what a REAL future graduation into
// privilege-gating would require (a funded rewards pool, explicit owner
// sign-off), neither of which exists yet.
export type SocialRankTier = "Sapling" | "Stick" | "Board" | "Plank" | "Big Beam" | "Wooden Whale";

/** Thresholds are real, adjustable constants (same "named, adjustable parameter" rule POINT_WEIGHTS follows) -- not derived from any formula, chosen to spread across a realistic point range given the weights above (e.g. a single ~0.05 ETH marketplace sale already earns ~1,000 points at the sale rate). */
const RANK_TIER_THRESHOLDS: [SocialRankTier, number][] = [
  ["Wooden Whale", 500_000],
  ["Big Beam", 100_000],
  ["Plank", 20_000],
  ["Board", 5_000],
  ["Stick", 1_000],
  ["Sapling", 0],
];

export type RankTierResult = {
  tier: SocialRankTier;
  points: number;
  /** Points still needed to reach the next tier, or null at the top. */
  pointsToNextTier: number | null;
  nextTier: SocialRankTier | null;
};

export function rankTierFromPoints(points: number): RankTierResult {
  const safePoints = Number.isFinite(points) && points > 0 ? points : 0;
  for (let i = 0; i < RANK_TIER_THRESHOLDS.length; i++) {
    const [tier, threshold] = RANK_TIER_THRESHOLDS[i];
    if (safePoints >= threshold) {
      const next = i > 0 ? RANK_TIER_THRESHOLDS[i - 1] : null;
      return {
        tier,
        points: safePoints,
        pointsToNextTier: next ? next[1] - safePoints : null,
        nextTier: next ? next[0] : null,
      };
    }
  }
  // Unreachable -- the last threshold is 0 and safePoints >= 0 always, but
  // TypeScript can't see that, and a real fallback beats a non-null
  // assertion on an array index.
  return { tier: "Sapling", points: safePoints, pointsToNextTier: RANK_TIER_THRESHOLDS[4][1], nextTier: "Stick" };
}

/**
 * The ONE legitimate manual-grant path -- see PointCategory's own "admin_grant"
 * doc comment. Distinct from recordPointEvent's blanket trusted-caller
 * warning: this function IS a safe caller of it, because the trust boundary
 * here is real admin authentication (verifyAdminProof, checked by the
 * caller route BEFORE this runs), not client-supplied data taken on faith.
 * Every grant is tagged with who granted it and why -- the one category in
 * this whole ledger with no independent on-chain verification behind it,
 * so the audit trail has to carry that weight instead (same "least text,
 * most trust" transparency posture the spec requires elsewhere).
 */
export async function recordManualGrant(opts: {
  wallet: string;
  points: number;
  grantedBy: string;
  reason: string;
}): Promise<void> {
  if (!Number.isFinite(opts.points) || opts.points <= 0) {
    throw new Error("Grant points must be a positive finite number.");
  }
  await recordPointEvent({
    wallet: opts.wallet,
    category: "admin_grant",
    points: Math.round(opts.points),
    metadata: { grantedBy: opts.grantedBy.toLowerCase(), reason: opts.reason },
    earnedAt: new Date(),
  });
}
