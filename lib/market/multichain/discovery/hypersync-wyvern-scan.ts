/**
 * HyperSync-backed Wyvern Exchange OrdersMatched fill scanning -- modeled
 * directly on hypersync-seaport-scan.ts's own dual-cursor (live-forward +
 * genesis-backfill) pattern. See that file's header for the full HyperSync
 * rationale (free-tier RPC archive-range restriction, 2000x benchmark,
 * shared budget/circuit-breaker plumbing) -- unchanged here, just retargeted
 * at Wyvern's real OrdersMatched event instead of Seaport's OrderFulfilled.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * ORDERS_MATCHED_TOPIC, decodeOrdersMatched, writeWyvernFills, readCursor,
 * writeCursor all come from wyvern-fill-indexer.ts.
 *
 * REAL, VERIFIED DEPLOYMENTS -- ETHEREUM MAINNET ONLY
 * ---------------------------------------------------------------------------
 * Wyvern, unlike Seaport, was never redeployed at a shared address across
 * chains -- see wyvern-deployments.ts for both real addresses and their
 * independently-verified deployment blocks (v1 from protofire's own
 * subgraph.yaml; v2 from a real Ethplorer contract-creation lookup,
 * documented there since Etherscan itself 403'd every automated fetch this
 * session).
 *
 * GENUINE GENESIS FLOOR, NOT BLOCK 0
 * ---------------------------------------------------------------------------
 * Unlike hypersync-seaport-scan.ts's own genesis lane (which walks from
 * literal block 0 because Seaport's real per-chain deployment blocks were
 * never individually researched), Wyvern's real deployment block IS known
 * here (WYVERN_GENESIS_BLOCK, the earlier of the two real addresses' real
 * deployment blocks) -- so the backfill starts there directly rather than
 * wasting HyperSync pages walking pre-deployment history that can only ever
 * return zero matching logs.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import {
  ORDERS_MATCHED_TOPIC,
  decodeOrdersMatched,
  writeWyvernFills,
  readCursor,
  writeCursor,
  type WyvernFillScanResult,
} from "@/lib/market/multichain/wyvern-fill-indexer";
import { ALL_WYVERN_ADDRESSES, WYVERN_GENESIS_BLOCK } from "@/lib/market/multichain/wyvern-deployments";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const SOURCE = "hypersync-wyvern";
const CHUNK_BLOCKS = 50_000; // same conservative window hypersync-seaport-scan.ts uses
const MAX_LOGS_PER_RUN = 20_000; // same free-tier event-quota guard

const HYPERSYNC_WYVERN_PROVIDER_ACCOUNT = "hypersync-wyvern:default";
/** Same approximation rationale as hypersync-seaport-scan.ts's own allowance constant -- no DAILY_CEILING entry exists for "hypersync-wyvern" (HyperSync's real limit is event/storage volume, not call count). */
const HYPERSYNC_WYVERN_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker -- see hypersync-account-jail.ts
  // and hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: every hypersync-*-scan.ts file shares
  // one real Envio account but tracked jail state under its own siloed
  // source string, so one lane's real 429 was invisible to every other
  // lane until each independently burned its own doomed call).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-wyvern-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_WYVERN_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_WYVERN_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-wyvern-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_WYVERN_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_WYVERN_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-wyvern-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Same real signature/return shape as scanChainForFillsViaHypersync (Seaport) so a caller can use either interchangeably. */
export async function scanChainForWyvernFillsViaHypersync(chainSlug: string): Promise<WyvernFillScanResult> {
  return scanChainForWyvernFillsInternal(chainSlug, `${chainSlug}::wyvern-all-live-v1`, "forward-from-recent");
}

/**
 * Full-history backfill under a separate cursor key, same reasoning as
 * scanChainForFillsGenesisBackfillViaHypersync -- but starting from
 * WYVERN_GENESIS_BLOCK (a real, verified deployment block), not block 0.
 */
export async function scanChainForWyvernFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<WyvernFillScanResult> {
  return scanChainForWyvernFillsInternal(chainSlug, `${chainSlug}::wyvern-all-genesis-v1`, "forward-from-genesis");
}

async function scanChainForWyvernFillsInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<WyvernFillScanResult> {
  // Wyvern is Ethereum-mainnet-only -- both real deployments live there,
  // never redeployed elsewhere (see wyvern-deployments.ts). Every other
  // chain returns a clean, honest zero-work result rather than a spurious
  // error, so a caller that loops every EVM chain (mirroring the Seaport
  // pattern) doesn't need its own Wyvern-specific chain allowlist.
  if (chainSlug !== "eth-mainnet") {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }

  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-wyvern-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-wyvern-scan: source jailed/exhausted (${gate.reason})` };
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
        ? WYVERN_GENESIS_BLOCK
        : Math.max(WYVERN_GENESIS_BLOCK, height - CHUNK_BLOCKS);
  // Genesis run is log-budget bounded, not block-window bounded -- same
  // reasoning as hypersync-seaport-scan.ts's own genesis lane (sparse,
  // address/topic-filtered query; the hard MAX_LOGS_PER_RUN guard still
  // caps actual free-tier consumption per call).
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
    logs: [{ address: ALL_WYVERN_ADDRESSES, topics: [[ORDERS_MATCHED_TOPIC]] }],
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

      const rows: { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number | null; deploymentAddress: string | null; fill: ReturnType<typeof decodeOrdersMatched> }[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash) continue;
        // Same real HyperSync topic-padding bug hypersync-seaport-scan.ts
        // already found and fixed for OrderFulfilled (2026-08-20): field
        // selection always returns exactly 4 topic slots, null-padded when
        // the real event has fewer. OrdersMatched has 4 real topics
        // (signature + maker + taker + metadata), so this is a no-op here
        // in practice, but stripping is done unconditionally anyway --
        // ethers' parseLog throws on a literal `null` topic entry
        // regardless of count, so this is cheap insurance against ever
        // silently losing every log the way that first bug did.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeOrdersMatched(realTopics, log.data);
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
        totalWritten += await writeWyvernFills(validRows);
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
    standardGroup: "wyvern-1-2-fills",
    rangeStart: mode === "forward-from-genesis" ? WYVERN_GENESIS_BLOCK : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
