import { Interface, JsonRpcProvider } from "ethers";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";

const IFACE = new Interface(vaultAbi);
const CHUNK_BLOCKS = 50_000;
const MAX_CHUNKS = 12;

export type VaultTradeKind = "buy" | "sell" | "deposit" | "redeem";

export type VaultTradeEvent = {
  kind: VaultTradeKind;
  address: string;
  ethWei: string | null;
  sharesWei: string | null;
  tokenId: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: string | null;
};

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

/**
 * Real vault trade history, replayed the same way vault-stats.ts replays
 * its APR window: walk Bought/Sold/Deposited/Redeemed logs backward in
 * chunks. This is what a dextools-style trade ticker needs but the
 * collection-Transfer-log-based lib/market/activity.ts has no visibility
 * into, since vault swaps never move the NFT collection's own Transfer
 * topic (only Deposited/Redeemed move an NFT, and Bought/Sold trade the
 * vault's internal share token).
 */
export async function getVaultActivity(
  limit = 40,
  opts?: { full?: boolean }
): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  const provider = await firstHealthyProvider();
  const vault = MARKET_VAULT_ADDRESS;
  const full = opts?.full ?? false;

  const boughtTopic = IFACE.getEvent("Bought")!.topicHash;
  const soldTopic = IFACE.getEvent("Sold")!.topicHash;
  const depositedTopic = IFACE.getEvent("Deposited")!.topicHash;
  const redeemedTopic = IFACE.getEvent("Redeemed")!.topicHash;
  const topics = [boughtTopic, soldTopic, depositedTopic, redeemedTopic];

  const latest = await provider.getBlockNumber();
  const rawLogs: Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }> = [];
  let toBlock = latest;
  // The recent-N callers (the trade ticker) only need enough chunks to fill
  // their limit, so they stop early — the "full lineage" chart needs every
  // chunk MAX_CHUNKS allows, or it silently drops older history the same
  // way the final .slice() below used to.
  for (let chunk = 0; chunk < MAX_CHUNKS && toBlock >= 0 && (full || rawLogs.length < limit * 3); chunk += 1) {
    const fromBlock = Math.max(0, toBlock - CHUNK_BLOCKS);
    const found = (await provider.send("eth_getLogs", [
      {
        address: vault,
        topics: [topics],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ])) as typeof rawLogs;
    rawLogs.push(...found);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }
  if (rawLogs.length === 0) return [];

  rawLogs.sort((a, b) => {
    const bn = Number(BigInt(b.blockNumber) - BigInt(a.blockNumber));
    if (bn !== 0) return bn;
    return Number(BigInt(b.logIndex) - BigInt(a.logIndex));
  });
  const trimmed = full ? rawLogs : rawLogs.slice(0, limit);

  const blockNumbers = [...new Set(trimmed.map((l) => l.blockNumber))];
  const blocks = await Promise.all(blockNumbers.map((bn) => provider.getBlock(Number(BigInt(bn)))));
  const blockTimeByNumber = new Map<string, number>();
  blockNumbers.forEach((bn, i) => {
    if (blocks[i]) blockTimeByNumber.set(bn, blocks[i]!.timestamp);
  });

  return trimmed.map(
    (log): VaultTradeEvent => {
      const ts = blockTimeByNumber.get(log.blockNumber) ?? null;
      const timestamp = ts == null ? null : new Date(ts * 1000).toISOString();
      const blockNumber = Number(BigInt(log.blockNumber));
      const logIndex = Number(BigInt(log.logIndex));
      const base = {
        txHash: log.transactionHash,
        blockNumber,
        logIndex,
        timestamp,
      };

      if (log.topics[0] === boughtTopic) {
        const parsed = IFACE.decodeEventLog("Bought", log.data, log.topics);
        return {
          ...base,
          kind: "buy" as const,
          address: String(parsed.buyer),
          ethWei: parsed.ethIn.toString(),
          sharesWei: parsed.sharesOut.toString(),
          tokenId: null,
        };
      }
      if (log.topics[0] === soldTopic) {
        const parsed = IFACE.decodeEventLog("Sold", log.data, log.topics);
        return {
          ...base,
          kind: "sell" as const,
          address: String(parsed.seller),
          ethWei: parsed.ethOut.toString(),
          sharesWei: parsed.sharesIn.toString(),
          tokenId: null,
        };
      }
      if (log.topics[0] === depositedTopic) {
        const parsed = IFACE.decodeEventLog("Deposited", log.data, log.topics);
        return {
          ...base,
          kind: "deposit" as const,
          address: String(parsed.from),
          ethWei: null,
          sharesWei: null,
          tokenId: parsed.tokenId.toString(),
        };
      }
      const parsed = IFACE.decodeEventLog("Redeemed", log.data, log.topics);
      return {
        ...base,
        kind: "redeem" as const,
        address: String(parsed.to),
        ethWei: null,
        sharesWei: null,
        tokenId: parsed.tokenId.toString(),
      };
    }
  );
}
