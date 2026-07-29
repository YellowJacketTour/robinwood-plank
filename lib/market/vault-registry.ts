/**
 * Dual-vault migrate registry.
 *
 * PRIMARY  = where new Instant Swap / LP should go once V2 is live
 * LEGACY   = where existing deposits still redeem (V1)
 *
 * Never remove LEGACY from env until heldTokenCount on that vault is 0
 * (or operators accept stranding remaining holders).
 */

import {
  MARKET_VAULT_ADDRESS,
  MARKET_VAULT_DUAL_MODE,
  MARKET_VAULT_LEGACY_ADDRESS,
  MARKET_VAULT_V1_KNOWN,
} from "@/lib/constants";

export type VaultRole = "primary" | "legacy";

export type VaultDescriptor = {
  role: VaultRole;
  address: string;
  /** Short UI label */
  label: string;
  /** One-line purpose */
  purpose: string;
  /** True when this is the historically first production vault */
  isV1: boolean;
};

export function isVaultAddress(addr: string | null | undefined): addr is string {
  return Boolean(addr && /^0x[0-9a-fA-F]{40}$/.test(addr));
}

export function shortVault(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** All vaults the migrate UI and Instant Swap may target. */
export function listVaults(): VaultDescriptor[] {
  const out: VaultDescriptor[] = [];
  if (MARKET_VAULT_ADDRESS) {
    const isV1 = MARKET_VAULT_ADDRESS.toLowerCase() === MARKET_VAULT_V1_KNOWN.toLowerCase();
    out.push({
      role: "primary",
      address: MARKET_VAULT_ADDRESS,
      label: MARKET_VAULT_DUAL_MODE ? (isV1 ? "Primary (still V1)" : "New vault (V2)") : "Vault",
      purpose: MARKET_VAULT_DUAL_MODE
        ? isV1
          ? "Still the only vault — deposit / redeem / trade here"
          : "Prefer for new deposits, Add LP, Remove LP"
        : "Deposit, redeem, Instant Swap",
      isV1,
    });
  }
  if (MARKET_VAULT_LEGACY_ADDRESS) {
    out.push({
      role: "legacy",
      address: MARKET_VAULT_LEGACY_ADDRESS,
      label: "Legacy vault (V1 deposits)",
      purpose: "Redeem existing deposits — do not abandon until empty",
      isV1: MARKET_VAULT_LEGACY_ADDRESS.toLowerCase() === MARKET_VAULT_V1_KNOWN.toLowerCase(),
    });
  }
  return out;
}

export function getVaultByRole(role: VaultRole): VaultDescriptor | null {
  return listVaults().find((v) => v.role === role) ?? null;
}

export function dualVaultMode(): boolean {
  return MARKET_VAULT_DUAL_MODE;
}

/**
 * Fee schedule used by V1 (and intended V2 defaults): 1% mint, 1% redeem,
 * 2.5% target premium. Live-checked in the migrate panel; these are the
 * known production defaults for walkthrough math.
 */
export const VAULT_FEE_DEFAULTS = {
  mintFeeBps: 100,
  redeemFeeBps: 100,
  targetPremiumBps: 250,
} as const;

export const SHARE_UNIT = BigInt("1000000000000000000");

export function redeemCostShares(
  redeemFeeBps: number,
  targetPremiumBps: number,
  targeted: boolean
): bigint {
  const bps = BigInt(redeemFeeBps + (targeted ? targetPremiumBps : 0));
  return SHARE_UNIT + (SHARE_UNIT * bps) / BigInt(10_000);
}

export function mintSharesOut(mintFeeBps: number): bigint {
  return SHARE_UNIT - (SHARE_UNIT * BigInt(mintFeeBps)) / BigInt(10_000);
}

/**
 * Honest migration cost for one NFT round-trip on fee schedule:
 * deposit got mintSharesOut; redeem needs redeemCost; re-deposit on V2 gets mintSharesOut again.
 */
export function migrationFeeExplain(fees: {
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
}): {
  sharesFromOneDeposit: string;
  sharesForRandomRedeem: string;
  sharesForTargetRedeem: string;
  shortfallAfterOneDeposit: string;
  /** Extra shares needed to random-redeem after a single deposit */
  dustSharesNeeded: string;
  /** Approximate "tax" of redeem + re-deposit (share units, not ETH) */
  roundTripShareFriction: string;
  summary: string;
} {
  const fromDeposit = mintSharesOut(fees.mintFeeBps);
  const randomCost = redeemCostShares(fees.redeemFeeBps, fees.targetPremiumBps, false);
  const targetCost = redeemCostShares(fees.redeemFeeBps, fees.targetPremiumBps, true);
  const shortfall = randomCost > fromDeposit ? randomCost - fromDeposit : BigInt(0);
  // After redeem you hold NFT; re-deposit mints fromDeposit again. Friction ≈ redeem fee + mint fee.
  const friction =
    (SHARE_UNIT * BigInt(fees.redeemFeeBps + fees.mintFeeBps)) / BigInt(10_000);

  const fmt = (w: bigint) => {
    const whole = w / SHARE_UNIT;
    const frac = (w % SHARE_UNIT).toString().padStart(18, "0").slice(0, 4);
    return `${whole}.${frac}`;
  };

  return {
    sharesFromOneDeposit: fmt(fromDeposit),
    sharesForRandomRedeem: fmt(randomCost),
    sharesForTargetRedeem: fmt(targetCost),
    shortfallAfterOneDeposit: fmt(shortfall),
    dustSharesNeeded: fmt(shortfall),
    roundTripShareFriction: fmt(friction),
    summary:
      shortfall > BigInt(0)
        ? `One deposit mints ~${fmt(fromDeposit)} shares but a random redeem burns ~${fmt(randomCost)}. You need ~${fmt(shortfall)} extra shares (buy dust on Instant Swap or deposit another plank) before you can exit. Migrating is optional — not a rug — but fees apply the same as any redeem/deposit.`
        : `Redeem cost is covered by a single deposit's mint on this fee schedule.`,
  };
}
