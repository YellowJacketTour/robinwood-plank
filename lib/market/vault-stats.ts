import { Interface } from "ethers";
import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { V3_IFACE } from "@/lib/market/vault-v3";
import { feeModelForVault, type FeeModel } from "@/lib/market/vault-registry";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { getEthUsdPrice } from "@/lib/eth-price";
import { fetchActivity } from "@/lib/market/activity";
import { getVaultActivity, type VaultTradeEvent } from "@/lib/market/vault-activity";
import { MARKET_DEFAULT_FEE_BPS } from "@/lib/constants";
import { withTimeout } from "@/lib/market/rpc-budget";
import { ethCallManyDisplay } from "@/lib/market/fetch-rpc";

function resolveStatsVault(vaultAddress?: string | null): string | null {
  if (vaultAddress && /^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    const hit = MARKET_VAULT_ADDRESSES.find(
      (a) => a.toLowerCase() === vaultAddress.toLowerCase()
    );
    if (hit) return hit;
  }
  return MARKET_VAULT_ADDRESS;
}

/** Legacy (V1/V2, share-fee) call surface — kept exactly as it always was. */
const IFACE = new Interface(vaultAbi);
const SHARE_UNIT = BigInt(1_000_000_000_000_000_000);

/**
 * `mintFeeBps`, `redeemFeeBps` and `targetPremiumBps` are declared `immutable`
 * in contracts/MarketplankVault.sol — set once in the constructor, with no
 * setter anywhere. Their value cannot change for the life of the vault.
 *
 * They were nonetheless being re-read on every stats refresh, and the vault SSE
 * stream ticks every 8s (app/api/market/vault/stream/route.ts) — longer than the
 * 5s rpc-cache TTL, so essentially every tick paid for all three. That is 3 x 26
 * CU forever, to learn a number that is carved into the bytecode: the same
 * mistake CONTRIBUTING.md records against MintPanel, in a different file.
 *
 * Read once per vault per process, then never again.
 */
type ImmutableVaultConfig = {
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
};

const immutableConfigCache = new Map<string, ImmutableVaultConfig>();
const immutableConfigInflight = new Map<string, Promise<ImmutableVaultConfig>>();

async function getImmutableVaultConfig(vault: string): Promise<ImmutableVaultConfig> {
  const key = vault.toLowerCase();
  const cached = immutableConfigCache.get(key);
  if (cached) return cached;

  const existing = immutableConfigInflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<ImmutableVaultConfig> => {
    const [mintFeeHex, redeemFeeHex, premiumHex] = await ethCallManyDisplay([
      { to: vault, data: IFACE.encodeFunctionData("mintFeeBps", []) },
      { to: vault, data: IFACE.encodeFunctionData("redeemFeeBps", []) },
      { to: vault, data: IFACE.encodeFunctionData("targetPremiumBps", []) },
    ]);
    const config: ImmutableVaultConfig = {
      mintFeeBps: Number(IFACE.decodeFunctionResult("mintFeeBps", mintFeeHex)[0]),
      redeemFeeBps: Number(IFACE.decodeFunctionResult("redeemFeeBps", redeemFeeHex)[0]),
      targetPremiumBps: Number(
        IFACE.decodeFunctionResult("targetPremiumBps", premiumHex)[0]
      ),
    };
    // Only pin a plausible read. A malformed/empty decode returning 0 across the
    // board would otherwise be frozen in for the process lifetime.
    if (Number.isFinite(config.mintFeeBps) && Number.isFinite(config.redeemFeeBps)) {
      immutableConfigCache.set(key, config);
    }
    return config;
  })().finally(() => {
    immutableConfigInflight.delete(key);
  });

  immutableConfigInflight.set(key, task);
  return task;
}

/**
 * V3+ (ETH-fee) equivalent of getImmutableVaultConfig. mintFeeWei, redeemFeeWei,
 * targetPremiumWei and swapFeeBps are all `immutable` in
 * contracts/MarketplankVaultV3.sol (constructor-set, no setter) — same
 * once-per-process caching rationale as the legacy config above.
 */
