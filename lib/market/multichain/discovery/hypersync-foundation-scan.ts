/**
 * HyperSync-backed Foundation Market fill scanning -- exact same
 * dual-cursor (forward-from-recent live lane + forward-from-genesis
 * backfill lane) pattern as hypersync-looksrare-scan.ts, applied to the
 * third real historic marketplace this app had zero indexing for. See
 * foundation-fill-indexer.ts's own header for the cited address/event
 * sources and the honest v2-market/eth-mainnet-only scope note.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * FOUNDATION_MARKET_ADDRESS, FOUNDATION_TOPICS, decodeFoundationEvent,
 * writeFoundationEvents, readCursor, writeCursor all come straight from
 * foundation-fill-indexer.ts -- this module's only job is fetching raw logs
 * via HyperSync instead of eth_getLogs, identical to how
 * hypersync-looksrare-scan.ts relates to looksrare-fill-indexer.ts.
 *
 * Same honest HyperSync free-tier limit hypersync-seaport-scan.ts already
 * documents (soft-capped ~100k events / 5GB / 7-day-idle) -- MAX_LOGS_PER_RUN
 * protects the same ceiling.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import {
  FOUNDATION_MARKET_ADDRESS,
  FOUNDATION_CHAIN_SLUG,
  FOUNDATION_TOPICS,
  decodeFoundationEvent,
  writeFoundationEvents,
  readCursor,
  writeCursor,
  type FoundationLogRow,
} from "@/lib/market/multichain/foundation-fill-indexer";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";
import type { FillScanResult } from "@/lib/market/multichain/seaport-fill-indexer";

const SOURCE = "hypersync-foundation";
const CHUNK_BLOCKS = 50_000;
const MAX_LOGS_PER_RUN = 20_000;

const HYPERSYNC_FOUNDATION_PROVIDER_ACCOUNT = "hypersync-foundation:default";
const HYPERSYNC_FOUNDATION_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker -- see hypersync-account-jail.ts
  // and hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: every hypersync-*-scan.ts file shares
  // one real Envio account but tracked jail state under its own siloed
  // source string, so one lane's real 429 was invisible to every other
  // lane until each independently burned its own doomed call).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-foundation-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_FOUNDATION_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_FOUNDATION_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-foundation-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_FOUNDATION_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_FOUNDATION_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-foundation-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Live-forward lane. Foundation Market is eth-mainnet only (see foundation-fill-indexer.ts header); any other chainSlug is a documented no-op. */
export async function scanFoundationFillsViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== FOUNDATION_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::foundation-live-v1`, "forward-from-recent");
}

/** Genesis-forward backfill lane -- literal block 0 as the real floor, same honest "never fabricate a deployment block" stance as the other genesis lanes. */
export async function scanFoundationFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<FillScanResult> {
  if (chainSlug !== FOUNDATION_CHAIN_SLUG) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }
  return scanInternal(chainSlug, `${chainSlug}::foundation-genesis-v1`, "forward-from-genesis");
}

async function scanInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-foundation-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-foundation-scan: source jailed/exhausted (${gate.reason})` };
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
    logs: [{ address: [FOUNDATION_MARKET_ADDRESS], topics: [FOUNDATION_TOPICS] }],
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

      const rows: FoundationLogRow[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Same real HyperSync padding behavior documented in
        // hypersync-seaport-scan.ts and hypersync-looksrare-scan.ts --
        // field selection always returns 4 topic slots padded with `null`
        // past an event's real topic count; strip before decoding.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const decoded = decodeFoundationEvent(realTopics, log.data);
        if (!decoded) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          decoded,
        });
      }
      if (rows.length > 0) {
        totalWritten += await writeFoundationEvents(rows);
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
    standardGroup: "foundation-fills",
    rangeStart: mode === "forward-from-genesis" ? 0 : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
