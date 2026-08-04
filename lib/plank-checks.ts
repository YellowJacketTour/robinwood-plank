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
  | "volume_bounty";

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
