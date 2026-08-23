/**
 * HyperSync-backed BlurExchange OrdersMatched fill scanning -- same
 * dual-cursor (live-forward + genesis-backfill) pattern as
 * hypersync-wyvern-scan.ts and hypersync-looksrare-scan.ts, retargeted at
 * Blur's real OrdersMatched event. See blur-fill-indexer.ts's own header for
 * the cited address/event sources and the honest Blend-out-of-scope note.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * BLUR_EXCHANGE_ADDRESS, BLUR_TOPICS, decodeBlurOrdersMatched,
 * writeBlurFills, readCursor, writeCursor all come from blur-fill-indexer.ts.
 *
 * REAL, VERIFIED DEPLOYMENT -- ETHEREUM MAINNET ONLY
 * ---------------------------------------------------------------------------
 * BlurExchange (BLUR_EXCHANGE_ADDRESS) was never redeployed at the same
 * address on another chain (Blur later shipped a Blast-mainnet presence,
 * but that is a separate deployment this pass did not independently verify
 * -- left out rather than guessed, same stance venue-registry.ts already
 * documents). BLUR_GENESIS_BLOCK is the real Sourcify-reported deployment
 * block (15779579) -- the genesis lane starts there directly rather than
 * walking pre-deployment history that can only return zero matching logs.
 *
 * Same honest HyperSync free-tier limit hypersync-seaport-scan.ts already
 * documents (soft-capped ~100k events / 5GB / 7-day-idle) -- MAX_LOGS_PER_RUN
 * protects the same ceiling.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import {
  BLUR_EXCHANGE_ADDRESS,
  BLUR_CHAIN_SLUG,
  BLUR_GENESIS_BLOCK,
  BLUR_TOPICS,
  decodeBlurOrdersMatched,
  writeBlurFills,
  readCursor,
  writeCursor,
  type BlurFillRow,
  type BlurFillScanResult,
} from "@/lib/market/multichain/blur-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";

const SOURCE = "hypersync-blur";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_BLUR_PROVIDER_ACCOUNT = "hypersync-blur:default";
const HYPERSYNC_BLUR_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  const window = utcDayWindow(HYPERSYNC_BLUR_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_BLUR_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-blur-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_BLUR_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_BLUR_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-blur-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane. Blur is eth-mainnet only (see this file's own header); any other chainSlug is a documented no-op. */
export async function scanBlurFillsViaHypersync(chainSlug: string): Promise<BlurFillScanResult> {
  if (chainSlug !== BLUR_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::blur-exchange-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane, starting from the real BLUR_GENESIS_BLOCK. */
export async function scanBlurFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<BlurFillScanResult> {
  if (chainSlug !== BLUR_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::blur-exchange-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<BlurFillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-blur-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-blur-scan: source jailed/exhausted (${gate.reason})` };
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
        ? BLUR_GENESIS_BLOCK
        : Math.max(BLUR_GENESIS_BLOCK, height - CHUNK_BLOCKS);
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
    logs: [{ address: [BLUR_EXCHANGE_ADDRESS], topics: [BLUR_TOPICS] }],
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

      const rows: BlurFillRow[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Same real HyperSync topic-padding fix hypersync-seaport-scan.ts /
        // hypersync-wyvern-scan.ts already apply: strip null-padded topic
        // slots before handing to ethers, which throws on a literal null.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeBlurOrdersMatched(realTopics, log.data);
        if (!fill) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          fill,
        });
      }
      if (rows.length > 0) {
        totalWritten += await writeBlurFills(rows);
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
    standardGroup: "blur-exchange-fills",
    rangeStart: mode === "forward-from-genesis" ? BLUR_GENESIS_BLOCK : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
