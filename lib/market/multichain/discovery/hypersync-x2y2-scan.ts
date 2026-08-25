/**
 * HyperSync-backed X2Y2 (X2Y2_r1) EvInventory fill scanning -- same
 * dual-cursor (live-forward + genesis-backfill) pattern as
 * hypersync-wyvern-scan.ts / hypersync-blur-scan.ts, retargeted at X2Y2's
 * real EvInventory event. See x2y2-fill-indexer.ts's own header for the
 * cited address/event/struct sources and the honest item.data decode scope.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * X2Y2_ADDRESS, X2Y2_TOPICS, decodeX2Y2Fill, writeX2Y2Fills, readCursor,
 * writeCursor all come from x2y2-fill-indexer.ts.
 *
 * REAL, VERIFIED DEPLOYMENT -- ETHEREUM MAINNET ONLY
 * ---------------------------------------------------------------------------
 * X2Y2_ADDRESS is the real, live-traffic X2Y2 Exchange PROXY (not the
 * X2Y2_r1 implementation address -- see x2y2-fill-indexer.ts's own header
 * for why that distinction matters and how a first attempt at the wrong
 * address was caught by a live smoke test). It was never redeployed
 * elsewhere; X2Y2_GENESIS_BLOCK is the real Sourcify-reported proxy
 * deployment block (14139341) -- the genesis lane starts there directly
 * rather than walking pre-deployment history.
 *
 * Same honest HyperSync free-tier limit hypersync-seaport-scan.ts already
 * documents (soft-capped ~100k events / 5GB / 7-day-idle) -- MAX_LOGS_PER_RUN
 * protects the same ceiling.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import {
  X2Y2_ADDRESS,
  X2Y2_CHAIN_SLUG,
  X2Y2_GENESIS_BLOCK,
  X2Y2_TOPICS,
  decodeX2Y2Fill,
  writeX2Y2Fills,
  readCursor,
  writeCursor,
  type X2Y2FillRow,
  type X2Y2FillScanResult,
} from "@/lib/market/multichain/x2y2-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const SOURCE = "hypersync-x2y2";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_X2Y2_PROVIDER_ACCOUNT = "hypersync-x2y2:default";
const HYPERSYNC_X2Y2_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker -- see hypersync-account-jail.ts
  // and hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: every hypersync-*-scan.ts file shares
  // one real Envio account but tracked jail state under its own siloed
  // source string, so one lane's real 429 was invisible to every other
  // lane until each independently burned its own doomed call).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-x2y2-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_X2Y2_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_X2Y2_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-x2y2-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_X2Y2_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_X2Y2_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-x2y2-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane. X2Y2 is eth-mainnet only; any other chainSlug is a documented no-op. */
export async function scanX2Y2FillsViaHypersync(chainSlug: string): Promise<X2Y2FillScanResult> {
  if (chainSlug !== X2Y2_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::x2y2-r1-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane, starting from the real X2Y2_GENESIS_BLOCK. */
export async function scanX2Y2FillsGenesisBackfillViaHypersync(chainSlug: string): Promise<X2Y2FillScanResult> {
  if (chainSlug !== X2Y2_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::x2y2-r1-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<X2Y2FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-x2y2-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-x2y2-scan: source jailed/exhausted (${gate.reason})` };
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
        ? X2Y2_GENESIS_BLOCK
        : Math.max(X2Y2_GENESIS_BLOCK, height - CHUNK_BLOCKS);
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
    logs: [{ address: [X2Y2_ADDRESS], topics: [X2Y2_TOPICS] }],
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

      const rows: X2Y2FillRow[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeX2Y2Fill(realTopics, log.data);
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
        totalWritten += await writeX2Y2Fills(rows);
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
    standardGroup: "x2y2-r1-fills",
    rangeStart: mode === "forward-from-genesis" ? X2Y2_GENESIS_BLOCK : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
