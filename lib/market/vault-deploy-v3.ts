/**
 * Shared client+server contract for dispatching
 * `.github/workflows/deploy-vault-v3.yml` — the gated GitHub Actions job that
 * deploys MarketplankVaultV3 (procedure: docs/marketplank/DEPLOY-V3-RUNBOOK.md).
 *
 * This module owns the field list and the pre-flight validation, used by both
 * the admin form (components/admin/sections/CollectionsSection.tsx, so an
 * admin can't submit a dispatch that will revert on-chain or fail the
 * workflow's own guardrail) and the API route
 * (app/api/admin/vault-deploy/route.ts, so the server never trusts the
 * client's validation alone). No secrets live here — this is pure data
 * shape + arithmetic, safe to import from a "use client" component.
 *
 * The ceilings below mirror contracts/MarketplankVaultV3.sol's private
 * MAX_MINT_FEE_WEI / MAX_REDEEM_FEE_WEI / MAX_TARGET_PREMIUM_WEI /
 * MAX_SWAP_FEE_BPS constants, checked in its constructor. The non-zero
 * mint/redeem requirement mirrors the workflow's own "Guardrails" step
 * (audit AUDIT-2026-08-01 Low-1) — a zero fee nullifies the redeem-slot rate
 * limiter and the workflow's job.deploy step itself will hard-fail on it, so
 * failing this earlier here just avoids burning a CI run to CI-fail.
 */

export const VAULT_DEPLOY_NETWORKS = ["robinhood-testnet", "robinhood"] as const;
export type VaultDeployNetwork = (typeof VAULT_DEPLOY_NETWORKS)[number];

// BigInt(...) calls, not `n` literals — this file targets ES2017 (tsconfig),
// which rejects BigInt literal syntax even though bigint itself is fine.
export const MAX_MINT_FEE_WEI = BigInt("50000000000000000"); // 0.05 ether
export const MAX_REDEEM_FEE_WEI = BigInt("50000000000000000"); // 0.05 ether
export const MAX_TARGET_PREMIUM_WEI = BigInt("100000000000000000"); // 0.1 ether
export const MAX_SWAP_FEE_BPS = 100;

/** The literal string the workflow requires as `confirmation` for a mainnet run. */
export const MAINNET_CONFIRMATION = "DEPLOY_V3_MAINNET";

/** The exact name/symbol that deployed the live RobinWood pool — also the
 * workflow's and the script's own defaults (scripts/deploy-and-seed-v3.ts).
 * Kept here so the form can start with the same values without having to
 * special-case "RobinWood" anywhere in its logic. */
export const DEFAULT_SHARE_NAME = "Marketplank RobinWood Vault V3";
export const DEFAULT_SHARE_SYMBOL = "vROBIN";
const MAX_SHARE_NAME_LENGTH = 64;
const MAX_SHARE_SYMBOL_LENGTH = 11;

/** Every `workflow_dispatch` input the workflow accepts, as strings (GitHub
 * Actions inputs are always strings/booleans over the REST API). */
export type VaultDeployInput = {
  network: VaultDeployNetwork;
  confirmation: string;
  treasury: string;
  collection: string;
  shareName: string;
  shareSymbol: string;
  mintFeeWei: string;
  redeemFeeWei: string;
  targetPremiumWei: string;
  swapFeeBps: string;
  seedTokenIds: string;
  seedEthWei: string;
  confirmOpen: boolean;
};

export const EMPTY_VAULT_DEPLOY_INPUT: VaultDeployInput = {
  network: "robinhood-testnet",
  confirmation: "",
  treasury: "",
  collection: "",
  // Same defaults as the workflow/script — a dispatch with these values
  // unchanged reproduces the live RobinWood deploy byte-for-byte.
  shareName: DEFAULT_SHARE_NAME,
  shareSymbol: DEFAULT_SHARE_SYMBOL,
  mintFeeWei: "",
  redeemFeeWei: "",
  targetPremiumWei: "",
  swapFeeBps: "30", // matches the workflow's own historical default (30 bps)
  seedTokenIds: "",
  seedEthWei: "",
  confirmOpen: false,
};

