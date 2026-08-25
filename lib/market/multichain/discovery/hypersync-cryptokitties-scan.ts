/**
 * HyperSync-backed CryptoKitties SaleClockAuction/SiringClockAuction
 * AuctionSuccessful fill scanning -- modeled directly on
 * hypersync-wyvern-scan.ts's own dual-cursor (live-forward + genesis-
 * backfill) pattern. See that file's header for the full HyperSync
 * rationale (free-tier RPC archive-range restriction, shared budget/
 * circuit-breaker plumbing) -- unchanged here, just retargeted at
 * CryptoKitties' real AuctionSuccessful event across its two real native
 * auction-house addresses instead of Wyvern's OrdersMatched.
 *
 * REUSES, NEVER DUPLICATES, THE REAL DECODE/WRITE LOGIC
 * ---------------------------------------------------------------------------
 * AUCTION_SUCCESSFUL_TOPIC, decodeAuctionSuccessful, writeCryptoKittiesFills,
 * readCursor, writeCursor all come from cryptokitties-fill-indexer.ts.
 *
 * REAL, CROSS-CHECKED DEPLOYMENTS -- ETHEREUM MAINNET ONLY
 * ---------------------------------------------------------------------------
 * CryptoKitties' native auction houses were never redeployed on any other
 * chain -- see cryptokitties-deployments.ts for both real addresses and
 * this session's honest documentation of why the genesis floor below is a
 * conservative approximation rather than an independently-verified exact
 * deployment block (Etherscan itself 403'd every automated fetch this
 * session, same as it did for Wyvern v2's deployment lookup).
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";
import {
  AUCTION_SUCCESSFUL_TOPIC,
  decodeAuctionSuccessful,
  writeCryptoKittiesFills,
  readCursor,
  writeCursor,
  type CryptoKittiesFillScanResult,
} from "@/lib/market/multichain/cryptokitties-fill-indexer";
import { ALL_CRYPTOKITTIES_AUCTION_ADDRESSES, CRYPTOKITTIES_GENESIS_BLOCK } from "@/lib/market/multichain/cryptokitties-deployments";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const SOURCE = "hypersync-cryptokitties";
const CHUNK_BLOCKS = 50_000; // same conservative window hypersync-wyvern-scan.ts uses
const MAX_LOGS_PER_RUN = 20_000; // same free-tier event-quota guard

const HYPERSYNC_CRYPTOKITTIES_PROVIDER_ACCOUNT = "hypersync-cryptokitties:default";
const HYPERSYNC_CRYPTOKITTIES_DAILY_ALLOWANCE = 200_000;

async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker -- see hypersync-account-jail.ts
  // and hypersync-evm-scan.ts's own copy of this comment for the full real
  // incident this fixes (2026-08-25: every hypersync-*-scan.ts file shares
  // one real Envio account but tracked jail state under its own siloed
  // source string, so one lane's real 429 was invisible to every other
  // lane until each independently burned its own doomed call).
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-cryptokitties-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_CRYPTOKITTIES_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_CRYPTOKITTIES_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-cryptokitties-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_CRYPTOKITTIES_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_CRYPTOKITTIES_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-cryptokitties-scan: ENVIO_API_TOKEN is not set -- generate one at https://envio.dev/app/api-tokens. This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** Same real signature/return shape as scanChainForWyvernFillsViaHypersync so a caller can use either interchangeably. */
export async function scanChainForCryptoKittiesFillsViaHypersync(chainSlug: string): Promise<CryptoKittiesFillScanResult> {
  return scanChainForCryptoKittiesFillsInternal(chainSlug, `${chainSlug}::cryptokitties-all-live-v1`, "forward-from-recent");
}

/**
 * Full-history backfill under a separate cursor key, same reasoning as
 * scanChainForWyvernFillsGenesisBackfillViaHypersync -- but starting from
 * CRYPTOKITTIES_GENESIS_BLOCK (a conservative, honestly-documented floor,
 * not block 0).
 */
export async function scanChainForCryptoKittiesFillsGenesisBackfillViaHypersync(chainSlug: string): Promise<CryptoKittiesFillScanResult> {
  return scanChainForCryptoKittiesFillsInternal(chainSlug, `${chainSlug}::cryptokitties-all-genesis-v1`, "forward-from-genesis");
}

async function scanChainForCryptoKittiesFillsInternal(
  chainSlug: string,
  cursorKey: string,
  mode: "forward-from-recent" | "forward-from-genesis"
): Promise<CryptoKittiesFillScanResult> {
  // CryptoKitties' native auction houses are Ethereum-mainnet-only -- never
  // redeployed elsewhere (see cryptokitties-deployments.ts). Every other
  // chain returns a clean, honest zero-work result rather than a spurious
  // error, so a caller that loops every EVM chain doesn't need its own
  // CryptoKitties-specific chain allowlist.
  if (chainSlug !== "eth-mainnet") {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0 };
  }

  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-cryptokitties-scan: no chainId mapping for "${chainSlug}"` };
  }

  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) {
    return { chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, fillsWritten: 0, error: `hypersync-cryptokitties-scan: source jailed/exhausted (${gate.reason})` };
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
        ? CRYPTOKITTIES_GENESIS_BLOCK
        : Math.max(CRYPTOKITTIES_GENESIS_BLOCK, height - CHUNK_BLOCKS);
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
    logs: [{ address: [...ALL_CRYPTOKITTIES_AUCTION_ADDRESSES], topics: [[AUCTION_SUCCESSFUL_TOPIC]] }],
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

      const rows: { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number | null; deploymentAddress: string; fill: ReturnType<typeof decodeAuctionSuccessful> }[] = [];
      for (const log of res.data.logs) {
        totalLogs += 1;
        if (!log.topics || !log.data || !log.transactionHash || !log.address) continue;
        // Same real HyperSync topic-padding behavior hypersync-wyvern-scan.ts
        // already guards against: field selection always returns exactly 4
        // topic slots, null-padded when the real event has fewer.
        // AuctionSuccessful has exactly 1 real topic (the signature -- none
        // of its 3 params are indexed), so this strips the 3 null pads
        // ethers' parseLog would otherwise choke on.
        const realTopics = log.topics.filter((t): t is string => t != null);
        const fill = decodeAuctionSuccessful(realTopics, log.data);
        if (!fill) continue;
        const blockNumber = log.blockNumber ?? fromBlock;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          blockNumber,
          blockTimestamp: timestampByBlock.get(blockNumber) ?? null,
          deploymentAddress: log.address.toLowerCase(),
          fill,
        });
      }
      const validRows = rows.filter(
        (r): r is { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; blockTimestamp: number | null; deploymentAddress: string; fill: NonNullable<typeof r.fill> } => r.fill != null
      );
      if (validRows.length > 0) {
        totalWritten += await writeCryptoKittiesFills(validRows);
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
    standardGroup: "cryptokitties-native-fills",
    rangeStart: mode === "forward-from-genesis" ? CRYPTOKITTIES_GENESIS_BLOCK : fromBlock,
    nextBlock,
    targetBlock: height,
    observedHead: height,
    state: nextBlock >= height ? (mode === "forward-from-genesis" ? "complete" : "live") : "backfilling",
  });
  return { chainSlug, fromBlock, toBlock: lastSucceededBlock, logsScanned: totalLogs, fillsWritten: totalWritten };
}
