import { Interface, JsonRpcProvider } from "ethers";
import { NFT_CONTRACT_ADDRESS, ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { getEthUsdPrice } from "@/lib/eth-price";

const IFACE = new Interface(vaultAbi);
const CHUNK_BLOCKS = 50_000;
const MAX_CHUNKS = 12;
/** Below this many hours of observed activity, an annualized rate is more
 * noise than signal — show "not enough history" instead of a number that
 * LOOKS precise but is really one or two data points multiplied way up. */
const MIN_HOURS_FOR_APR = 6;

async function firstHealthyProvider(): Promise<JsonRpcProvider> {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No healthy Robinhood RPC: ${String(lastError)}`);
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
export async function getVaultStats(): Promise<VaultStats | null> {
  if (!MARKET_VAULT_ADDRESS) return null;
  const provider = await firstHealthyProvider();
  const vault = MARKET_VAULT_ADDRESS;

  const [
    ethReserveHex,
    shareReserveHex,
    heldCountHex,
    poolOpenHex,
    mintFeeHex,
    redeemFeeHex,
    premiumHex,
    ethUsd,
    heldTokenIds,
  ] = await Promise.all([
    provider.call({ to: vault, data: IFACE.encodeFunctionData("ethReserve", []) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("balanceOf", [vault]) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("heldTokenCount", []) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("poolOpen", []) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("mintFeeBps", []) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("redeemFeeBps", []) }),
    provider.call({ to: vault, data: IFACE.encodeFunctionData("targetPremiumBps", []) }),
    getEthUsdPrice().then((p) => p.usd || null).catch(() => null),
    getVaultHeldTokenIds(),
  ]);

  const ethReserveWei = BigInt(IFACE.decodeFunctionResult("ethReserve", ethReserveHex)[0]);
  const shareReserveWei = BigInt(IFACE.decodeFunctionResult("balanceOf", shareReserveHex)[0]);
  const heldTokenCount = Number(IFACE.decodeFunctionResult("heldTokenCount", heldCountHex)[0]);
  const poolOpen = Boolean(IFACE.decodeFunctionResult("poolOpen", poolOpenHex)[0]);
  const mintFeeBps = Number(IFACE.decodeFunctionResult("mintFeeBps", mintFeeHex)[0]);
  const redeemFeeBps = Number(IFACE.decodeFunctionResult("redeemFeeBps", redeemFeeHex)[0]);
  const targetPremiumBps = Number(IFACE.decodeFunctionResult("targetPremiumBps", premiumHex)[0]);

  const sharePriceWei =
    shareReserveWei > BigInt(0) ? (ethReserveWei * BigInt(1_000_000_000_000_000_000)) / shareReserveWei : null;

  const { aprPct, aprBasisHours, depositCount, redeemCount } = await estimateApr(
    provider,
    vault,
    sharePriceWei,
    mintFeeBps,
    redeemFeeBps,
    targetPremiumBps,
    ethReserveWei
  );

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
  };
}

async function estimateApr(
  provider: JsonRpcProvider,
  vault: string,
  sharePriceWei: bigint | null,
  mintFeeBps: number,
  redeemFeeBps: number,
  targetPremiumBps: number,
  ethReserveWei: bigint
): Promise<{ aprPct: number | null; aprBasisHours: number | null; depositCount: number; redeemCount: number }> {
  const none = { aprPct: null, aprBasisHours: null, depositCount: 0, redeemCount: 0 };
  if (sharePriceWei == null || ethReserveWei <= BigInt(0)) return none;

  const depositedTopic = IFACE.getEvent("Deposited")!.topicHash;
  const redeemedTopic = IFACE.getEvent("Redeemed")!.topicHash;

  const latest = await provider.getBlockNumber();
  const logs: Array<{ topics: string[]; blockNumber: string }> = [];
  let toBlock = latest;
  for (let chunk = 0; chunk < MAX_CHUNKS && toBlock > 0; chunk += 1) {
    const fromBlock = Math.max(0, toBlock - CHUNK_BLOCKS);
    const found = (await provider.send("eth_getLogs", [
      {
        address: vault,
        topics: [[depositedTopic, redeemedTopic]],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ])) as Array<{ topics: string[]; blockNumber: string }>;
    logs.push(...found);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }
  if (logs.length === 0) return none;

  const blockNumbers = [...new Set(logs.map((l) => l.blockNumber))];
  const blocks = await Promise.all(
    blockNumbers.map((bn) => provider.getBlock(Number(BigInt(bn))))
  );
  const blockTimeByNumber = new Map<string, number>();
  blockNumbers.forEach((bn, i) => {
    if (blocks[i]) blockTimeByNumber.set(bn, blocks[i]!.timestamp);
  });

  const SHARE_UNIT = BigInt(1_000_000_000_000_000_000);
  let feeRevenueWei = BigInt(0);
  let depositCount = 0;
  let redeemCount = 0;
  let earliest = Infinity;
  let latestTs = 0;

  for (const log of logs) {
    const ts = blockTimeByNumber.get(log.blockNumber);
    if (ts == null) continue;
    earliest = Math.min(earliest, ts);
    latestTs = Math.max(latestTs, ts);

    if (log.topics[0] === depositedTopic) {
      depositCount += 1;
      // mint fee is charged in shares (SHARE_UNIT * mintFeeBps / 10000),
      // valued here at the CURRENT share price for a common ETH-terms unit.
      const feeShares = (SHARE_UNIT * BigInt(mintFeeBps)) / BigInt(10_000);
      feeRevenueWei += (feeShares * sharePriceWei) / SHARE_UNIT;
    } else if (log.topics[0] === redeemedTopic) {
      redeemCount += 1;
      const feeShares = (SHARE_UNIT * BigInt(redeemFeeBps + targetPremiumBps)) / BigInt(10_000);
      feeRevenueWei += (feeShares * sharePriceWei) / SHARE_UNIT;
    }
  }

  if (earliest === Infinity || feeRevenueWei <= BigInt(0)) return none;

  const hoursObserved = Math.max((latestTs - earliest) / 3600, 0.01);
  if (hoursObserved < MIN_HOURS_FOR_APR) {
    return { aprPct: null, aprBasisHours: hoursObserved, depositCount, redeemCount };
  }

  const revenueNum = Number(feeRevenueWei) / 1e18;
  const tvlNum = Number(ethReserveWei) / 1e18;
  if (tvlNum <= 0) return none;

  const hourlyRate = revenueNum / hoursObserved;
  const aprPct = ((hourlyRate * 24 * 365) / tvlNum) * 100;

  return { aprPct, aprBasisHours: hoursObserved, depositCount, redeemCount };
}
