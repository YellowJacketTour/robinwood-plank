import { JsonRpcProvider, formatEther, getAddress } from "ethers";
import {
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URLS,
} from "@/lib/mint-contract";
import { SEAPORT_ADDRESS } from "@/lib/constants";

/**
 * On-chain activity for the collection.
 *
 * Source of truth is the collection's own ERC-721 Transfer log, not our relay:
 * the relay only knows about orders it was told about, so a feed built from it
 * would miss every sale made anywhere else and could be poisoned by anyone who
 * can write to the book. Transfer logs cannot be forged.
 *
 * Seaport's OrderFulfilled event is deliberately NOT the primary source. It
 * carries the collection only in its data payload, not in an indexed topic, so
 * it cannot be filtered server-side; an unfiltered query against this chain
 * returns "logs matched by query exceeds limit of 10000" (observed). We
 * classify a transfer as a sale by checking whether Seaport executed the
 * transaction instead.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

/** The node rejects wide ranges, so walk backwards in bounded windows. */
const CHUNK_BLOCKS = 50_000;
const MAX_CHUNKS = 8;

export type ActivityKind = "mint" | "sale" | "transfer";

export type ActivityEvent = {
  kind: ActivityKind;
  tokenId: string;
  from: string;
  to: string;
  /** Sale price in wei, when this transfer was a Seaport fill paid in ETH. */
  priceWei: string | null;
  priceEth: string | null;
  txHash: string;
  blockNumber: number;
  /** ISO timestamp, or null when the block header could not be read. */
  timestamp: string | null;
};

function topicToAddress(topic: string): string {
  return getAddress("0x" + topic.slice(26));
}

type RawLog = {
  topics: string[];
  transactionHash: string;
  blockNumber: string;
};

async function firstHealthyProvider(): Promise<JsonRpcProvider> {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
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
 * Read recent Transfer logs for the collection, newest first.
 *
 * Fails closed: any RPC error propagates rather than returning a short list
 * that would render as "no activity" and read as a dead marketplace.
 */
export async function fetchActivity(limit = 40): Promise<ActivityEvent[]> {
  const provider = await firstHealthyProvider();
  const latest = await provider.getBlockNumber();

  const logs: RawLog[] = [];
  let toBlock = latest;

  for (let chunk = 0; chunk < MAX_CHUNKS && logs.length < limit && toBlock > 0; chunk += 1) {
    const fromBlock = Math.max(0, toBlock - CHUNK_BLOCKS);
    const found = (await provider.send("eth_getLogs", [
      {
        address: NFT_CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ])) as RawLog[];

    logs.push(...found);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }

  // ERC-721 Transfer indexes all three args; a log with fewer topics is an
  // ERC-20 Transfer sharing the same signature and is not ours.
  const transfers = logs
    .filter((log) => log.topics.length === 4)
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))
    .slice(0, limit);

  const seaport = SEAPORT_ADDRESS.toLowerCase();
  const blockCache = new Map<string, number | null>();
  const txCache = new Map<string, { to: string | null; value: bigint } | null>();

  // Enrich in parallel. Done serially this is ~2 round-trips per row and the
  // feed visibly hangs; the distinct tx/block sets are far smaller than the
  // row count because a batch transfer shares one transaction.
  const uniqueTxs = [...new Set(transfers.map((l) => l.transactionHash))];
  const uniqueBlocks = [...new Set(transfers.map((l) => l.blockNumber))];

  await Promise.all([
    ...uniqueTxs.map(async (hash) => {
      try {
        const fetched = await provider.getTransaction(hash);
        txCache.set(hash, fetched ? { to: fetched.to, value: fetched.value } : null);
      } catch {
        txCache.set(hash, null);
      }
    }),
    ...uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await provider.getBlock(Number(BigInt(blockNumber)));
        blockCache.set(blockNumber, block ? block.timestamp : null);
      } catch {
        blockCache.set(blockNumber, null);
      }
    }),
  ]);

  const events: ActivityEvent[] = [];
  for (const log of transfers) {
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const tokenId = BigInt(log.topics[3]).toString();

    const tx = txCache.get(log.transactionHash) ?? null;
    const timestamp = blockCache.get(log.blockNumber) ?? null;

    const viaSeaport = tx?.to != null && tx.to.toLowerCase() === seaport;
    const kind: ActivityKind =
      from === ZERO ? "mint" : viaSeaport ? "sale" : "transfer";

    // Only a Seaport fill paid in native ETH has a price we can read from the
    // transaction. A WETH-denominated bid acceptance moves no ETH in the tx,
    // so we report no price rather than displaying a misleading zero.
    const hasPrice = kind === "sale" && tx != null && tx.value > BigInt(0);

    events.push({
      kind,
      tokenId,
      from,
      to,
      priceWei: hasPrice ? tx!.value.toString() : null,
      priceEth: hasPrice ? formatEther(tx!.value) : null,
      txHash: log.transactionHash,
      blockNumber: Number(BigInt(log.blockNumber)),
      timestamp: timestamp == null ? null : new Date(timestamp * 1000).toISOString(),
    });
  }

  return events;
}
