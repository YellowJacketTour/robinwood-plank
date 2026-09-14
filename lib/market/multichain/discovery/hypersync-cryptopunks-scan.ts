/**
 * CryptoPunks market PunkBought fetch loop over HyperSync -- the same shape
 * as hypersync-cryptokitties-scan.ts (chunked, cursor-advancing, quota-
 * guarded, shared Envio account jail). Decode, bid resolution and writes
 * live in cryptopunks-fill-indexer.ts.
 *
 * The one extra step: a PunkBought with value 0 (acceptBidForPunk, see the
 * indexer's header) is resolved by asking HyperSync for the latest
 * PunkBidEntered on that punk index strictly before the sale. Punk bids
 * per index are few, so that is one small filtered query per accept-bid
 * sale, and it is answered from the same client and quota reservation.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import {
  CRYPTOPUNKS_GENESIS_BLOCK,
  CRYPTOPUNKS_MARKET_ADDRESS,
  PUNK_BID_ENTERED_TOPIC,
  PUNK_BOUGHT_TOPIC,
  decodePunkBidEntered,
  decodePunkBought,
  readCursor,
  resolvePunkSales,
  writeCryptoPunksFills,
  writeCursor,
  type AcceptedBidResolver,
  type CryptoPunksFillScanResult,
  type PunkBoughtLog,
} from "@/lib/market/multichain/cryptopunks-fill-indexer";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const SOURCE = "hypersync-cryptopunks";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;
const PROVIDER_ACCOUNT = "hypersync-cryptopunks:default";
const DAILY_ALLOWANCE = 200_000;

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}
function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("hypersync-cryptopunks-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op.");
  }
  return token;
}

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Same shared, cross-lane circuit breaker every hypersync-*-scan.ts uses
  // (one real Envio account behind all lanes; see hypersync-account-jail.ts).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-cryptopunks-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-cryptopunks-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function punkIndexTopic(punkIndex: string): string {
  return "0x" + BigInt(punkIndex).toString(16).padStart(64, "0");
}

function makeBidResolver(client: HypersyncClient): AcceptedBidResolver {
  return async (punkIndex, beforeBlock, beforeLogIndex) => {
    const query: Query = {
      fromBlock: CRYPTOPUNKS_GENESIS_BLOCK,
      toBlock: beforeBlock + 1,
      logs: [{ address: [CRYPTOPUNKS_MARKET_ADDRESS], topics: [[PUNK_BID_ENTERED_TOPIC], [punkIndexTopic(punkIndex)]] }],
      fieldSelection: { log: ["Topic0", "Topic1", "Topic2", "Data", "BlockNumber", "TransactionHash", "LogIndex"] },
    };
    let best: { bid: ReturnType<typeof decodePunkBidEntered>; txHash: string; logIndex: number; blockNumber: number } | null = null;
    let q = query;
    for (;;) {
      const res = await withHypersyncReservation(() => client.get(q));
      for (const log of res.data.logs) {
        if (!log.topics || !log.data || !log.transactionHash || log.blockNumber == null) continue;
        const b = log.blockNumber;
        const li = log.logIndex ?? 0;
        if (b > beforeBlock || (b === beforeBlock && li >= beforeLogIndex)) continue;
        const bid = decodePunkBidEntered(log.topics.filter((t): t is string => t != null), log.data);
        if (!bid) continue;
        if (!best || b > best.blockNumber || (b === best.blockNumber && li > best.logIndex)) best = { bid, txHash: log.transactionHash, logIndex: li, blockNumber: b };
      }
      if (res.nextBlock >= beforeBlock + 1) break;
      q = { ...q, fromBlock: res.nextBlock };
    }
    return best && best.bid ? { bid: best.bid, txHash: best.txHash, logIndex: best.logIndex } : null;
  };
}

export async function scanChainForCryptoPunksFillsViaHypersync(chainSlug: string): Promise<CryptoPunksFillScanResult> {
  return scanInternal(chainSlug, `${chainSlug}::cryptopunks-market-live-v1`, "forward-from-recent");
}

export async function scanChainForCryptoPunksFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<CryptoPunksFillScanResult> {
  return scanInternal(chainSlug, `${chainSlug}::cryptopunks-market-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(chainSlug: string, cursorKey: string, mode: "forward-from-recent" | "forward-from-genesis"): Promise<CryptoPunksFillScanResult> {
  const empty = (error?: string): CryptoPunksFillScanResult => ({ chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, unresolvedAcceptBids: 0, ...(error ? { error } : {}) });
  if (chainSlug !== "eth-mainnet") return empty();
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) return empty(`hypersync-cryptopunks-scan: no chainId mapping for "${chainSlug}"`);
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) return empty(`hypersync-cryptopunks-scan: source jailed/exhausted (${gate.reason})`);

  let client: HypersyncClient;
  try {
    client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken: requireApiToken() });
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
  let height: number;
  try {
    height = await withHypersyncReservation(() => client.getHeight());
    recordSourceSuccess(SOURCE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSourceFailure(SOURCE, /rate limit|quota|429|too many/i.test(message));
    return empty(message);
  }

  const cursor = await readCursor(cursorKey);
  const fromBlock = cursor != null ? cursor + 1 : mode === "forward-from-genesis" ? CRYPTOPUNKS_GENESIS_BLOCK : Math.max(CRYPTOPUNKS_GENESIS_BLOCK, height - CHUNK_BLOCKS);
  const toBlock = mode === "forward-from-genesis" ? height : Math.min(height, fromBlock + CHUNK_BLOCKS);
  if (fromBlock >= toBlock) return { chainSlug, fromBlock, toBlock: fromBlock, logsScanned: 0, fillsWritten: 0, unresolvedAcceptBids: 0 };

  let totalLogs = 0;
  let totalWritten = 0;
  let totalUnresolved = 0;
  let lastSucceededBlock = cursor ?? fromBlock;
  const resolver = makeBidResolver(client);

  let query: Query = {
    fromBlock,
    toBlock,
    logs: [{ address: [CRYPTOPUNKS_MARKET_ADDRESS], topics: [[PUNK_BOUGHT_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "BlockNumber", "TransactionHash", "LogIndex"],
      block: ["Number", "Timestamp"],
    },
  };

  try {
    while (totalLogs < MAX_LOGS_PER_RUN) {
      const res = await withHypersyncReservation(() => client.get(query));
      recordSourceSuccess(SOURCE);
      const timestampByBlock = new Map<number, number>();
      for (const block of res.data.blocks ?? []) {
        if (block.number != null && block.timestamp != null) timestampByBlock.set(block.number, block.timestamp);
      }
      const logs: PunkBoughtLog[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        const bought = decodePunkBought(log.topics.filter((t): t is string => t != null), log.data);
        if (!bought) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        logs.push({ chainSlug, txHash: log.transactionHash, logIndex: log.logIndex ?? 0, blockNumber, blockTimestamp: timestampByBlock.get(blockNumber) ?? null, bought });
      }
      if (logs.length > 0) {
        const { sales, unresolved } = await resolvePunkSales(logs, resolver);
        totalUnresolved += unresolved.length;
        if (sales.length > 0) totalWritten += await writeCryptoPunksFills(sales);
      }
      const nextBlock = res.nextBlock;
      const completedThrough = Math.max(fromBlock, Math.min(nextBlock, toBlock) - 1);
      await writeCursor(cursorKey, completedThrough);
      lastSucceededBlock = completedThrough;
      if (nextBlock >= toBlock || totalLogs >= MAX_LOGS_PER_RUN) break;
      query = { ...query, fromBlock: nextBlock };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSourceFailure(SOURCE, /rate limit|quota|429|too many/i.test(message));
    return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten, unresolvedAcceptBids: totalUnresolved, error: message };
  }

  const nextBlock = Math.min(height, lastSucceededBlock + 1);
  await writeChainCoverage({
    chainSlug,
    lane: mode === "forward-from-genesis" ? "historical" : "forward",
    standardGroup: "cryptopunks-market-fills",
    rangeStart: mode === "forward-from-genesis" ? CRYPTOPUNKS_GENESIS_BLOCK : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten, unresolvedAcceptBids: totalUnresolved };
}