export type VaultDeployProblem = {
  field: keyof VaultDeployInput;
  message: string;
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Whole non-negative integer wei string -> bigint, or null if malformed. */
function parseWei(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** "50000000000000000" -> "0.05" for the live ETH-equivalent hint in the form. */
export function weiToEthDisplay(raw: string): string | null {
  const wei = parseWei(raw);
  if (wei === null) return null;
  const ONE_ETHER = BigInt("1000000000000000000");
  const whole = wei / ONE_ETHER;
  const frac = (wei % ONE_ETHER).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Validate a dispatch input against the contract's constructor ceilings and
 * the workflow's own guardrails. Returns every problem found (not just the
 * first) so the form can flag every offending field at once.
 */
export function validateVaultDeployInput(
  input: VaultDeployInput
): VaultDeployProblem[] {
  const problems: VaultDeployProblem[] = [];

  if (!VAULT_DEPLOY_NETWORKS.includes(input.network)) {
    problems.push({ field: "network", message: "Pick a network." });
  }
  const isMainnet = input.network === "robinhood";

  if (isMainnet && input.confirmation.trim() !== MAINNET_CONFIRMATION) {
    problems.push({
      field: "confirmation",
      message: `Mainnet requires typing exactly "${MAINNET_CONFIRMATION}".`,
    });
  }

  if (isMainnet && !input.treasury.trim()) {
    problems.push({
      field: "treasury",
      message:
        "Mainnet requires a treasury address — it must equal the deploy key the workflow signs with.",
    });
  } else if (input.treasury.trim() && !HEX_ADDRESS.test(input.treasury.trim())) {
    problems.push({ field: "treasury", message: "Not a valid 0x address." });
  }

  if (isMainnet && !HEX_ADDRESS.test(input.collection.trim())) {
    problems.push({
      field: "collection",
      message: "Mainnet requires a valid 0x ERC-721 collection address.",
    });
  } else if (input.collection.trim() && !HEX_ADDRESS.test(input.collection.trim())) {
    problems.push({ field: "collection", message: "Not a valid 0x address." });
  }

  // Constructor args, immutable on success — a blank field is a mistake,
  // not a request for the RobinWood default (see EMPTY_VAULT_DEPLOY_INPUT's
  // comment); the workflow's own guardrail rejects a blank dispatch too.
  const name = input.shareName.trim();
  if (!name) {
    problems.push({ field: "shareName", message: "Required — cannot be blank." });
  } else if (name.length > MAX_SHARE_NAME_LENGTH) {
    problems.push({
      field: "shareName",
      message: `Keep it to ${MAX_SHARE_NAME_LENGTH} characters or fewer.`,
    });
  }

  const symbol = input.shareSymbol.trim();
  if (!symbol) {
    problems.push({ field: "shareSymbol", message: "Required — cannot be blank." });
  } else if (symbol.length > MAX_SHARE_SYMBOL_LENGTH) {
    problems.push({
      field: "shareSymbol",
      message: `Keep it to ${MAX_SHARE_SYMBOL_LENGTH} characters or fewer.`,
    });
  } else if (!/^[A-Z0-9]+$/.test(symbol)) {
    problems.push({
      field: "shareSymbol",
      message: "Uppercase letters and digits only, by convention (e.g. vROBIN).",
    });
  }

  const mint = parseWei(input.mintFeeWei);
  if (mint === null) {
    problems.push({ field: "mintFeeWei", message: "Whole-number wei only." });
  } else if (mint <= BigInt(0)) {
    problems.push({
      field: "mintFeeWei",
      message: "Must be > 0 — the workflow refuses a zero mint fee.",
    });
  } else if (mint > MAX_MINT_FEE_WEI) {
    problems.push({
      field: "mintFeeWei",
      message: "Exceeds the contract's 0.05 ETH ceiling — the deploy would revert.",
    });
  }

  const redeem = parseWei(input.redeemFeeWei);
  if (redeem === null) {
    problems.push({ field: "redeemFeeWei", message: "Whole-number wei only." });
  } else if (redeem <= BigInt(0)) {
    problems.push({
      field: "redeemFeeWei",
      message: "Must be > 0 — the workflow refuses a zero redeem fee.",
    });
  } else if (redeem > MAX_REDEEM_FEE_WEI) {
    problems.push({
      field: "redeemFeeWei",
      message: "Exceeds the contract's 0.05 ETH ceiling — the deploy would revert.",
    });
  }

  const premium = parseWei(input.targetPremiumWei);
  if (premium === null) {
    problems.push({ field: "targetPremiumWei", message: "Whole-number wei only." });
  } else if (premium > MAX_TARGET_PREMIUM_WEI) {
    problems.push({
      field: "targetPremiumWei",
      message: "Exceeds the contract's 0.1 ETH ceiling — the deploy would revert.",
    });
  }

  const swapBps = input.swapFeeBps.trim();
  if (!/^\d+$/.test(swapBps)) {
    problems.push({ field: "swapFeeBps", message: "Whole number, basis points." });
  } else if (Number(swapBps) > MAX_SWAP_FEE_BPS) {
    problems.push({
      field: "swapFeeBps",
      message: `Exceeds the contract's ${MAX_SWAP_FEE_BPS} bps ceiling — the deploy would revert.`,
    });
  }

  if (!input.seedTokenIds.trim()) {
    problems.push({
      field: "seedTokenIds",
      message: "List at least one token id the treasury owns (comma or space separated).",
    });
  } else if (!/^[\d,\s]+$/.test(input.seedTokenIds.trim())) {
    problems.push({
      field: "seedTokenIds",
      message: "Digits only, separated by commas or spaces.",
    });
  }

  const seedEth = parseWei(input.seedEthWei);
  if (seedEth === null) {
    problems.push({
      field: "seedEthWei",
      message: "Whole-number wei only (0 is allowed if you are not opening yet).",
    });
  } else if (input.confirmOpen && seedEth <= BigInt(0)) {
    problems.push({
      field: "seedEthWei",
      message:
        "Opening requires ethReserve > 0 (the pre-open checklist) — seed ETH must be > 0 when Open is checked.",
    });
  }

  return problems;
}
