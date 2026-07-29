import { Interface } from "ethers";
import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { getEthUsdPrice } from "@/lib/eth-price";
import { fetchActivity } from "@/lib/market/activity";
import { getVaultActivity } from "@/lib/market/vault-activity";
import { MARKET_DEFAULT_FEE_BPS } from "@/lib/constants";
import { withTimeout } from "@/lib/market/rpc-budget";
import { ethCallMany } from "@/lib/market/fetch-rpc";

function resolveStatsVault(vaultAddress?: string | null): string | null {
  if (vaultAddress && /^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    const hit = MARKET_VAULT_ADDRESSES.find(
      (a) => a.toLowerCase() === vaultAddress.toLowerCase()
    );
    if (hit) return hit;
  }
  return MARKET_VAULT_ADDRESS;
}

const IFACE = new Interface(vaultAbi);
const SHARE_UNIT = BigInt(1_000_000_000_000_000_000);
/** Below this many hours of observed fee events, annualized APR is noisy.
 * Young vaults still get a number once we have ≥1h of deposit/redeem history
 * so Instant Swap isn't stuck on "—" after a day of real volume. */
const MIN_HOURS_FOR_APR = 1;

function mintFeeLowerBoundApr(
  sharePriceWei: bigint,
  ethReserveWei: bigint,
  mintFeeBps: number,
  heldTokenCount: number
): {
  aprPct: number | null;
  aprBasisHours: number;
  depositCount: number;
  redeemCount: number;
  feeRevenueWei: bigint;
} {
  const feeShares =
    ((SHARE_UNIT * BigInt(mintFeeBps)) / BigInt(10_000)) * BigInt(heldTokenCount);
  const feeRevenueWei = (feeShares * sharePriceWei) / SHARE_UNIT;
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
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
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
 * contracts/MarketplankVault.sol), so this is explicitly an ESTIMATE valued
 * at the CURRENT share price, not a guaranteed or contract-enforced return.
 */
export async function getVaultStats(
  vaultAddress?: string | null
): Promise<VaultStats | null> {
  const vault = resolveStatsVault(vaultAddress);
  if (!vault) return null;

  // One batched eth_call round-trip (Workers-safe fetch) + optional USD price.
  const [coreHexes, ethUsd] = await Promise.all([
    ethCallMany([
      { to: vault, data: IFACE.encodeFunctionData("ethReserve", []) },
      { to: vault, data: IFACE.encodeFunctionData("balanceOf", [vault]) },
      { to: vault, data: IFACE.encodeFunctionData("heldTokenCount", []) },
      { to: vault, data: IFACE.encodeFunctionData("poolOpen", []) },
      { to: vault, data: IFACE.encodeFunctionData("mintFeeBps", []) },
      { to: vault, data: IFACE.encodeFunctionData("redeemFeeBps", []) },
      { to: vault, data: IFACE.encodeFunctionData("targetPremiumBps", []) },
    ]),
    withTimeout(
      getEthUsdPrice().then((p) => p.usd || null),
      2_000,
      null,
      "eth-usd"
    ),
  ]);
  const [
    ethReserveHex,
    shareReserveHex,
    heldCountHex,
    poolOpenHex,
    mintFeeHex,
    redeemFeeHex,
    premiumHex,
  ] = coreHexes;

  const ethReserveWei = BigInt(IFACE.decodeFunctionResult("ethReserve", ethReserveHex)[0]);
  const shareReserveWei = BigInt(IFACE.decodeFunctionResult("balanceOf", shareReserveHex)[0]);
  const heldTokenCount = Number(IFACE.decodeFunctionResult("heldTokenCount", heldCountHex)[0]);
  const poolOpen = Boolean(IFACE.decodeFunctionResult("poolOpen", poolOpenHex)[0]);
  const mintFeeBps = Number(IFACE.decodeFunctionResult("mintFeeBps", mintFeeHex)[0]);
  const redeemFeeBps = Number(IFACE.decodeFunctionResult("redeemFeeBps", redeemFeeHex)[0]);
  const targetPremiumBps = Number(IFACE.decodeFunctionResult("targetPremiumBps", premiumHex)[0]);

  const sharePriceWei =
    shareReserveWei > BigInt(0) ? (ethReserveWei * BigInt(1_000_000_000_000_000_000)) / shareReserveWei : null;

  // Always seed APR from inventory × mint fee so the dashboard never shows
  // "—" when the pool has held NFTs. Activity scan can refine counts/window.
  const baselineApr =
    sharePriceWei != null && ethReserveWei > BigInt(0) && heldTokenCount > 0 && mintFeeBps > 0
      ? mintFeeLowerBoundApr(sharePriceWei, ethReserveWei, mintFeeBps, heldTokenCount)
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
        estimateApr(
          sharePriceWei,
          mintFeeBps,
          redeemFeeBps,
          targetPremiumBps,
          ethReserveWei,
          heldTokenCount,
          vault
        ),
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
    mintFeeBps,
    redeemFeeBps,
    targetPremiumBps,
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
 */
async function estimateApr(
  sharePriceWei: bigint | null,
  mintFeeBps: number,
  redeemFeeBps: number,
  _targetPremiumBps: number,
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
  if (sharePriceWei == null || ethReserveWei <= BigInt(0)) return none;

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
        const feeShares = (SHARE_UNIT * BigInt(mintFeeBps)) / BigInt(10_000);
        feeRevenueWei += feeEthFromShares(feeShares, sharePriceWei);
      } else {
        redeemCount += 1;
        const feeShares = (SHARE_UNIT * BigInt(redeemFeeBps)) / BigInt(10_000);
        feeRevenueWei += feeEthFromShares(feeShares, sharePriceWei);
      }
    }
  } catch {
    /* fall through to held-based estimate */
  }

  // Fallback when activity is empty: every held NFT was deposited at least
  // once → mint-fee lower bound over a 24h window.
  if (feeRevenueWei <= BigInt(0) && heldTokenCount > 0 && mintFeeBps > 0) {
    // APR estimate only — do NOT invent depositCount = heldTokenCount for UI
    // reconciliation (that made "57 held / 57 deposits / 0 redeems" look real
    // when activity history was empty). Keep event counts from the walk above.
    const aprOnly = mintFeeLowerBoundApr(sharePriceWei, ethReserveWei, mintFeeBps, heldTokenCount);
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
