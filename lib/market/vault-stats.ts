import { Interface } from "ethers";
import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { V3_IFACE } from "@/lib/market/vault-v3";
import { feeModelForVault, type FeeModel } from "@/lib/market/vault-registry";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { getEthUsdPrice } from "@/lib/eth-price";
import { fetchActivity } from "@/lib/market/activity";
import { getVaultActivity } from "@/lib/market/vault-activity";
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
 *  this batch — see getFeeSchedule / the two config caches above. */
async function readCoreVaultState(
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

/** Below this many hours of observed fee events, annualized APR is noisy.
 * Young vaults still get a number once we have ≥1h of deposit/redeem history
 * so Instant Swap isn't stuck on "—" after a day of real volume. */
const MIN_HOURS_FOR_APR = 1;

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

function mintFeeLowerBoundApr(
  ethReserveWei: bigint,
  feePerDeposit: bigint,
  heldTokenCount: number
): {
  aprPct: number | null;
  aprBasisHours: number;
  depositCount: number;
  redeemCount: number;
  feeRevenueWei: bigint;
} {
  const feeRevenueWei = feePerDeposit * BigInt(heldTokenCount);
  const hours = 24;
  const revenueNum = Number(feeRevenueWei) / 1e18;
  const tvlNum = Number(ethReserveWei) / 1e18;
  const aprPct =
    tvlNum > 0 && revenueNum > 0
      ? Math.min(((revenueNum / hours) * 24 * 365) / tvlNum * 100, 9_999)
      : null;
  return {
    aprPct,
    aprBasisHours: hours,
    depositCount: heldTokenCount,
    redeemCount: 0,
    feeRevenueWei,
  };
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
  /** Annualized, computed from real Deposited/Redeemed fee events over
   * however much history actually exists — null when there isn't enough
   * of it to mean anything (see MIN_HOURS_FOR_APR), never a fabricated
   * placeholder number. */
  aprPct: number | null;
  aprBasisHours: number | null;
  depositCount: number;
  redeemCount: number;
  /** Vault mint/redeem fee revenue actually observed over the same replay
   * window as aprBasisHours, valued at the current share price. Not the
   * lifetime total (the replay only walks back MAX_CHUNKS * CHUNK_BLOCKS)
   * — a lower bound on real fees collected, never fabricated. */
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

  // Always seed APR from inventory × mint fee so the dashboard never shows
  // "—" when the pool has held NFTs. Activity scan can refine counts/window.
  const baselineApr =
    sharePriceWei != null && ethReserveWei > BigInt(0) && heldTokenCount > 0 && depositFeeWei > BigInt(0)
      ? mintFeeLowerBoundApr(ethReserveWei, depositFeeWei, heldTokenCount)
      : {
          aprPct: null as number | null,
          aprBasisHours: null as number | null,
          depositCount: 0,
          redeemCount: 0,
          feeRevenueWei: BigInt(0),
        };

  // Best-effort enrichment — never let history scans fail the whole stats payload.
  let heldTokenIds: string[] = [];
  let aprPart = baselineApr;
  let marketplaceFeeRevenueEstWei = BigInt(0);
  try {
    const [held, apr, mkt] = await Promise.all([
      withTimeout(getVaultHeldTokenIds(vault), 20_000, [] as string[], "vault-held"),
      withTimeout(
        estimateApr(depositFeeWei, redeemFeeWeiPerEvent, ethReserveWei, heldTokenCount, vault),
        8_000,
        baselineApr,
        "vault-apr"
      ),
      withTimeout(estimateMarketplaceFeeRevenue(), 4_000, BigInt(0), "vault-mkt-fees"),
    ]);
    heldTokenIds = held;
    aprPart = apr.aprPct != null ? apr : baselineApr;
    marketplaceFeeRevenueEstWei = mkt;
  } catch {
    heldTokenIds = [];
    aprPart = baselineApr;
    marketplaceFeeRevenueEstWei = BigInt(0);
  }

  const { aprPct, aprBasisHours, depositCount, redeemCount, feeRevenueWei } = aprPart;

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

function annualizeApr(
  feeRevenueWei: bigint,
  ethReserveWei: bigint,
  hoursObserved: number
): number | null {
  if (hoursObserved < MIN_HOURS_FOR_APR || feeRevenueWei <= BigInt(0) || ethReserveWei <= BigInt(0)) {
    return null;
  }
  const revenueNum = Number(feeRevenueWei) / 1e18;
  const tvlNum = Number(ethReserveWei) / 1e18;
  if (tvlNum <= 0 || !Number.isFinite(revenueNum)) return null;
  const hourlyRate = revenueNum / hoursObserved;
  // Cap so a short window with heavy mint fees doesn't print nonsense 6-digit %.
  return Math.min((hourlyRate * 24 * 365) / tvlNum * 100, 9_999);
}

/**
 * Trailing fee-revenue APR.
 * 1) Blockscout-backed vault activity (deposits/redeems + timestamps)
 * 2) Fallback: held NFT count × mint fee + ≥24h window — CF often can't
 *    finish eth_getLogs; activity can also fail under Blockscout pressure.
 *
 * Takes the per-event fee already resolved to wei (see feePerDepositWei /
 * feePerRedeemWei) rather than a fee model + bps, so this one replay loop
 * works unchanged for both a share-model legacy vault and an eth-model V3
 * vault — the model-specific math already happened once, upstream.
 */
async function estimateApr(
  depositFeeWei: bigint,
  redeemFeeWeiPerEvent: bigint,
  ethReserveWei: bigint,
  heldTokenCount: number,
  vaultAddress?: string | null
): Promise<{
  aprPct: number | null;
  aprBasisHours: number | null;
  depositCount: number;
  redeemCount: number;
  feeRevenueWei: bigint;
}> {
  const none = {
    aprPct: null as number | null,
    aprBasisHours: null as number | null,
    depositCount: 0,
    redeemCount: 0,
    feeRevenueWei: BigInt(0),
  };
  if (ethReserveWei <= BigInt(0)) return none;

  let depositCount = 0;
  let redeemCount = 0;
  let feeRevenueWei = BigInt(0);
  let earliest = Infinity;
  let latestTs = 0;
  const vaultLc = vaultAddress?.toLowerCase() ?? null;

  try {
    // Short feed first (fast on CF); skip full=1 — it often exhausts the
    // 12s APR budget and yields emptyApr.
    const events = await getVaultActivity(80);
    for (const e of events) {
      if (e.kind !== "deposit" && e.kind !== "redeem") continue;
      if (vaultLc && e.vaultAddress && e.vaultAddress.toLowerCase() !== vaultLc) continue;
      const ts = e.timestamp ? new Date(e.timestamp).getTime() / 1000 : NaN;
      if (Number.isFinite(ts)) {
        earliest = Math.min(earliest, ts);
        latestTs = Math.max(latestTs, ts);
      }
      if (e.kind === "deposit") {
        depositCount += 1;
        feeRevenueWei += depositFeeWei;
      } else {
        redeemCount += 1;
        feeRevenueWei += redeemFeeWeiPerEvent;
      }
    }
  } catch {
    /* fall through to held-based estimate */
  }

  // Fallback when activity is empty: every held NFT was deposited at least
  // once → mint-fee lower bound over a 24h window.
  if (feeRevenueWei <= BigInt(0) && heldTokenCount > 0 && depositFeeWei > BigInt(0)) {
    // APR estimate only — do NOT invent depositCount = heldTokenCount for UI
    // reconciliation (that made "57 held / 57 deposits / 0 redeems" look real
    // when activity history was empty). Keep event counts from the walk above.
    const aprOnly = mintFeeLowerBoundApr(ethReserveWei, depositFeeWei, heldTokenCount);
    return {
      ...aprOnly,
      depositCount,
      redeemCount,
    };
  }

  if (feeRevenueWei <= BigInt(0)) {
    return { ...none, depositCount, redeemCount };
  }

  const hoursObserved =
    earliest === Infinity
      ? 24
      : Math.max((latestTs - earliest) / 3600, MIN_HOURS_FOR_APR);

  const aprPct = annualizeApr(feeRevenueWei, ethReserveWei, hoursObserved);
  return { aprPct, aprBasisHours: hoursObserved, depositCount, redeemCount, feeRevenueWei };
}
