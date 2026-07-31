/**
 * Pure migration planning — no chain, no React, fully unit-testable.
 *
 * Given a wallet's position across the legacy vaults (V1, V2) it computes the
 * plan to move that value into the current vault (V3): withdraw any V2 LP first,
 * redeem NFTs with the shares held, deposit those NFTs into V3, and surface any
 * dust that is below one redeem's worth.
 *
 * All share amounts are bigint wei (1e18 = one share). Legacy vaults are the
 * share-fee model (redeem burns SHARE_UNIT * (1 + redeemFee)); the destination
 * V3 is the ETH-fee model (deposit mints exactly one share for an ETH fee), so
 * there is no re-deposit share shortfall on the destination side — the only
 * friction that strands value is the legacy redeem cost, modelled here.
 */

export const SHARE_UNIT = BigInt("1000000000000000000"); // 1e18

export type VaultPosition = {
  address: string;
  /** 1 = V1, 2 = V2. */
  generation: number;
  /** "Vn" label. */
  version: string;
  /** vROBIN held in the wallet for this vault. */
  walletShares: bigint;
  /** V2 absolute LP credits (0 for V1). */
  lpShareCredit: bigint;
  lpEthCredit: bigint;
  /** Shares to redeem one NFT here: SHARE_UNIT * (1 + redeemFeeBps/1e4). */
  redeemCostShares: bigint;
  /** Live pool reserves, so the plan can note whether an LP withdrawal is covered. */
  poolShareReserve: bigint;
  poolEthReserve: bigint;
};

export type SourcePlan = {
  address: string;
  version: string;
  /** True when there is a V2 LP position to withdraw before redeeming. */
  needsLpWithdraw: boolean;
  lpShareCredit: bigint;
  lpEthCredit: bigint;
  /** Can the pool cover the LP withdrawal right now? (credits <= reserves.) */
  lpWithdrawCovered: boolean;
  /** Wallet shares plus LP share credit — what you can redeem with post-withdraw. */
  totalShares: bigint;
  /** floor(totalShares / redeemCostShares). */
  redeemableNfts: number;
  /** Leftover shares below one redeem — the dust to sell for ETH. */
  dustShares: bigint;
  hasDust: boolean;
};

export type MigrationPlan = {
  hasValue: boolean;
  sources: SourcePlan[];
  totalRedeemableNfts: number;
  /** True when no legacy value remains anywhere. */
  complete: boolean;
};

function planSource(p: VaultPosition): SourcePlan | null {
  const needsLpWithdraw = p.lpShareCredit > BigInt(0) || p.lpEthCredit > BigInt(0);
  const totalShares = p.walletShares + p.lpShareCredit;
  const hasValue = totalShares > BigInt(0) || p.lpEthCredit > BigInt(0);
  if (!hasValue) return null;

  const cost = p.redeemCostShares > BigInt(0) ? p.redeemCostShares : SHARE_UNIT;
  const redeemableNfts = Number(totalShares / cost);
  const dustShares = totalShares - BigInt(redeemableNfts) * cost;
  const lpWithdrawCovered =
    p.lpShareCredit <= p.poolShareReserve && p.lpEthCredit <= p.poolEthReserve;

  return {
    address: p.address,
    version: p.version,
    needsLpWithdraw,
    lpShareCredit: p.lpShareCredit,
    lpEthCredit: p.lpEthCredit,
    lpWithdrawCovered,
    totalShares,
    redeemableNfts,
    dustShares,
    hasDust: dustShares > BigInt(0),
  };
}

/**
 * Build the full plan across every legacy vault the wallet has value in.
 * Sources are ordered by generation descending (V2 before V1) so the newest —
 * and the one with the live LP-drain exposure — is handled first.
 */
export function buildMigrationPlan(positions: VaultPosition[]): MigrationPlan {
  const sources = positions
    .slice()
    .sort((a, b) => b.generation - a.generation)
    .map(planSource)
    .filter((s): s is SourcePlan => s !== null);

  const totalRedeemableNfts = sources.reduce((n, s) => n + s.redeemableNfts, 0);
  const hasValue = sources.length > 0;

  return {
    hasValue,
    sources,
    totalRedeemableNfts,
    complete: !hasValue,
  };
}

/** Shares to redeem one NFT under the share-fee model. */
export function redeemCostShares(redeemFeeBps: number): bigint {
  return SHARE_UNIT + (SHARE_UNIT * BigInt(redeemFeeBps)) / BigInt(10000);
}

/** Format a wei share amount to a short decimal string (e.g. "3.0300"). */
export function formatShares(wei: bigint, dp = 4): string {
  const whole = wei / SHARE_UNIT;
  const frac = (wei % SHARE_UNIT).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
}
