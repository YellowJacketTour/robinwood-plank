/**
 * HyperSync-backed Seaport OrderFulfilled fill scanning -- the fast path
 * for the exact chains still blocked on free RPC's own real archive-range
 * restriction (confirmed live 2026-08-20: PublicNode's free tier answers
 * "Archive requests require a personal token" for eth/arb/base/bnb-mainnet
 * when scanChainForFills's own cursor asks for a window it classifies as
 * historical). HyperSync has no such archive-vs-recent distinction for a
 * bounded log query -- same real, independently-benchmarked (up to 2000x
 * vs RPC) engine hypersync-evm-scan.ts already proves out for collection
 * discovery, applied here to the SAME OrderFulfilled decode/write pipeline
 * seaport-fill-indexer.ts already uses for its RPC path.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * ORDER_FULFILLED_TOPIC, decodeOrderFulfilled, writeFills, readCursor,
 * writeCursor are all imported directly from seaport-fill-indexer.ts (the
 * latter three newly exported for this purpose, behavior unchanged) --
 * this module's only real job is fetching the raw logs via HyperSync
 * instead of eth_getLogs. Both paths share the SAME cursor table
 * (plank_seaport_fill_cursor), and writeCursor's own GREATEST() clause
 * makes it safe for either path to run for a given chain without the
 * other regressing progress.
 *
 * SAME HONEST HyperSync LIMIT hypersync-evm-scan.ts ALREADY DOCUMENTS:
 * free tier is soft-capped (~100k events / 5GB / 7-day-idle flag),
 * positioned for development/testing, not unlimited. MAX_LOGS_PER_RUN
 * below protects that ceiling directly, same as the discovery scanner's
 * own budget.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import {
  ORDER_FULFILLED_TOPIC,
  decodeOrderFulfilled,
  writeFills,
  readCursor,
  writeCursor,
  type FillScanResult,
} from "@/lib/market/multichain/seaport-fill-indexer";
import { ALL_SEAPORT_ADDRESSES } from "@/lib/market/multichain/seaport-deployments";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const SOURCE = "hypersync-seaport";
const CHUNK_BLOCKS = 50_000; // same conservative window hypersync-evm-scan.ts already uses
const MAX_LOGS_PER_RUN = 20_000; // same free-tier event-quota guard

const HYPERSYNC_SEAPORT_PROVIDER_ACCOUNT = "hypersync-seaport:default";
/** Same approximation rationale as hypersync-evm-scan.ts's own HYPERSYNC_EVM_DAILY_ALLOWANCE -- no DAILY_CEILING entry exists for "hypersync-seaport" (HyperSync's real limit is event/storage volume, not call count). Approximated at the same conservative order of magnitude, purely to add a durable cross-process guard on top of the existing in-memory checkSourceBudget gate. */
const HYPERSYNC_SEAPORT_DAILY_ALLOWANCE = 200_000;

/** One real HyperSync call (getHeight or a query page) reserved/settled durably around it. */
async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker (hypersync-account-jail.ts) --
  // see hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: manual anchored-membership/priority-
  // window testing exhausted the real shared Envio account; this lane's
  // OWN in-memory jail is per-process and reset every ~4-minute pass
  // relaunch, so it kept re-discovering the SAME still-ongoing outage from
  // scratch instead of ever finding out from a sibling lane).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-seaport-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_SEAPORT_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_SEAPORT_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-seaport-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_SEAPORT_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_SEAPORT_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-seaport-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/**
 * Same real signature/return shape as scanChainForFills (seaport-fill-
 * indexer.ts) so a caller can use either interchangeably -- the only
 * difference is HOW logs are fetched, never what "a fill" means or how
 * it's stored.
 */
export async function scanChainForFillsViaHypersync(chainSlug: string): Promise<FillScanResult> {
  return scanChainForFillsInternal(chainSlug, `${chainSlug}::seaport-all-live-v1`, "forward-from-recent");
}

