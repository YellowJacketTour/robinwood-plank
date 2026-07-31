/**
 * N-vault registry.
 *
 * PRIMARY = the current-generation vault (V3) where new deposits / trades / LP
 *           should go.
 * LEGACY  = every older vault that still holds redeemable deposits (V2, V1).
 *
 * Selection is by ADDRESS, not by role: with more than one legacy, "the legacy"
 * is ambiguous. Generation and fee model are derived per-vault so the migration
 * UI can state both sides of a move honestly — a share-denominated legacy
 * (V1/V2 burn 1.01 shares to redeem) versus the ETH-fee primary (V3 burns
 * exactly 1.0 and charges ETH).
 *
 * Never remove a LEGACY from env until heldTokenCount on that vault is 0 — doing
 * so bricks every call to it client-side ("Blocked unsafe vault target").
 */

import {
  MARKET_VAULT_ADDRESS,
  MARKET_VAULT_ADDRESSES,
  MARKET_VAULT_LEGACY_ADDRESSES,
  MARKET_VAULT_V1_KNOWN,
  MARKET_VAULT_V2_KNOWN,
} from "@/lib/constants";

export type VaultRole = "primary" | "legacy";
/** How a vault denominates its mint/redeem fee. */
export type FeeModel = "share" | "eth";

export type VaultDescriptor = {
  role: VaultRole;
  address: string;
  /** 1 = V1, 2 = V2, 3 = V3 (current). */
  generation: number;
  /** "Vn" short label. */
  version: string;
  /** Share-denominated (V1/V2) vs ETH-denominated (V3+) fees. */
  feeModel: FeeModel;
  /** Short UI label. */
  label: string;
  /** One-line purpose. */
  purpose: string;
  /** True when this is the historically first production vault. */
  isV1: boolean;
};

export function isVaultAddress(addr: string | null | undefined): addr is string {
  return Boolean(addr && /^0x[0-9a-fA-F]{40}$/.test(addr));
}

