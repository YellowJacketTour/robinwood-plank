/**
 * HyperSync-backed LooksRare v1 TakerAsk/TakerBid fill scanning -- exact
 * same dual-cursor (forward-from-recent live lane + forward-from-genesis
 * backfill lane) pattern as hypersync-seaport-scan.ts, applied to the
 * second real historic marketplace this app had zero indexing for. See
 * looksrare-fill-indexer.ts's own header for the cited address/event
 * sources and the honest v1-only/eth-mainnet-only scope note.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * LOOKSRARE_V1_ADDRESS, LOOKSRARE_V1_TOPICS, decodeLooksRareFill,
 * writeLooksRareFills, readCursor, writeCursor all come straight from
 * looksrare-fill-indexer.ts -- this module's only job is fetching raw logs
 * via HyperSync instead of eth_getLogs, identical to how
 * hypersync-seaport-scan.ts relates to seaport-fill-indexer.ts.
 *
 * Same honest HyperSync free-tier limit hypersync-seaport-scan.ts already
 * documents (soft-capped ~100k events / 5GB / 7-day-idle) -- MAX_LOGS_PER_RUN
 * protects the same ceiling.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import {
  LOOKSRARE_V1_ADDRESS,
  LOOKSRARE_V1_CHAIN_SLUG,
  LOOKSRARE_V1_TOPICS,
  decodeLooksRareFill,
  writeLooksRareFills,
  readCursor,
  writeCursor,
  type LooksRareFillRow,
} from "@/lib/market/multichain/looksrare-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import type { FillScanResult } from "@/lib/market/multichain/seaport-fill-indexer";

const SOURCE = "hypersync-looksrare";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_LOOKSRARE_PROVIDER_ACCOUNT = "hypersync-looksrare:default";
/** Same approximation rationale as hypersync-seaport-scan.ts's own allowance constant -- purely a durable cross-process guard layered on top of the in-memory checkSourceBudget gate. */
const HYPERSYNC_LOOKSRARE_DAILY_ALLOWANCE = 2_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  const window = utcDayWindow(HYPERSYNC_LOOKSRARE_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_LOOKSRARE_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-looksrare-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_LOOKSRARE_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_LOOKSRARE_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-looksrare-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane -- same real signature/return shape as scanChainForFillsViaHypersync so a caller can treat either marketplace's scan interchangeably. LooksRare v1 is eth-mainnet only (see looksrare-fill-indexer.ts header); any other chainSlug is a documented no-op, never a silent guess at a nonexistent deployment. */
export async function scanLooksRareFillsViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== LOOKSRARE_V1_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::looksrare-v1-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane -- literal block 0 as the real floor, same honest "never fabricate a deployment block" stance hypersync-seaport-scan.ts's own genesis lane documents. Pre-deployment range simply returns zero matching logs and advances through quickly. */
export async function scanLooksRareFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== LOOKSRARE_V1_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::looksrare-v1-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-looksrare-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-looksrare-scan: source jailed/exhausted (${gate.reason})` };
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
    logs: [{ address: [LOOKSRARE_V1_ADDRESS], topics: [LOOKSRARE_V1_TOPICS] }],
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

      const rows: LooksRareFillRow[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Same real padding bug hypersync-seaport-scan.ts documents and
        // fixes: HyperSync's field selection always returns 4 topic slots,
        // padded with `null` past an event's real topic count. TakerAsk/
        // TakerBid both have exactly 4 real topics (signature + taker +
        // maker + strategy), so this is a no-op here in practice, but the
        // strip is kept for the same defensive reason -- ethers throws on
        // a literal `null` topic entry rather than treating it as absent.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeLooksRareFill(realTopics, log.data);
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
        totalWritten += await writeLooksRareFills(rows);
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
    standardGroup: "looksrare-v1-fills",
    rangeStart: mode === "forward-from-genesis" ? 0 : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