type ImmutableVaultV3Config = {
  mintFeeWei: bigint;
  redeemFeeWei: bigint;
  targetPremiumWei: bigint;
  swapFeeBps: number;
};

const immutableV3ConfigCache = new Map<string, ImmutableVaultV3Config>();
const immutableV3ConfigInflight = new Map<string, Promise<ImmutableVaultV3Config>>();

async function getImmutableVaultV3Config(vault: string): Promise<ImmutableVaultV3Config> {
  const key = vault.toLowerCase();
  const cached = immutableV3ConfigCache.get(key);
  if (cached) return cached;

  const existing = immutableV3ConfigInflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<ImmutableVaultV3Config> => {
    const [mintFeeHex, redeemFeeHex, premiumHex, swapFeeHex] = await ethCallManyDisplay([
      { to: vault, data: V3_IFACE.encodeFunctionData("mintFeeWei", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("redeemFeeWei", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("targetPremiumWei", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("swapFeeBps", []) },
    ]);
    const config: ImmutableVaultV3Config = {
      mintFeeWei: BigInt(V3_IFACE.decodeFunctionResult("mintFeeWei", mintFeeHex)[0]),
      redeemFeeWei: BigInt(V3_IFACE.decodeFunctionResult("redeemFeeWei", redeemFeeHex)[0]),
      targetPremiumWei: BigInt(
        V3_IFACE.decodeFunctionResult("targetPremiumWei", premiumHex)[0]
      ),
      swapFeeBps: Number(V3_IFACE.decodeFunctionResult("swapFeeBps", swapFeeHex)[0]),
    };
    // Same guard as the legacy cache — never pin an empty/malformed decode.
    if (Number.isFinite(config.swapFeeBps)) {
      immutableV3ConfigCache.set(key, config);
    }
    return config;
  })().finally(() => {
    immutableV3ConfigInflight.delete(key);
  });

  immutableV3ConfigInflight.set(key, task);
  return task;
}

/** Test/ops hook — lets a test prove the second read costs nothing. */
export function clearImmutableVaultConfigCache(): void {
  immutableConfigCache.clear();
  immutableConfigInflight.clear();
  immutableV3ConfigCache.clear();
  immutableV3ConfigInflight.clear();
}

/**
 * A vault's fee schedule, tagged by the model it actually charges in — see
 * lib/market/vault-registry.ts's feeModelForVault. Never coerce one into the
 * other: V3's fees are flat ETH, not a percentage of share value, so printing
 * them as bps would be a fabricated number.
 */
type FeeSchedule =
  | { model: "share"; mintFeeBps: number; redeemFeeBps: number; targetPremiumBps: number }
  | { model: "eth"; mintFeeWei: bigint; redeemFeeWei: bigint; targetPremiumWei: bigint; swapFeeBps: number };

async function getFeeSchedule(vault: string, feeModel: FeeModel): Promise<FeeSchedule> {
  if (feeModel === "eth") {
    const c = await getImmutableVaultV3Config(vault);
    return { model: "eth", ...c };
  }
  const c = await getImmutableVaultConfig(vault);
  return { model: "share", ...c };
}

/** The four values that can actually change, read with the ABI that matches
 *  this vault's generation. Immutable fee/premium getters never belong in
 *  this batch — see getFeeSchedule / the two config caches above.
 *  Exported: this is the cheap 4-call read (no held-token-id / APR / activity
 *  scan) that a per-vault summary — e.g. the admin Finance dashboard —
 *  should use instead of the much heavier getVaultStats. */
export async function readCoreVaultState(
  vault: string,
  feeModel: FeeModel
): Promise<{
  ethReserveWei: bigint;
  shareReserveWei: bigint;
  heldTokenCount: number;
  poolOpen: boolean;
}> {
  // LIVE_BATCH_START — test/market/vault-immutable-config.test.ts slices
  // between these two markers; keep both models' live batches inside them,
  // and keep every constructor-immutable fee getter out.
  if (feeModel === "eth") {
    const [ethHex, shareHex, heldHex, openHex] = await ethCallManyDisplay([
      { to: vault, data: V3_IFACE.encodeFunctionData("ethReserve", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("shareReserve", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("heldTokenCount", []) },
      { to: vault, data: V3_IFACE.encodeFunctionData("poolOpen", []) },
    ]);
    return {
      ethReserveWei: BigInt(V3_IFACE.decodeFunctionResult("ethReserve", ethHex)[0]),
      shareReserveWei: BigInt(V3_IFACE.decodeFunctionResult("shareReserve", shareHex)[0]),
      heldTokenCount: Number(V3_IFACE.decodeFunctionResult("heldTokenCount", heldHex)[0]),
      poolOpen: Boolean(V3_IFACE.decodeFunctionResult("poolOpen", openHex)[0]),
    };
  }
  const [ethHex, shareHex, heldHex, openHex] = await ethCallManyDisplay([
    { to: vault, data: IFACE.encodeFunctionData("ethReserve", []) },
    { to: vault, data: IFACE.encodeFunctionData("balanceOf", [vault]) },
    { to: vault, data: IFACE.encodeFunctionData("heldTokenCount", []) },
    { to: vault, data: IFACE.encodeFunctionData("poolOpen", []) },
  ]);
  return {
    ethReserveWei: BigInt(IFACE.decodeFunctionResult("ethReserve", ethHex)[0]),
    shareReserveWei: BigInt(IFACE.decodeFunctionResult("balanceOf", shareHex)[0]),
    heldTokenCount: Number(IFACE.decodeFunctionResult("heldTokenCount", heldHex)[0]),
    poolOpen: Boolean(IFACE.decodeFunctionResult("poolOpen", openHex)[0]),
  };
  // LIVE_BATCH_END
}

/**
 * The full definition of a "valid" LP APR — the owner's own words: "display
 * what its supposed to be if valid... if not then we can skip it." Every
 * condition that gates whether computeLpApr renders a figure at all lives
 * HERE, in one place, so changing the bar means changing one constant, not
 * hunting through the function for a second copy of the same idea. The four
 * conditions (see computeLpApr for where each is actually checked):
 *
 *   1. The vault charges a swap fee at all (gen-3/eth-fee model,
 *      swapFeeBps > 0). Legacy buyShares/sellShares apply none — see the
 *      aprPct docs on VaultStats — so those vaults can never clear this,
 *      structurally, not because their data is thin.
 *   2. There is real swap volume with at least one parseable timestamp.
 *   3. The TRUE measured window is at least MIN_HOURS_FOR_APR. Annualizing
 *      a two-swap, five-minute window is an ~8760x extrapolation from a
 *      sample of one; a four-swap, 5.6h window is still a ~1560x
 *      extrapolation. This is the number an LP reads before committing
 *      liquidity — a dash for a pool's first day is a true statement; a
 *      four-figure annualized rate off an afternoon is not, however
 *      honestly the basis is labelled. MUST be enforced as a genuine gate
 *      (see annualizeApr's guard), never as a floor a real-but-thin window
 *      gets clamped up to — that reintroduces a fabricated basis under a
 *      different name.
 *   4. At least MIN_SWAPS_FOR_APR distinct swap events fall inside that
 *      window. A pool can sit for a day and take two trades — 24 elapsed
 *      hours with a two-event sample is a thin number wearing a respectable
 *      window. This is a noise floor, not a statistical claim; 5 is a
 *      judgement call, made explicitly rather than left implicit.
 *
 * One bar, used identically for the public Instant Swap page and the admin
 * dashboard — not a laxer admin threshold that would need its own name and
 * its own "provisional" labeling to stay honest.
 *
 * aprBasisHours is only ever set alongside a non-null aprPct (see
 * computeLpApr) specifically so a caller can never see a "measured" hours
 * figure sitting next to a null rate, or an unmeasured/clamped span at all.
 */
const MIN_HOURS_FOR_APR = 24;
/** See MIN_HOURS_FOR_APR's docs (condition 4) — the noise-floor event count. */
const MIN_SWAPS_FOR_APR = 5;

/** ETH actually paid per deposit under this fee schedule. Share-model vaults
 *  charge a bps cut of one share, valued at the live share price; V3 charges a
 *  flat ETH fee that needs no conversion at all. */
function feePerDepositWei(schedule: FeeSchedule, sharePriceWei: bigint | null): bigint {
  if (schedule.model === "eth") return schedule.mintFeeWei;
  if (sharePriceWei == null) return BigInt(0);
  const feeShares = (SHARE_UNIT * BigInt(schedule.mintFeeBps)) / BigInt(10_000);
  return feeEthFromShares(feeShares, sharePriceWei);
}

/** ETH actually paid per (random) redeem — mirrors feePerDepositWei. Random
 *  redeem never pays the target premium on either model, so this must not
 *  include it (matches v3RequestRandomRedeem, which pays redeemFeeWei only). */
function feePerRedeemWei(schedule: FeeSchedule, sharePriceWei: bigint | null): bigint {
  if (schedule.model === "eth") return schedule.redeemFeeWei;
  if (sharePriceWei == null) return BigInt(0);
  const feeShares = (SHARE_UNIT * BigInt(schedule.redeemFeeBps)) / BigInt(10_000);
  return feeEthFromShares(feeShares, sharePriceWei);
}

export type VaultStats = {
  poolOpen: boolean;
  ethReserveWei: string;
  shareReserveWei: string;
  heldTokenCount: number;
  heldTokenIds: string[];
  /** wei per whole share, from the live AMM ratio — undefined pool (no
   * reserves) has no price. */
  sharePriceWei: string | null;
  /** Which fee model this vault actually charges under — see
   * lib/market/vault-registry.ts's feeModelForVault. Determines which of the
   * two field groups below are populated. */
  feeModel: FeeModel;
  /** Share-model (V1/V2) fees, as bps of one share. Null on an eth-model vault
   * — there is no bps figure to report, not a fabricated 0. */
  mintFeeBps: number | null;
  redeemFeeBps: number | null;
  targetPremiumBps: number | null;
  /** Eth-model (V3+) fees, flat wei amounts (as decimal strings). Null on a
   * share-model vault. */
  mintFeeWei: string | null;
  redeemFeeWei: string | null;
  targetPremiumWei: string | null;
  /** Eth-model only: the buy/sell AMM fee. Null on a share-model vault, which
   * has no separate swap fee. */
  swapFeeBps: number | null;
  ethUsd: number | null;
  /**
   * LP yield, annualized from real AMM swap-fee revenue — NOT mint/redeem
   * fee revenue. Verified against the contracts: mint/redeem fees always do
   * `accruedFees += msg.value` and pay out ONLY to the immutable treasury
   * via withdrawFees() — they never reach liquidity providers (see
   * MarketplankVaultV3.sol lines 298/317/332/418/452). The swap fee is the
   * only thing that grows the pool for LPs (line 478: "k strictly grows and
   * LPs earn the fee") — buyShares/sellShares discount the traded side by
   * swapFeeBps before pricing the AMM output, and the FULL (undiscounted)
   * amount still joins the reserve, so that discount is exactly the LP's
   * take. Computed by computeLpApr() below, over the real observed window
   * of Bought/Sold events for this vault — null when there isn't enough of
   * it to mean anything (see MIN_HOURS_FOR_APR), never a fabricated
   * placeholder number and never asserting a window nobody measured.
   *
   * Legacy (share-fee, V1/V2) vaults always report null here: their
   * buyShares/sellShares apply no fee at all (no swapFeeBps on that
   * contract — see contracts/MarketplankVault.sol), so k is exactly
   * conserved and LPs earn nothing from swap volume on those pools. There
   * is no LP-fee APR to compute for them, not an unmeasured one.
   */
  aprPct: number | null;
  aprBasisHours: number | null;
  depositCount: number;
  redeemCount: number;
  /**
   * Mint/redeem fee revenue actually observed over the same replay window
   * as depositCount/redeemCount, valued at the current share price. This is
   * TREASURY income (see aprPct's docs above for why) — a lower bound on
   * real fees collected, not the lifetime total, never fabricated, and
   * never to be presented as LP yield/APR on a public trading surface.
   */
  vaultFeeRevenueWei: string;
  /** Marketplace (Seaport) listing/offer fee revenue — ESTIMATED as
   * MARKET_DEFAULT_FEE_BPS of observed sale volume from the same recent
   * activity feed the Activity tab uses, since individual fee-consideration
   * amounts aren't separately indexed. Clearly an estimate, not a ledger. */
  marketplaceFeeRevenueEstWei: string;
};

/**
 * Full public dashboard state for the vault: reserves, live rate, fee
 * schedule, USD conversion, current inventory (via the same Transfer-log
 * replay vault-held.ts already does), and a trailing fee-revenue APR
 * estimate replayed from real on-chain Deposited/Redeemed events — never
 * assumed or hardcoded. There is no contract-tracked yield rate (fees mint
 * straight to the treasury, not back into the pool — see
 * contracts/MarketplankVault.sol / MarketplankVaultV3.sol), so this is
 * explicitly an ESTIMATE valued at the CURRENT share price, not a guaranteed
 * or contract-enforced return.
 *
 * Generation-aware: reads through the legacy (share-fee) ABI for V1/V2 and
 * the V3 (eth-fee) ABI for the current-generation vault — see
 * lib/market/vault-registry.ts's feeModelForVault, the single source of
 * truth for which vault speaks which shape. Calling the wrong ABI's
 * mintFeeBps/redeemFeeBps/targetPremiumBps getters against a V3 vault is
 * exactly what took /api/market/vault/stats down: those functions do not
 * exist on V3 and the eth_call reverts.
 */
export async function getVaultStats(
  vaultAddress?: string | null
): Promise<VaultStats | null> {
  const vault = resolveStatsVault(vaultAddress);
  if (!vault) return null;

  const feeModel = feeModelForVault(vault);

  // Only the four values that can actually change are re-read every refresh.
  // The immutable fee/premium/swap-fee getters come from getFeeSchedule, which
  // reads them once per process — see the two config caches above.
  const [core, feeSchedule, ethUsd] = await Promise.all([
    readCoreVaultState(vault, feeModel),
    getFeeSchedule(vault, feeModel),
    withTimeout(
      getEthUsdPrice().then((p) => p.usd || null),
      2_000,
      null,
      "eth-usd"
    ),
  ]);
  const { ethReserveWei, shareReserveWei, heldTokenCount, poolOpen } = core;

  const sharePriceWei =
    shareReserveWei > BigInt(0) ? (ethReserveWei * BigInt(1_000_000_000_000_000_000)) / shareReserveWei : null;

  const depositFeeWei = feePerDepositWei(feeSchedule, sharePriceWei);
  const redeemFeeWeiPerEvent = feePerRedeemWei(feeSchedule, sharePriceWei);

  // No baseline seed: a pool's heldTokenCount is not the same thing as its
  // deposit count (NFTs can enter via LP contribution, which pays no mint
  // fee, not just via deposit()) — inferring "N deposits, all in the last
  // 24h" from inventory alone is exactly the fabricated-APR bug this file's
  // docstring warns against. Until the activity replay below reports a real
  // observed window, both the treasury-revenue counters and LP APR stay at
  // this null/zero shape.
  const noTreasury = { depositCount: 0, redeemCount: 0, feeRevenueWei: BigInt(0) };
  const noLpApr = { aprPct: null as number | null, aprBasisHours: null as number | null };

  // Best-effort enrichment — never let history scans fail the whole stats payload.
  // Deposit/redeem (treasury revenue) and Bought/Sold (LP APR) are two
  // different questions over the SAME event replay, so it is fetched once
  // here and split below rather than scanned twice.
  let heldTokenIds: string[] = [];
  let treasuryPart = noTreasury;
  let lpAprPart = noLpApr;
  let marketplaceFeeRevenueEstWei = BigInt(0);
  try {
    const [held, events, mkt] = await Promise.all([
      withTimeout(getVaultHeldTokenIds(vault), 20_000, [] as string[], "vault-held"),
      withTimeout(getVaultActivity(80), 8_000, [] as VaultTradeEvent[], "vault-activity"),
      withTimeout(estimateMarketplaceFeeRevenue(), 4_000, BigInt(0), "vault-mkt-fees"),
    ]);
    heldTokenIds = held;
    treasuryPart = computeTreasuryFeeActivity(events, depositFeeWei, redeemFeeWeiPerEvent, vault);
    // Legacy (share-fee) vaults have no swapFeeBps on-contract at all — see
    // the aprPct docs on VaultStats above — so there is no LP-fee APR to
    // compute for them, not merely an unmeasured one. Only ask for it when
    // this vault actually speaks the eth-fee model.
    lpAprPart =
      feeSchedule.model === "eth"
        ? computeLpApr(events, ethReserveWei, feeSchedule.swapFeeBps, vault)
        : noLpApr;
    marketplaceFeeRevenueEstWei = mkt;
  } catch {
    heldTokenIds = [];
    treasuryPart = noTreasury;
    lpAprPart = noLpApr;
    marketplaceFeeRevenueEstWei = BigInt(0);
  }

  const { depositCount, redeemCount, feeRevenueWei } = treasuryPart;
  const { aprPct, aprBasisHours } = lpAprPart;

  return {
    poolOpen,
    ethReserveWei: ethReserveWei.toString(),
    shareReserveWei: shareReserveWei.toString(),
    heldTokenCount,
    heldTokenIds,
    sharePriceWei: sharePriceWei != null ? sharePriceWei.toString() : null,
    feeModel,
    mintFeeBps: feeSchedule.model === "share" ? feeSchedule.mintFeeBps : null,
    redeemFeeBps: feeSchedule.model === "share" ? feeSchedule.redeemFeeBps : null,
    targetPremiumBps: feeSchedule.model === "share" ? feeSchedule.targetPremiumBps : null,
    mintFeeWei: feeSchedule.model === "eth" ? feeSchedule.mintFeeWei.toString() : null,
    redeemFeeWei: feeSchedule.model === "eth" ? feeSchedule.redeemFeeWei.toString() : null,
    targetPremiumWei: feeSchedule.model === "eth" ? feeSchedule.targetPremiumWei.toString() : null,
    swapFeeBps: feeSchedule.model === "eth" ? feeSchedule.swapFeeBps : null,
    ethUsd,
    aprPct,
    aprBasisHours,
    depositCount,
    redeemCount,
    vaultFeeRevenueWei: feeRevenueWei.toString(),
    marketplaceFeeRevenueEstWei: marketplaceFeeRevenueEstWei.toString(),
  };
}

async function estimateMarketplaceFeeRevenue(): Promise<bigint> {
  try {
    const events = await fetchActivity(40);
    const total = events.reduce((sum, e) => {
      if (e.kind !== "sale" || e.priceWei == null) return sum;
      return sum + BigInt(e.priceWei);
    }, BigInt(0));
    return (total * BigInt(MARKET_DEFAULT_FEE_BPS)) / BigInt(10_000);
  } catch {
    return BigInt(0);
  }
}

function feeEthFromShares(feeShares: bigint, sharePriceWei: bigint): bigint {
  return (feeShares * sharePriceWei) / SHARE_UNIT;
}

/** Annualizes real observed revenue against a pool-value denominator over a
 *  real observed window. Generic over what "revenue" and "poolValue" mean —
 *  callers are responsible for making sure both are the same kind of money
 *  (e.g. LP swap-fee revenue against the LP's pool value, never treasury
 *  revenue against it). */
function annualizeApr(
  revenueWei: bigint,
  poolValueWei: bigint,
  hoursObserved: number
): number | null {
  if (hoursObserved < MIN_HOURS_FOR_APR || revenueWei <= BigInt(0) || poolValueWei <= BigInt(0)) {
    return null;
  }
  const revenueNum = Number(revenueWei) / 1e18;
  const poolValueNum = Number(poolValueWei) / 1e18;
  if (poolValueNum <= 0 || !Number.isFinite(revenueNum)) return null;
  const hourlyRate = revenueNum / hoursObserved;
  // Cap so a short window with heavy swap volume doesn't print nonsense 6-digit %.
  return Math.min((hourlyRate * 24 * 365) / poolValueNum * 100, 9_999);
}

/**
 * Deposit/redeem activity for this vault, replayed from real Deposited/
 * Redeemed events. This is TREASURY revenue counting — see the aprPct docs
 * on VaultStats for why it is never annualized or presented as APR: both
 * fee models mint/pay these fees straight to the immutable treasury
 * (`_mint(treasury, fee)` in MarketplankVault.sol, `accruedFees += msg.value`
 * + withdrawFees() in MarketplankVaultV3.sol), never to LPs.
 *
 * There is deliberately no inventory-based fallback for depositCount.
 * heldTokenCount is not a count of paid deposits — NFTs can also arrive via
 * LP contribution, which charges no mint fee — so inferring deposits from
 * inventory is exactly the fabricated-count bug this file's docstring warns
 * against. A vault with zero real Deposited events reports depositCount: 0,
 * even if its heldTokenCount is nonzero.
 *
 * Takes the per-event fee already resolved to wei (see feePerDepositWei /
 * feePerRedeemWei) rather than a fee model + bps, so this one loop works
 * unchanged for both a share-model legacy vault and an eth-model V3 vault —
 * the model-specific math already happened once, upstream.
 */
function computeTreasuryFeeActivity(
  events: VaultTradeEvent[],
  depositFeeWei: bigint,
  redeemFeeWeiPerEvent: bigint,
  vaultAddress?: string | null
): { depositCount: number; redeemCount: number; feeRevenueWei: bigint } {
  let depositCount = 0;
  let redeemCount = 0;
  let feeRevenueWei = BigInt(0);
  const vaultLc = vaultAddress?.toLowerCase() ?? null;

  for (const e of events) {
    if (e.kind !== "deposit" && e.kind !== "redeem") continue;
    if (vaultLc && e.vaultAddress && e.vaultAddress.toLowerCase() !== vaultLc) continue;
    if (e.kind === "deposit") {
      depositCount += 1;
      feeRevenueWei += depositFeeWei;
    } else {
      redeemCount += 1;
      feeRevenueWei += redeemFeeWeiPerEvent;
    }
  }

  return { depositCount, redeemCount, feeRevenueWei };
}

/**
 * LP APR, replayed from real Bought/Sold events — the actual yield
 * mechanism for a constant-product (V2-style) pool's liquidity providers.
 * See the aprPct docs on VaultStats for the contract-level verification
 * that swap fees (not mint/redeem fees) are what LPs earn.
 *
 * `VaultTradeEvent.ethWei` already holds the ETH-side amount of the trade
 * either way — `ethIn` for a Bought event, `ethOut` for a Sold one — so
 * summing it directly over both kinds gives real ETH-denominated swap
 * volume with no extra share-price conversion needed. Fee revenue is then
 * volume × swapFeeBps, same rate the AMM itself charges on every trade.
 *
 * TVL denominator is the FULL two-sided pool value, which is exactly
 * 2 × ethReserveWei — not the ETH side alone. An LP's position is both sides
 * of the pool, and at the AMM's own spot price (ethReserve/shareReserve) the
 * share side is worth exactly ethReserve too, so the total needs no oracle
 * and no second read. Dividing by one side overstates the yield by exactly
 * 2×, and would also disagree with the "TVL" figure V3SwapView already
 * renders on the same screen (ethReserve + shareReserve × sharePrice), which
 * evaluates to the same 2 × ethReserve.
 *
 * Returns aprPct: null / aprBasisHours: null when there is no real swap
 * volume to measure, volume exists but no event carries a usable timestamp,
 * or the real measured window is thinner than MIN_HOURS_FOR_APR (see that
 * constant's docs — this is a hard gate, never a floor the window gets
 * clamped up to). Never a fabricated placeholder or an asserted window
 * nobody measured, and aprBasisHours is never set to a span too thin to
 * annualize. Only meaningful for eth-fee (V3) vaults — see the caller in
 * getVaultStats, which gates this out entirely for share-fee vaults, whose
 * buyShares/sellShares apply no fee at all.
 */
/** Exported so a test can prove a sub-MIN_HOURS_FOR_APR window returns the
 *  null shape rather than an inflated/clamped one — the exact regression
 *  that slipped through when this used Math.max as a floor instead of a
 *  gate. See test/market/vault-apr.test.ts. */
export function computeLpApr(
  events: VaultTradeEvent[],
  ethReserveWei: bigint,
  swapFeeBps: number,
  vaultAddress?: string | null
): { aprPct: number | null; aprBasisHours: number | null } {
  const none = { aprPct: null as number | null, aprBasisHours: null as number | null };
  if (ethReserveWei <= BigInt(0) || swapFeeBps <= 0) return none;

  const vaultLc = vaultAddress?.toLowerCase() ?? null;
  let volumeWei = BigInt(0);
  let swapCount = 0;
  let earliest = Infinity;
  let latestTs = 0;

  for (const e of events) {
    if (e.kind !== "buy" && e.kind !== "sell") continue;
    if (vaultLc && e.vaultAddress && e.vaultAddress.toLowerCase() !== vaultLc) continue;
    if (!e.ethWei) continue;
    let wei: bigint;
    try {
      wei = BigInt(e.ethWei);
    } catch {
      continue;
    }
    if (wei <= BigInt(0)) continue;
    volumeWei += wei;
    swapCount += 1;
    const ts = e.timestamp ? new Date(e.timestamp).getTime() / 1000 : NaN;
    if (Number.isFinite(ts)) {
      earliest = Math.min(earliest, ts);
      latestTs = Math.max(latestTs, ts);
    }
  }

  // No swap volume observed, or volume exists but nothing carried a
  // parseable timestamp — either way, the window genuinely can't be
  // measured, so don't assert one.
  if (volumeWei <= BigInt(0) || earliest === Infinity) return none;

  // Too few trades to annualize, however long the window. See
  // MIN_SWAPS_FOR_APR — 24 hours and two trades is still a two-trade sample.
  if (swapCount < MIN_SWAPS_FOR_APR) return none;

  const feeRevenueWei = (volumeWei * BigInt(swapFeeBps)) / BigInt(10_000);
  // The TRUE measured span — never clamped up to MIN_HOURS_FOR_APR. A window
  // thinner than the minimum must fail annualizeApr's own guard and come
  // back null, not get inflated into a basis nobody actually observed.
  const hoursObserved = (latestTs - earliest) / 3600;
  // Both sides of the pool — see this function's docs. NOT ethReserveWei
  // alone, which overstates the rate by exactly 2x.
  const poolValueWei = ethReserveWei * BigInt(2);
  const aprPct = annualizeApr(feeRevenueWei, poolValueWei, hoursObserved);
  // aprBasisHours is only ever reported alongside a real aprPct — pairing
  // them means a caller can never see a "measured" hours figure sitting next
  // to a null rate (or vice versa), and a too-thin window (real hours, just
  // below MIN_HOURS_FOR_APR) reports as the same clean "nothing to show yet"
  // as no data at all, rather than as a partial number worth rendering.
  if (aprPct == null) return none;
  return { aprPct, aprBasisHours: hoursObserved };
}