export function shortVault(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Generation from address. The two prior production vaults are known by
 * address; anything else configured is the current generation (V3+, ETH fees).
 * This is what lets the client stop grepping bytecode for selectors.
 */
export function vaultGeneration(addr: string | null | undefined): number {
  if (!addr) return 0;
  const lc = addr.toLowerCase();
  if (lc === MARKET_VAULT_V1_KNOWN.toLowerCase()) return 1;
  if (lc === MARKET_VAULT_V2_KNOWN.toLowerCase()) return 2;
  return 3;
}

export function feeModelForVault(addr: string | null | undefined): FeeModel {
  return vaultGeneration(addr) >= 3 ? "eth" : "share";
}

/** UI colour coding, keyed by generation. v3 primary = emerald (good). */
export type VaultColorKind = "v1" | "v2" | "v3" | "unknown";

export function vaultColorKind(
  roleOrAddr?: VaultRole | string | null
): VaultColorKind {
  if (!roleOrAddr) return "unknown";
  if (roleOrAddr === "primary") return genKind(vaultGeneration(MARKET_VAULT_ADDRESS));
  if (roleOrAddr === "legacy") {
    // Ambiguous with multiple legacies; the oldest is the safe default label.
    const oldest = [...MARKET_VAULT_LEGACY_ADDRESSES].sort(
      (a, b) => vaultGeneration(a) - vaultGeneration(b)
    )[0];
    return genKind(vaultGeneration(oldest));
  }
  return genKind(vaultGeneration(roleOrAddr));
}

function genKind(gen: number): VaultColorKind {
  if (gen === 1) return "v1";
  if (gen === 2) return "v2";
  if (gen >= 3) return "v3";
  return "unknown";
}

/** "V1" / "V2" / "V3" / "Vault" from a colour kind. */
export function vaultKindLabel(kind: VaultColorKind): string {
  return kind === "unknown" ? "Vault" : kind.toUpperCase();
}

/** Tailwind classes for vault badges/labels. V2 is demoted (it is retiring). */
export const VAULT_LABEL_CLASS: Record<VaultColorKind, string> = {
  v1: "text-orange-400 border-orange-400/50 bg-orange-500/15",
  v2: "text-amber-400 border-amber-400/50 bg-amber-500/15",
  v3: "text-emerald-400 border-emerald-400/50 bg-emerald-500/15",
  unknown: "text-foreground/50 border-gold-500/25 bg-black/20",
};

export const VAULT_TEXT_CLASS: Record<VaultColorKind, string> = {
  v1: "text-orange-400",
  v2: "text-amber-400",
  v3: "text-emerald-400",
  unknown: "text-gold-200",
};

function describe(role: VaultRole, address: string): VaultDescriptor {
  const generation = vaultGeneration(address);
  const feeModel = feeModelForVault(address);
  const version = generation > 0 ? `V${generation}` : "Vault";
  const isV1 = generation === 1;
  let label: string;
  let purpose: string;
  if (role === "primary") {
    label = `${version} — Current vault`;
    purpose = "Deposit, redeem, Instant Swap, and provide liquidity";
  } else if (generation === 2) {
    label = "V2 — Legacy (retiring)";
    purpose = "Withdraw LP and redeem here, then migrate to the current vault";
  } else {
    label = `${version} — Legacy vault`;
    purpose = "Redeem existing deposits, then migrate — do not abandon until empty";
  }
  return { role, address, generation, version, feeModel, label, purpose, isV1 };
}

/** All vaults the migrate UI and Instant Swap may target, primary first. */
export function listVaults(): VaultDescriptor[] {
  const out: VaultDescriptor[] = [];
  if (MARKET_VAULT_ADDRESS) out.push(describe("primary", MARKET_VAULT_ADDRESS));
  for (const addr of MARKET_VAULT_LEGACY_ADDRESSES) out.push(describe("legacy", addr));
  return out;
}

/** Primary-first, then legacies oldest-last (V2 before V1). */
export function listVaultsForDisplay(): VaultDescriptor[] {
  const all = listVaults();
  const primary = all.filter((v) => v.role === "primary");
  const legacy = all
    .filter((v) => v.role === "legacy")
    .sort((a, b) => b.generation - a.generation);
  return [...primary, ...legacy];
}

/** Selection primitive — address is the identity key, not role. */
export function getVaultByAddress(addr: string | null | undefined): VaultDescriptor | null {
  if (!addr) return null;
  const lc = addr.toLowerCase();
  return listVaults().find((v) => v.address.toLowerCase() === lc) ?? null;
}

/** Back-compat: the first vault in a role. Prefer getVaultByAddress. */
export function getVaultByRole(role: VaultRole): VaultDescriptor | null {
  return listVaults().find((v) => v.role === role) ?? null;
}

export function dualVaultMode(): boolean {
  return MARKET_VAULT_ADDRESSES.length > 1;
}

/** True when there is at least one legacy to migrate out of. */
export function multiVaultMode(): boolean {
  return MARKET_VAULT_LEGACY_ADDRESSES.length > 0;
}

/**
 * Legacy (V1/V2) share-denominated fee defaults: 1% mint, 1% redeem, 2.5%
 * target premium. Live-checked in the migrate panel; these are the known
 * production defaults for walkthrough math on the SHARE-model vaults.
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
 * Honest migration cost for one NFT round-trip out of a SHARE-model legacy
 * (V1/V2): deposit got mintSharesOut; redeem needs redeemCost. On the ETH-model
 * destination (V3) a deposit mints exactly one share for a flat ETH fee, so
 * there is no re-deposit share shortfall — the only friction on that side is the
 * flat ETH fee, surfaced separately.
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
  dustSharesNeeded: string;
  roundTripShareFriction: string;
  summary: string;
} {
  const fromDeposit = mintSharesOut(fees.mintFeeBps);
  const randomCost = redeemCostShares(fees.redeemFeeBps, fees.targetPremiumBps, false);
  const targetCost = redeemCostShares(fees.redeemFeeBps, fees.targetPremiumBps, true);
  const shortfall = randomCost > fromDeposit ? randomCost - fromDeposit : BigInt(0);
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
        ? `On this legacy vault a single deposit minted ~${fmt(fromDeposit)} shares but a redeem burns ~${fmt(randomCost)}, so a lone deposit is ~${fmt(shortfall)} short of redeeming. Buy the small difference on Instant Swap, or redeem across your other planks. The new vault does not have this gap — it mints and burns exactly one share and charges a flat ETH fee.`
        : `A single deposit here covers a redeem on this fee schedule.`,
  };
}
