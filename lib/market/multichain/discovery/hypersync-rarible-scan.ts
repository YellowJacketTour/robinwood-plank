/**
 * HyperSync-backed Rarible ExchangeV2 Match scanning -- same dual-cursor
 * (forward-from-recent live lane + forward-from-genesis backfill lane)
 * pattern as hypersync-looksrare-scan.ts, applied to the venue this app's
 * venue-registry.ts previously left `planned` as a confirmed blocker. See
 * rarible-fill-indexer.ts's own header for the cited address/event/function
 * sources and the real calldata-decode technique used (Match itself is
 * genuinely near-parameterless; the real data lives in the tx's own input).
 *
 * THE REAL DIFFERENCE FROM A PLAIN LOG-ONLY SCANNER
 * ---------------------------------------------------------------------------
 * This query requests `transaction: ["Input", "Hash"]` field selection
 * alongside the log selection. HyperSync's documented default join order is
 * logs -> transactions -> traces -> blocks, i.e. transactions related to a
 * matched log are returned in the SAME response automatically -- confirmed
 * against @envio-dev/hypersync-client's own index.d.ts (`Query.transactions`:
 * "it will return transactions that are related to the returned logs").
 * This means the real transaction input (calldata) needed to decode
 * matchOrders' real arguments comes back in the SAME bulk query as the
 * Match log, still one HyperSync call per chunk -- no per-tx
 * eth_getTransactionByHash fallback needed for this venue.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import {
  RARIBLE_EXCHANGE_V2_ADDRESS,
  RARIBLE_CHAIN_SLUG,
  RARIBLE_TOPICS,
  decodeRaribleMatch,
  writeRaribleFills,
  readCursor,
  writeCursor,
  type RaribleFillRow,
} from "@/lib/market/multichain/rarible-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";
import type { FillScanResult } from "@/lib/market/multichain/seaport-fill-indexer";

const SOURCE = "hypersync-rarible";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_RARIBLE_PROVIDER_ACCOUNT = "hypersync-rarible:default";
const HYPERSYNC_RARIBLE_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker -- see hypersync-account-jail.ts
  // and hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: every hypersync-*-scan.ts file shares
  // one real Envio account but tracked jail state under its own siloed
  // source string, so one lane's real 429 was invisible to every other
  // lane until each independently burned its own doomed call).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-rarible-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_RARIBLE_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_RARIBLE_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-rarible-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_RARIBLE_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_RARIBLE_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-rarible-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane. ExchangeV2's real deployment is eth-mainnet only (see rarible-fill-indexer.ts header); any other chainSlug is a documented no-op. */
export async function scanRaribleFillsViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== RARIBLE_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::rarible-exchange-v2-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane -- literal block 0 as the real floor, same honest "never fabricate a deployment block" stance as every other genesis lane. */
export async function scanRaribleFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== RARIBLE_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::rarible-exchange-v2-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-rarible-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-rarible-scan: source jailed/exhausted (${gate.reason})` };
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
    logs: [{ address: [RARIBLE_EXCHANGE_V2_ADDRESS], topics: [RARIBLE_TOPICS] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "BlockNumber", "TransactionHash", "LogIndex"],
      transaction: ["Hash", "Input"],
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
      const inputByTxHash = new Map<string, string>();
      for (const tx of res.data.transactions ?? []) {
        if (tx.hash && tx.input) inputByTxHash.set(tx.hash, tx.input);
      }

      const rows: RaribleFillRow[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Same real HyperSync topic-padding behavior every other scanner in
        // this app already documents and strips.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const txInput = inputByTxHash.get(log.transactionHash);
        if (!txInput) continue; // transaction data not returned this page -- do not fabricate
        const match = decodeRaribleMatch(realTopics, log.data, txInput);
        if (!match) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          match,
        });
      }
      if (rows.length > 0) {
        totalWritten += await writeRaribleFills(rows);
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
    standardGroup: "rarible-exchange-v2-fills",
    rangeStart: mode === "forward-from-genesis" ? 0 : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
