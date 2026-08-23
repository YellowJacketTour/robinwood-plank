/**
 * HyperSync-backed Sudoswap v1 SwapNFTInPair/SwapNFTOutPair scanning -- same
 * dual-cursor (forward-from-recent live lane + forward-from-genesis backfill
 * lane) pattern as hypersync-looksrare-scan.ts, applied to the venue this
 * app's venue-registry.ts previously left `planned` as a confirmed blocker.
 * See sudoswap-fill-indexer.ts's own header for the cited address/event
 * sources and the real receipt-log-correlation technique used instead of a
 * single-log decode.
 *
 * THE ONE REAL DIFFERENCE FROM EVERY OTHER HYPERSYNC SCANNER IN THIS APP
 * ---------------------------------------------------------------------------
 * Every other venue decodes a fill entirely from ONE log's topics+data.
 * Sudoswap's Swap events are genuinely parameterless, so this scanner sets
 * `joinMode: JoinAll` on the query -- HyperSync's own documented behavior
 * ("if logSelection matches log0, we get the associated transaction of log0
 * and then we get associated logs of that transaction as well") returns the
 * sibling ERC721/ERC20 Transfer logs from the SAME transaction in the SAME
 * response, still one bulk query per chunk, never a per-tx RPC fallback.
 * There is also no `address` filter on the log selection (unlike every
 * other scanner here) because Sudoswap pairs are per-collection minimal-
 * proxy clones with no single "the exchange" address -- topic0 alone
 * (SwapNFTInPair()/SwapNFTOutPair()'s own real, unique selectors) is the
 * real, correct filter.
 */
import { HypersyncClient, JoinMode, type Query } from "@envio-dev/hypersync-client";
import {
  SUDOSWAP_CHAIN_SLUG,
  SUDOSWAP_SWAP_TOPICS,
  TRANSFER_TOPIC,
  correlateSudoswapSwap,
  writeSudoswapFills,
  readCursor,
  writeCursor,
  type RawLog,
  type SudoswapFillRow,
} from "@/lib/market/multichain/sudoswap-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import type { FillScanResult } from "@/lib/market/multichain/seaport-fill-indexer";

const SOURCE = "hypersync-sudoswap";
// Smaller than the other scanners' 50k -- JoinAll pulls in every sibling log
// of every matched transaction (not just Sudoswap logs), so the real payload
// per block range is materially larger here.
const CHUNK_BLOCKS = 10_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_SUDOSWAP_PROVIDER_ACCOUNT = "hypersync-sudoswap:default";
const HYPERSYNC_SUDOSWAP_DAILY_ALLOWANCE = 2_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  const window = utcDayWindow(HYPERSYNC_SUDOSWAP_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_SUDOSWAP_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-sudoswap-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_SUDOSWAP_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_SUDOSWAP_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-sudoswap-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane. Sudoswap v1's real 2022+ activity is eth-mainnet only (see sudoswap-fill-indexer.ts header); any other chainSlug is a documented no-op. */
export async function scanSudoswapFillsViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== SUDOSWAP_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::sudoswap-v1-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane -- literal block 0 as the real floor, same honest "never fabricate a deployment block" stance as every other genesis lane. */
export async function scanSudoswapFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== SUDOSWAP_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::sudoswap-v1-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-sudoswap-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-sudoswap-scan: source jailed/exhausted (${gate.reason})` };
  }

  let client: HypersyncClient;
  try {
    client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken: requireApiToken() });
  } catch (err) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: err instanceof Error ? err.message : String(err) };
  }

  let height: number;
  try {
    height = await withHypersyncReservation(() => client.getHeight());
    recordSourceSuccess(SOURCE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSourceFailure(SOURCE, /rate limit|quota|429|too many/i.test(message));
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: message };
  }

  const cursor = await readCursor(cursorKey);
  const fromBlock =
    cursor != null
      ? cursor + 1
      : mode === "forward-from-genesis"
        ? 0
        : Math.max(0, height - CHUNK_BLOCKS);
  const toBlock = mode === "forward-from-genesis" ? height : Math.min(height, fromBlock + CHUNK_BLOCKS);

  if (fromBlock >= toBlock) {
    return { chainSlug, fromBlock, toBlock: fromBlock, logsScanned: 0, fillsWritten: 0 };
  }

  let totalLogs = 0;
  let totalWritten = 0;
  let lastSucceededBlock = cursor ?? fromBlock;

  let query: Query = {
    fromBlock,
    toBlock,
    logs: [{ topics: [SUDOSWAP_SWAP_TOPICS] }],
    joinMode: JoinMode.JoinAll,
    // Real safety valve on JoinAll's larger-than-usual per-query payload
    // (every sibling log of every matched tx, not just Sudoswap logs).
    maxNumLogs: MAX_LOGS_PER_RUN,
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

      // JoinAll returns every log for every matched transaction in one flat
      // array -- group by txHash so each real Swap log can be correlated
      // against its own real sibling Transfer logs, never a different tx's.
      const logsByTx = new Map<string, RawLog[]>();
      for (const log of res.data.logs) {
        if (!log.transactionHash) continue;
        const arr = logsByTx.get(log.transactionHash) ?? [];
        arr.push(log as RawLog);
        logsByTx.set(log.transactionHash, arr);
      }

      const rows: SudoswapFillRow[] = [];
      for (const log of res.data.logs) {
        if (!log.topics || log.topics.length === 0 || !log.transactionHash) continue;
        if (log.topics[0] !== SUDOSWAP_SWAP_TOPICS[0] && log.topics[0] !== SUDOSWAP_SWAP_TOPICS[1]) continue;
        totalLogs += 1;

        const siblings = logsByTx.get(log.transactionHash) ?? [];
        const swap = correlateSudoswapSwap(log as RawLog, siblings);
        if (!swap) continue;

        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          swap,
        });
      }
      if (rows.length > 0) {
        totalWritten += await writeSudoswapFills(rows);
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
    return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten, error: message };
  }

  const nextBlock = Math.min(height, lastSucceededBlock + 1);
  await writeChainCoverage({
    chainSlug,
    lane: mode === "forward-from-genesis" ? "historical" : "forward",
    standardGroup: "sudoswap-v1-fills",
    rangeStart: mode === "forward-from-genesis" ? 0 : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
