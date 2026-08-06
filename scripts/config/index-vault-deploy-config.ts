/**
 * ============================================================================
 *  index-vault-deploy-config — THE ONE PLACE a real deployer reads before
 *  touching testnet or mainnet (design doc §7.8, item 3).
 *
 *  Every risk parameter introduced across §7.2-§7.12 of
 *  docs/DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md is declared
 *  here, next to the on-chain hard ceiling it must never exceed (re-checked
 *  on-chain anyway, at execution — see IndexFacetBase.sol's CEIL_* constants
 *  and IndexParams.sol's MIN_/MAX_/CEIL_ constants; the constants below are a
 *  MIRROR for fail-fast validation in the deploy tooling, never the
 *  authority). Nothing here is a default meant to be deployed unread: every
 *  field with no safe universal answer either has no fallback (constructor
 *  throws) or is loaded from an explicit env var.
 *
 *  §7.9's build order landed every mechanism this config configures before
 *  this file existed (factory, §7.2/§7.3 splits, §7.5 weight/eligibility,
 *  §7.10 pool + dilution cap, §7.6 vesting guard, §7.7 buyback, §7.11 dev
 *  fund, §7.12 socialfi treasury) — this is deploy/parameter TOOLING over
 *  those already-built, already-tested mechanisms, not new contract logic.
 * ============================================================================
 */

// ── Hard, on-chain, non-governable ceilings (mirrored for fail-fast checks) ─
//
// Source of truth is Solidity, not here:
//   - contracts/diamond/facets/IndexFacetBase.sol (CEIL_PLATFORM_ALLOCATION_BPS,
//     CEIL_ECOSYSTEM_SPLIT_BPS, CEIL_BUYBACK_SPLIT_BPS, CEIL_DEV_FUND_BPS,
//     CEIL_PLATFORM_TREASURY_BPS)
//   - contracts/diamond/facets/IndexPoolFacet.sol (MAX_POOL_SHARE_BPS_CEIL,
//     DEFAULT_MAX_POOL_SHARE_BPS)
//   - contracts/lib/IndexParams.sol (MIN/MAX_CONCENTRATION_CAP_BPS,
//     CEIL_IMBALANCE_FEE_BPS, CEIL_BAND_BPS, CEIL_PRICE_CAP_BPS,
//     MIN/MAX_RAMP_DURATION)
export const BPS = 10_000n;

export const CEILINGS = {
  /** §7.2/§7.3 — operator share-mint allocation. */
  platformAllocationBps: 500n, // 5%
  /** §7.2 — swap-fee split routed to the ecosystem sink. */
  ecosystemFeeSplitBps: 3_000n, // 30%
  /** §7.7 — buyback sub-split of §7.3's value-accrual split. */
  buybackSplitBps: 5_000n, // 50%
  /** §7.11 — dev-fund PLANK-buy percentage of a mint's payment. */
  devFundBps: 200n, // 2%
  /** §7.12 — platform socialfi treasury carve-out of routed value. */
  socialFiTreasuryBps: 500n, // 5%
  /** §7.10 — dedicated-pool dilution cap, as a share of total supply. */
  maxPoolShareBps: 2_000n, // 20%
  /** §7.5 — concentration cap floor/ceiling. */
  concentrationCapBpsMin: 1_000n, // 10%
  concentrationCapBpsMax: 5_000n, // 50%
} as const;

/** §7.10's dilution cap seeded automatically by `executeIndexPool` — informational only, not separately settable at first-wire time. */
export const DEFAULT_MAX_POOL_SHARE_BPS = 500n; // 5%

// ── Env helpers ──────────────────────────────────────────────────────────

function reqAddr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (address) before running this script.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