/**
 * Real full-history backfill, live 2026-08-20 ("i want from all genesis
 * blocks no exceptions"): scanChainForFillsViaHypersync's own cursor is
 * intentionally forward-only from whenever this app FIRST ran it (same
 * documented scope the RPC path already holds) -- it can never reach
 * anything older than that first-run point, which is exactly why
 * volume/sales stayed near-empty for chains this only just started
 * covering. This walks forward from block 0 instead, under a SEPARATE
 * cursor key (":genesis-backfill" suffix, same plank_seaport_fill_cursor
 * table, just a different row) so repeated calls make real incremental
 * progress toward the current chain height without disturbing or being
 * clamped by the live forward cursor's own GREATEST() progress.
 *
 * Honest about what "genesis" means here: literal block 0 as the real
 * floor, not a guessed/fabricated Seaport deployment block for each
 * chain (this app never fabricates a number it hasn't verified) -- the
 * pre-deployment range simply returns zero matching logs and advances
 * through quickly, no wasted correctness risk either way.
 */
export async function scanChainForFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<FillScanResult> {
  // New cursor namespace is intentional: an older 1.6-only cursor may already
  // be at head and cannot prove that 1.1-1.5 ranges were ever queried.
  return scanChainForFillsInternal(chainSlug, `${chainSlug}::seaport-all-genesis-v1`, "forward-from-genesis");
}

async function scanChainForFillsInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<FillScanResult> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-seaport-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-seaport-scan: source jailed/exhausted (${gate.reason})` };
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
  // A genesis run is log-budget bounded rather than block-window bounded.
  // HyperSync paginates this sparse, address/topic-filtered query, so letting
  // it seek to the current height avoids spending hundreds of cron ticks on
  // empty pre-deployment block ranges. The hard MAX_LOGS_PER_RUN guard still
  // caps actual free-tier consumption and the durable cursor resumes exactly.
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
    logs: [{ address: ALL_SEAPORT_ADDRESSES, topics: [[ORDER_FULFILLED_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "BlockNumber", "TransactionHash", "LogIndex"],
      // Real block.timestamp field (confirmed against the installed
      // package's own index.d.ts, 2026-08-20) -- HyperSync returns the
      // blocks touched by the matched logs in the SAME response
      // (res.data.blocks), no second round-trip needed, unlike the RPC
      // path which has no such join and needs its own eth_getBlockByNumber
      // calls. This is what makes real block_timestamp population
      // possible here at zero extra request cost.
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

      const rows: { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number | null; deploymentAddress: string | null; fill: ReturnType<typeof decodeOrderFulfilled> }[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Real bug found live 2026-08-20: HyperSync's field selection
        // always returns exactly 4 topic slots (Topic0..Topic3), padded
        // with `null` for any event whose real topic count is fewer --
        // OrderFulfilled only ever has 2 (the event signature + the
        // indexed `offerer`). ethers' Interface.parseLog expects ONLY
        // the real topics, no padding, and throws on a literal `null`
        // entry -- decodeOrderFulfilled's own try/catch silently
        // swallowed that into a null return, so EVERY log from this path
        // failed to decode (confirmed live: 5,174 real matched logs on
        // eth-mainnet alone, zero real fills written). Strip the padding
        // before decoding, exactly restoring the real topics array shape
        // eth_getLogs already provides natively on the RPC path.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeOrderFulfilled(realTopics, log.data);
        if (!fill) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          deploymentAddress: log.address?.toLowerCase() ?? null,
          fill,
        });
      }
      const validRows = rows.filter(
        (r): r is { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number | null; deploymentAddress: string | null; fill: NonNullable<typeof r.fill> } => r.fill != null
      );
      if (validRows.length > 0) {
        totalWritten += await writeFills(validRows);
      }

      const nextBlock = res.nextBlock;
      // nextBlock is an exclusive resume position. Persisting nextBlock itself
      // and then resuming at cursor + 1 skipped one whole block per page.
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
    standardGroup: "seaport-1.1-through-1.6-fills",
    rangeStart: mode === "forward-from-genesis" ? 0 : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