function optAddr(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

function reqUint(name: string): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Set ${name} (uint) before running this script.`);
  return BigInt(v);
}

function optUint(name: string, def: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return BigInt(v);
}

// ── §7.9's twelve-field risk set (IndexParamSet order) ──────────────────
//
// Every field, its env var, and a conservative testnet-rehearsal default.
// There is NO mainnet default: MARKET_INDEX_* env vars are required in
// non-hardhat/localhost networks (enforced by `assertProductionReady` below),
// exactly like scripts/deploy-vault.ts's existing "no default network" and
// scripts/deploy-and-seed-v3.ts's "req()" discipline for immutable fields.
export function loadRiskParams() {
  return {
    concentrationCapBps: optUint("MARKET_INDEX_CONCENTRATION_CAP_BPS", 4_000n),
    baseImbalanceFeeBps: optUint("MARKET_INDEX_BASE_IMBALANCE_FEE_BPS", 10n),
    imbalanceSlopeBps: optUint("MARKET_INDEX_IMBALANCE_SLOPE_BPS", 500n),
    maxImbalanceFeeBps: optUint("MARKET_INDEX_MAX_IMBALANCE_FEE_BPS", 600n),
    bandBps: optUint("MARKET_INDEX_BAND_BPS", 100n),
    priceCapBps: optUint("MARKET_INDEX_PRICE_CAP_BPS", 500n),
    minCheckpointInterval: optUint("MARKET_INDEX_MIN_CHECKPOINT_INTERVAL", 600n),
    staleAfter: optUint("MARKET_INDEX_STALE_AFTER", 7_200n),
    persistenceCheckpoints: optUint("MARKET_INDEX_PERSISTENCE_CHECKPOINTS", 3n),
    persistenceToleranceBps: optUint("MARKET_INDEX_PERSISTENCE_TOLERANCE_BPS", 500n),
    largeOpValueWei: optUint("MARKET_INDEX_LARGE_OP_VALUE_WEI", 10n ** 19n),
    rampDuration: optUint("MARKET_INDEX_RAMP_DURATION", 30n * 24n * 3_600n),
  };
}

export function riskParamsTuple(p: ReturnType<typeof loadRiskParams>): bigint[] {
  return [
    p.concentrationCapBps,
    p.baseImbalanceFeeBps,
    p.imbalanceSlopeBps,
    p.maxImbalanceFeeBps,
    p.bandBps,
    p.priceCapBps,
    p.minCheckpointInterval,
    p.staleAfter,
    p.persistenceCheckpoints,
    p.persistenceToleranceBps,
    p.largeOpValueWei,
    p.rampDuration,
  ];
}

// ── Core diamond init (constructor-only fields) ──────────────────────────

export interface RoleSet {
  admin: string;
  admission: string;
  risk: string;
  allocation: string;
  streamLister: string;
}

/** [ADMIN, ADMISSION, RISK, ALLOCATION, STREAM_LISTER], in CoreInit.roles order. */
export function loadGenesisRoles(): RoleSet {
  return {
    admin: reqAddr("MARKET_INDEX_ROLE_ADMIN"),
    admission: reqAddr("MARKET_INDEX_ROLE_ADMISSION"),
    risk: reqAddr("MARKET_INDEX_ROLE_RISK"),
    allocation: reqAddr("MARKET_INDEX_ROLE_ALLOCATION"),
    streamLister: process.env.MARKET_INDEX_ROLE_STREAM_LISTER
      ? reqAddr("MARKET_INDEX_ROLE_STREAM_LISTER")
      : reqAddr("MARKET_INDEX_ROLE_ADMISSION"),
  };
}

export function rolesTuple(r: RoleSet): [string, string, string, string, string] {
  return [r.admin, r.admission, r.risk, r.allocation, r.streamLister];
}

export interface CoreDeployConfig {
  name: string;
  symbol: string;
  seeder: string;
  dividendAsset: string;
  timelockDelay: bigint;
}

export function loadCoreConfig(): CoreDeployConfig {
  return {
    name: process.env.MARKET_INDEX_NAME || "Marketplank Global Index",
    symbol: process.env.MARKET_INDEX_SYMBOL || "gPLNK",
    seeder: reqAddr("MARKET_INDEX_SEEDER"),
    dividendAsset: reqAddr("MARKET_INDEX_DIVIDEND_ASSET"),
    // Floor is enforced by the diamond's own constructor
    // (Diamond.TimelockDelayBelowFloor) — this default (48h) matches every
    // existing test fixture's TIMELOCK constant.
    timelockDelay: optUint("MARKET_INDEX_TIMELOCK_DELAY", 48n * 3_600n),
  };
}

// ── §7.8 item 3: genesis constituent list ────────────────────────────────

export interface GenesisConstituent {
  /** ERC-20 v-token address. */
  token: string;
  /** IIndexPriceSource address for this constituent. */
  source: string;
  /** Raw target weight in bps (IndexEligibilityFacet/IndexGovernanceFacet). */
  rawTargetWeightBps: bigint;
  /** Amount to seedDeposit, in the token's own decimals. */
  seedAmount: bigint;
}

/**
 * Genesis constituents come from MARKET_INDEX_GENESIS_CONSTITUENTS, a JSON
 * array of {token,source,rawTargetWeightBps,seedAmount} (all strings/numeric
 * strings; seedAmount and rawTargetWeightBps parsed as bigint). No default
 * list is shipped in source — the genesis basket is a one-time, reviewed,
 * per-deployment decision, not a constant to accidentally reuse across
 * networks.
 */
export function loadGenesisConstituents(): GenesisConstituent[] {
  const raw = process.env.MARKET_INDEX_GENESIS_CONSTITUENTS;
  if (!raw) {
    throw new Error(
      "Set MARKET_INDEX_GENESIS_CONSTITUENTS to a JSON array of " +
        '[{"token":"0x..","source":"0x..","rawTargetWeightBps":"3333","seedAmount":"1000000000000000000000"}, ...] ' +
        "before seeding — there is no default genesis basket."
    );
  }
  const parsed = JSON.parse(raw) as Array<{
    token: string;
    source: string;
    rawTargetWeightBps: string | number;
    seedAmount: string | number;
  }>;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MARKET_INDEX_GENESIS_CONSTITUENTS must be a non-empty JSON array.");
  }
  return parsed.map((c, i) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.token)) throw new Error(`constituent[${i}].token is not an address`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.source)) throw new Error(`constituent[${i}].source is not an address`);
    return {
      token: c.token,
      source: c.source,
      rawTargetWeightBps: BigInt(c.rawTargetWeightBps),
      seedAmount: BigInt(c.seedAmount),
    };
  });
}

// ── §7.11/§7.12/§7.7/§7.2/§7.3 governed risk-surface parameters ─────────

export interface GovernanceConfig {
  /** §7.2/§7.3 — operator share-mint allocation, bps. Must be <= CEILINGS.platformAllocationBps. */
  platformAllocationBps: bigint;
  /** §7.2 — where the operator allocation is delivered. */
  platformTreasury?: string;
  /** §7.2 — swap-fee split routed to the ecosystem sink, bps. Must be <= CEILINGS.ecosystemFeeSplitBps. */
  ecosystemFeeSplitBps: bigint;
  /** §7.2 — the ecosystem fee sink contract (implements reinvestAsset()). */
  ecosystemSink?: string;
  /** §7.3 — dividend share of routed value, bps. */
  valueAccrualDividendBps: bigint;
  /** §7.7 — buyback share of routed value, bps. Must be <= CEILINGS.buybackSplitBps. Reserve gets the remainder. */
  valueAccrualBuybackBps: bigint;
  /** §7.5 — admission/eligibility thresholds. */
  targetHhiBps: bigint;
  minEligibilityFeesWei: bigint;
  minEligibilityBlocks: bigint;
  /** §7.11 — dev-fund PLANK-buy router (external swap venue). */
  devFundRouter?: string;
  /** §7.11 — dev-fund treasury (bought PLANK's destination). */
  devFundTreasury?: string;
  /** §7.11 — bps of a mint's payment skimmed toward the dev fund. Must be <= CEILINGS.devFundBps. */
  devFundBps: bigint;
  /** §7.12 — platform socialfi treasury address. */
  socialFiTreasury?: string;
  /** §7.12 — bps of routed value carved out before §7.3's split. Must be <= CEILINGS.socialFiTreasuryBps. */
  socialFiTreasuryBps: bigint;
  /** §7.10 — the dedicated index-coin/payment-token pool (wired once, one-way). */
  indexPool?: string;
  /** §7.10 — dilution cap override, bps of totalSupply. Leave undefined to keep executeIndexPool's 5% default. Must be <= CEILINGS.maxPoolShareBps. */
  maxPoolShareBps?: bigint;
}

export function loadGovernanceConfig(): GovernanceConfig {
  return {
    platformAllocationBps: optUint("MARKET_INDEX_PLATFORM_ALLOCATION_BPS", 0n),
    platformTreasury: optAddr("MARKET_INDEX_PLATFORM_TREASURY"),
    ecosystemFeeSplitBps: optUint("MARKET_INDEX_ECOSYSTEM_FEE_SPLIT_BPS", 0n),
    ecosystemSink: optAddr("MARKET_INDEX_ECOSYSTEM_SINK"),
    valueAccrualDividendBps: optUint("MARKET_INDEX_VALUE_ACCRUAL_DIVIDEND_BPS", 0n),
    valueAccrualBuybackBps: optUint("MARKET_INDEX_VALUE_ACCRUAL_BUYBACK_BPS", 0n),
    targetHhiBps: optUint("MARKET_INDEX_TARGET_HHI_BPS", 3_333n),
    minEligibilityFeesWei: optUint("MARKET_INDEX_MIN_ELIGIBILITY_FEES_WEI", 0n),
    minEligibilityBlocks: optUint("MARKET_INDEX_MIN_ELIGIBILITY_BLOCKS", 0n),
    devFundRouter: optAddr("MARKET_INDEX_DEV_FUND_ROUTER"),
    devFundTreasury: optAddr("MARKET_INDEX_DEV_FUND_TREASURY"),
    devFundBps: optUint("MARKET_INDEX_DEV_FUND_BPS", 0n),
    socialFiTreasury: optAddr("MARKET_INDEX_SOCIALFI_TREASURY"),
    socialFiTreasuryBps: optUint("MARKET_INDEX_SOCIALFI_TREASURY_BPS", 0n),
    indexPool: optAddr("MARKET_INDEX_POOL"),
    maxPoolShareBps: process.env.MARKET_INDEX_MAX_POOL_SHARE_BPS
      ? BigInt(process.env.MARKET_INDEX_MAX_POOL_SHARE_BPS)
      : undefined,
  };
}

/**
 * Fail fast, off-chain, against the SAME ceilings the contracts enforce
 * on-chain at execution. This is a convenience check only — it saves a
 * doomed queue+wait+revert round trip — never the authority: every one of
 * these is re-checked in Solidity (IndexFacetBase.sol's CEIL_* constants) at
 * `execute*` time regardless of what this function decides.
 */
export function validateGovernanceConfig(g: GovernanceConfig): void {
  const checks: Array<[string, bigint, bigint]> = [
    ["platformAllocationBps", g.platformAllocationBps, CEILINGS.platformAllocationBps],
    ["ecosystemFeeSplitBps", g.ecosystemFeeSplitBps, CEILINGS.ecosystemFeeSplitBps],
    ["valueAccrualBuybackBps", g.valueAccrualBuybackBps, CEILINGS.buybackSplitBps],
    ["devFundBps", g.devFundBps, CEILINGS.devFundBps],
    ["socialFiTreasuryBps", g.socialFiTreasuryBps, CEILINGS.socialFiTreasuryBps],
  ];
  for (const [name, value, ceil] of checks) {
    if (value > ceil) {
      throw new Error(`${name}=${value} exceeds its governed ceiling ${ceil} (see IndexFacetBase.sol CEIL_*).`);
    }
  }
  if (g.valueAccrualDividendBps + g.valueAccrualBuybackBps > BPS) {
    throw new Error("valueAccrualDividendBps + valueAccrualBuybackBps must not exceed 10,000 bps.");
  }
  if (g.maxPoolShareBps !== undefined && g.maxPoolShareBps > CEILINGS.maxPoolShareBps) {
    throw new Error(`maxPoolShareBps=${g.maxPoolShareBps} exceeds MAX_POOL_SHARE_BPS_CEIL ${CEILINGS.maxPoolShareBps}.`);
  }
}

/**
 * Refuse to run a mainnet/testnet-shaped invocation with any field left at
 * its rehearsal default of zero/undefined where the design doc requires an
 * explicit decision (design doc §7.8: "risk parameters ... named in
 * §§7.2-7.7" plus §7.11/§7.12's two later splits). Hardhat's in-process
 * network and `localhost` are exempt so the local verification harness
 * (§7.8 item 5) can run against zeros without operator input.
 */
export function assertProductionReady(networkName: string, g: GovernanceConfig): void {
  if (networkName === "hardhat" || networkName === "localhost") return;
  const required: Array<[string, unknown]> = [
    ["MARKET_INDEX_PLATFORM_TREASURY", g.platformTreasury],
    ["MARKET_INDEX_DEV_FUND_TREASURY", g.devFundTreasury],
    ["MARKET_INDEX_SOCIALFI_TREASURY", g.socialFiTreasury],
  ];
  const missing = required.filter(([, v]) => v === undefined).map(([n]) => n);
  if (missing.length) {
    throw new Error(
      `Refusing to configure network "${networkName}" with unset production addresses: ${missing.join(", ")}. ` +
        "This is deliberate — see hardhat.config.ts's header on never having a one-command path to a real network by accident."
    );
  }
}
