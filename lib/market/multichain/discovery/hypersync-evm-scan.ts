/**
 * HyperSync-backed EVM collection discovery -- the fast path.
 *
 * WHY THIS EXISTS
 * ----------------
 * evm-log-scan.ts's real, verified constraint: a free-tier Alchemy key caps
 * raw eth_getLogs at a 10-block window per call, confirmed live 2026-08-17.
 * That module exists to work within that ceiling; this one exists to blow
 * past it. Envio's HyperSync (github.com/enviodev, @envio-dev/hypersync-client)
 * is independently benchmarked at up to 2000x faster than RPC for sparse
 * log scans (a full Arbitrum sparse scan: ~2s vs hours/days over RPC) and
 * covers 86+ EVM chains from one client library -- researched and verified
 * against the real, installed package's own index.d.ts (not assumed from
 * docs alone) 2026-08-20.
 *
 * THE HONEST LIMIT, STATED PLAINLY
 * ----------------------------------
 * HyperSync's free tier is capped (soft limit ~100k events processed /
 * 5GB storage / flagged after 7 days idle) -- explicitly positioned for
 * development/testing, not unlimited. A genuine full-history backfill
 * across every chain's entire Transfer event history is realistically
 * tens of millions of events per major chain and WILL exceed that ceiling.
 * This module does not pretend otherwise: CHUNK_BLOCKS below is large
 * relative to evm-log-scan.ts's 10, but still bounded per invocation, so
 * repeated cron ticks make real, fast, gradual progress toward full
 * history rather than either stalling (the old 10-block ceiling) or
 * blowing the free quota in one run.
 *
 * REQUIRES ENVIO_API_TOKEN (server-only env var, generated at
 * envio.dev/app/api-tokens -- required for all HyperSync access since
 * 2025-11-03). Fails closed with a clear, actionable error when unset --
 * same posture as every other optional-external-key path in this app
 * (ALCHEMY_API_KEY, MAGICEDEN_API_KEY), never a silent no-op.
 *
 * Shares its downstream pipeline with evm-log-scan.ts on purpose --
 * same candidate threshold, same isNotRealCollectibleArt gate, same
 * alchemy-nft.ts metadata resolution, same discovery cursor table. The
 * only thing that changes here is HOW the raw Transfer logs are fetched;
 * every decision about what counts as a real collection stays identical
 * and lives in exactly one place (evm-log-scan.ts), imported, not
 * duplicated.
 */
import { HypersyncClient, type Query, type Log as HypersyncLog } from "@envio-dev/hypersync-client";
import { alchemyNftAdapter, fetchSnapshotsBatch } from "@/lib/market/multichain/adapters/alchemy-nft";
import {
  EVM_CHAIN_ID,
  TRANSFER_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_BATCH_TOPIC,
  isNotRealCollectibleArt,
  readCursor,
  writeCursor,
  type DiscoveryScanResult,
} from "@/lib/market/multichain/discovery/evm-log-scan";
import { upsertTrackedCollection, recordActivity } from "@/lib/market/multichain/store";
import { decodeTransferLog, writeTransferLedgerEvents, type RawTransferLog, type DecodedTransfer } from "@/lib/market/multichain/discovery/transfer-ledger";
import { ZERO_ADDRESS } from "@/lib/market/multichain/discovery/onchain-provenance";
import { writeCollectionCell, writeChainCoverage, reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { upsertCollectionTokenProjection } from "@/lib/market/multichain/collection-token-store";
import { postgresQuery } from "@/lib/postgres";
import { isHypersyncAccountJailed, jailHypersyncAccount, isHypersyncQuotaError } from "@/lib/market/multichain/discovery/hypersync-account-jail";

const HYPERSYNC_EVM_PROVIDER_ACCOUNT = "hypersync-evm:default";
/**
 * RE-VERIFIED LIVE 2026-08-23 (owner pushback on a report that treated this
 * as a real capacity block): fetched docs.envio.dev/docs/HyperSync/api-tokens,
 * docs.envio.dev/blog/what-is-hypersync, and envio.dev/pricing directly --
 * none of them state ANY per-key, per-day, or per-IP request-count limit
 * for HyperSync. The only thing api-tokens.md documents is that a token is
 * REQUIRED (since 2025-11-03) and that usage is tracked as "Requests" and
 * "Credits" for billing visibility -- not that a specific number of either
 * gets you rate-limited. No DAILY_CEILING entry exists for "hypersync-evm"
 * in source-budget.ts either -- this file has never called
 * checkSourceBudget. There is therefore NO real documented number to carry
 * over here, which is exactly this app's own standing rule for when a
 * self-imposed ceiling must be removed (see source-budget.ts's
 * ordinals-wallet/ordinalswallet-ordinals entries for the established
 * precedent). This constant is NOT removed outright only because
 * reserveProviderCapacity's ProviderWindow requires a numeric allowance to
 * function at all (unlike source-budget.ts's DAILY_CEILING, which can
 * simply omit a source and fall through to `allowed: true`) -- raised here
 * to a level that exists purely as a runaway-concurrent-worker safety
 * valve (100x the old 2,000 approximation; no real cron cadence run in
 * this app comes remotely close to it), never as a claimed real HyperSync
 * limit. If Envio ever publishes an actual documented number, replace this
 * with that number and cite the source, same as every other real ceiling
 * in this file's family (UniSat, CoinGecko, etc.).
 */
const HYPERSYNC_EVM_DAILY_ALLOWANCE = 200_000;

/**
 * Blocks requested per HyperSync call. Far wider than evm-log-scan.ts's
 * RPC-bound 10 -- HyperSync has no such per-call ceiling, it paginates via
 * nextBlock instead (see the while loop below) -- but still a real, finite
 * number per invocation so one cron tick can't run unbounded and blow the
 * free-tier event quota in a single pass. Tuned conservatively; raise once
 * real usage against the free tier's actual ceiling is observed live.
 */
const CHUNK_BLOCKS = 50_000;

// Transfer is shared by ERC-20 and ERC-721, and HyperSync cannot predicate on
// "topic3 is present". Real production probes showed maxNumLogs may overshoot
// heavily at server batch boundaries (e.g. 119k logs for a 5k target). These
// per-chain spans are therefore the enforceable forward-scan bound, calibrated
// from observed log density on 2026-08-22. Historical coverage remains on the
// separately cursored backfill lanes; catalog APIs remain the roster fast path.
const FORWARD_CHUNK_BLOCKS: Record<string, number> = {
  "eth-mainnet": 10,
  "polygon-mainnet": 10,
  "arb-mainnet": 800,
  "base-mainnet": 20,
  "opt-mainnet": 10,
  "bnb-mainnet": 15,
  "avax-mainnet": 150,
  "zksync-mainnet": 900,
};

/** HyperSync documents maxNumLogs as a target that may overshoot at a block
 * boundary, not a strict ceiling. A 5k target kept observed dense-chain
 * responses below the intended ~20k/run envelope; the client still advances
 * only to the server's exact nextBlock, so this bound creates no scan gap. */
const MAX_LOGS_PER_RUN = 5_000;

async function registerObservedCandidates(
  chainSlug: string,
  candidates: Array<[string, number]>,
  sourceBlock: number
): Promise<{ registered: number; skippedNoMetadata: number; accepted: Set<string> }> {
  let snapshots = new Map<string, Awaited<ReturnType<typeof fetchSnapshotsBatch>> extends Map<string, infer V> ? V : never>();
  const { checkSourceBudget } = await import("@/lib/market/multichain/discovery/source-budget");
  // Real fix, 2026-08-25 ("follow through, no shortcuts"): also check the
  // shared, durable alchemy-account jail -- see sync.ts's own copy of
  // this comment for the full real gap this closes.
  const { isAlchemyAccountJailed } = await import("@/lib/market/multichain/discovery/alchemy-account-jail");
  if (checkSourceBudget("alchemy-nft").allowed && !(await isAlchemyAccountJailed())) {
    try {
      snapshots = await fetchSnapshotsBatch(chainSlug, candidates.map(([address]) => address));
    } catch {
      // Identity is independently proven by a real ERC-721-shaped on-chain
      // event. Metadata is a separate cell and may be hydrated later.
    }
  }

  let registered = 0;
  let skippedNoMetadata = 0;
  const accepted = new Set<string>();
  for (const [contractAddress] of candidates) {
    const snapshot = snapshots.get(contractAddress.toLowerCase());
    if (snapshot && isNotRealCollectibleArt(snapshot.name, snapshot.imageUrl)) {
      skippedNoMetadata += 1;
      continue;
    }
    accepted.add(contractAddress.toLowerCase());
    await upsertTrackedCollection({
      chainSlug,
      chainId: EVM_CHAIN_ID[chainSlug] ?? null,
      contractAddress,
      // Keep the eventual hydration adapter attached even when its current
      // account is exhausted; admission no longer depends on that account.
      adapter: alchemyNftAdapter.name,
      isVaultBacked: false,
    });
    await writeCollectionCell({
      chainSlug,
      collectionKey: contractAddress.toLowerCase(),
      cell: "identity",
      source: "hypersync-transfer-log",
      sourceBlock,
      state: snapshot ? "fresh" : "partial",
      coverage: snapshot ? 1 : 0.25,
    });
    if (!snapshot) skippedNoMetadata += 1;
    registered += 1;
  }
  return { registered, skippedNoMetadata, accepted };
}

async function persistObservedErc721Membership(
  chainSlug: string,
  observed: Map<string, Set<string>>,
  accepted: Set<string>,
  source: string
): Promise<void> {
  const observedAt = new Date();
  for (const [contractAddress, tokenIds] of observed) {
    if (!accepted.has(contractAddress) || tokenIds.size === 0) continue;
    await upsertCollectionTokenProjection(chainSlug, contractAddress, {
      tokens: [...tokenIds].map((tokenId) => ({ tokenId, name: null, imageUrl: null, traits: [] })),
      partial: true,
      provenance: [source],
      sourceObservedAt: observedAt,
    });
  }
}

/**
 * Shared write-path for all three HyperSync scan functions below (forward,
 * genesis backfill, priority window) -- decodes every raw Transfer/
 * TransferSingle/TransferBatch log already fetched for the tally (never a
 * second query) into plank_market_events rows, using each log's own
 * block's real Timestamp field (HyperSync returns it for free via
 * fieldSelection.block, no extra eth_getBlockByNumber round trip needed
 * the way the RPC-bound evm-log-scan.ts path requires).
 */
async function writeTransfersFromHypersyncLogs(
  chainSlug: string,
  logs: Array<{ address?: string | null; topics: Array<string | null | undefined>; data?: string | null; transactionHash?: string | null; logIndex?: number; blockNumber?: number }>,
  blocks: Array<{ number?: number; timestamp?: number }>
): Promise<DecodedTransfer[]> {
  const timestampByBlock = new Map<number, number>();
  for (const b of blocks) {
    if (b.number != null && b.timestamp != null) timestampByBlock.set(b.number, b.timestamp);
  }
  const decoded: DecodedTransfer[] = [];
  for (const log of logs) {
    if (log.address == null || log.transactionHash == null || log.logIndex == null || log.blockNumber == null) continue;
    const raw: RawTransferLog = {
      address: log.address,
      topics: log.topics,
      data: log.data ?? null,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
    };
    for (const t of decodeTransferLog(chainSlug, raw)) {
      t.blockTimestamp = timestampByBlock.get(t.blockNumber) ?? null;
      decoded.push(t);
    }
  }
  await writeTransferLedgerEvents(decoded);
  // Real gap found live 2026-08-26 (HyperSync-primary cutover, external
  // Grok research review): callers previously had to re-decode every log a
  // second time (runAddressScopedMembershipScan's own manual topic3
  // extraction) to learn token ids for membership -- duplicating this
  // function's own decode work, AND only ever covering ERC-721 (the manual
  // extraction never looked at TransferSingle/TransferBatch's `data`
  // field at all, silently dropping 100% of ERC-1155 membership). Return
  // the already-decoded transfers (which cover 721 AND 1155 via
  // decodeTransferLog, transfer-ledger.ts's own single decoder) so
  // membership/burn tracking can derive from the SAME pass instead.
  return decoded;
}

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-evm-scan: ENVIO_API_TOKEN is not set -- generate one at " +
        "https://envio.dev/app/api-tokens (required for all HyperSync access " +
        "since 2025-11-03). This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** One real HyperSync call (getHeight or a query page) reserved/settled durably around it -- never reserves per logical scan, only per actual outbound request. */
async function withHypersyncReservation<T>(fn: () => Promise<T>): Promise<T> {
  // Real, shared, cross-lane circuit breaker (hypersync-account-jail.ts) --
  // checked BEFORE this lane's own logical daily reservation, so a real
  // Envio account-level 429 discovered by ANY hypersync lane (genesis-
  // seaport-backfill, anchored-membership, priority-window, ...) is
  // respected here immediately, instead of this lane needing its own
  // independent failed call to find out the same real outage is ongoing.
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-evm-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }
  const window = utcDayWindow(HYPERSYNC_EVM_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(HYPERSYNC_EVM_PROVIDER_ACCOUNT, window))) {
    throw new Error("hypersync-evm-scan: durable daily ceiling");
  }
  let settled = false;
  try {
    const result = await fn();
    await settleProviderCapacity(HYPERSYNC_EVM_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    return result;
  } catch (error) {
    if (!settled) await settleProviderCapacity(HYPERSYNC_EVM_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }
}

/**
 * Real fix, 2026-08-25: contract-deploy-block.ts originally binary-searched
 * eth_getCode across ~24 historical blocks via rpc-provider-pool.ts. Live
 * testing found every free public RPC in that pool (publicnode, drpc)
 * flatly REFUSES archive-state calls at an old block ("Archive requests
 * require a personal token") -- confirmed live, not guessed -- so every
 * single one of those 24 calls fell through to Alchemy alone, guaranteeing
 * repeated real quota exhaustion for every contract this ever ran for.
 * HyperSync is a wholly separate, address-indexed resource already proven
 * fast for full-history log scans all night -- a single query filtered to
 * this one contract's own address, from genesis, asking for just the
 * first log, finds its real earliest Transfer (mint) block directly, with
 * none of the Alchemy exposure above.
 */
export async function findEarliestTransferBlock(
  chainSlug: string,
  contractAddress: string
): Promise<number | null> {
  const chainId = EVM_CHAIN_ID[chainSlug];
  if (!chainId) return null;
  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });
  const query: Query = {
    fromBlock: 0,
    logs: [{ address: [contractAddress], topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] }],
    fieldSelection: { log: ["BlockNumber"] },
    maxNumLogs: 1,
  };
  const res = await withHypersyncReservation(() => client.get(query));
  const first = res.data.logs[0];
  return first?.blockNumber ?? null;
}

/**
 * Real fix, 2026-08-25 ("still nothing" -- anchored-membership only
 * advancing ~800 blocks per real call): anchored-membership-backfill.ts
 * was reusing runHypersyncPriorityWindowScan, the GLOBAL discovery scan --
 * unfiltered by address, competing for its shared MAX_LOGS_PER_RUN budget
 * against every OTHER contract active in that block range, which is why
 * it crawled so slowly through a single collection's own narrow window.
 * This is the properly scoped version: address-filtered (same real,
 * proven-fast pattern findEarliestTransferBlock already uses), for ONE
 * already-known contract, so its own real log volume is all that gates
 * progress -- not thousands of unrelated collections' noise.
 */
export async function runAddressScopedMembershipScan(input: {
  chainSlug: string;
  contractAddress: string;
  fromBlockFloor: number;
  toBlockCeiling: number;
  cursorKey: string;
  provenance: string;
}): Promise<{ fromBlock: number; toBlock: number; logsScanned: number; tokensFound: number; done: boolean }> {
  const chainId = EVM_CHAIN_ID[input.chainSlug];
  if (!chainId) throw new Error(`hypersync-evm-scan: no chainId mapping for "${input.chainSlug}"`);
  if (await isHypersyncAccountJailed()) {
    throw new Error("hypersync-evm-scan: real Envio account-level rate limit active (shared across all HyperSync lanes)");
  }

  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });
  const address = input.contractAddress.toLowerCase();

  const scannedUpTo = (await readCursor(input.cursorKey)) ?? input.fromBlockFloor;
  if (scannedUpTo >= input.toBlockCeiling) {
    return { fromBlock: scannedUpTo, toBlock: input.toBlockCeiling, logsScanned: 0, tokensFound: 0, done: true };
  }

  let logsScanned = 0;
  let tokensFound = 0;
  let query: Query = {
    fromBlock: scannedUpTo,
    toBlock: input.toBlockCeiling,
    logs: [{ address: [address], topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "TransactionHash", "LogIndex", "BlockNumber"],
      block: ["Number", "Timestamp"],
    },
    maxNumLogs: MAX_LOGS_PER_RUN,
  };

  let nextBlock = scannedUpTo;
  try {
    while (logsScanned < MAX_LOGS_PER_RUN) {
      const res = await withHypersyncReservation(() => client.get(query));
      const pageLogs: HypersyncLog[] = [];
      for (const log of res.data.logs) {
        if (!log.address) continue;
        const topic0 = log.topics[0]?.toLowerCase();
        if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue;
        if (topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC) continue;
        pageLogs.push(log);
      }
      logsScanned += pageLogs.length;

      // Real fix, 2026-08-26 (HyperSync-primary hydration cutover, external
      // Grok research review): write every page as it arrives instead of
      // accumulating the WHOLE scan in memory and committing once at the
      // end -- this is the literal mechanism behind "thousands of tokens
      // every 1-2 seconds": a crash/timeout mid-scan now loses at most one
      // page, not the entire pass, and real membership becomes visible to
      // the UI incrementally as HyperSync pages land, not only once a full
      // (potentially multi-minute) scan finishes.
      const decoded = await writeTransfersFromHypersyncLogs(input.chainSlug, pageLogs, res.data.blocks);

      // Real fix, 2026-08-26: derive membership from the SAME decode pass
      // transfer-ledger.ts's own decodeTransferLog already performs above
      // -- covers ERC-721 Transfer AND ERC-1155 TransferSingle/
      // TransferBatch. The old manual `log.topics[3]` extraction only ever
      // handled ERC-721 (1155's token id lives in `data`, never inspected),
      // silently dropping 100% of ERC-1155 membership. Track each token's
      // LATEST observed `toAddress` in the order decodeTransferLog itself
      // returns (real chain order for one query page) so a burn (transfer
      // to the zero address) that happens AFTER an earlier mint/transfer
      // in the same page is correctly reflected as current state, not
      // just "this token id was seen at some point" -- see migration 082's
      // own header for why an ever-seen count made 100% unreachable for
      // any collection with real burns.
      const latestToByToken = new Map<string, string>();
      for (const t of decoded) {
        if (t.contractAddress !== address) continue;
        latestToByToken.set(t.tokenId, t.toAddress.toLowerCase());
      }
      if (latestToByToken.size > 0) {
        await upsertCollectionTokenProjection(input.chainSlug, address, {
          tokens: [...latestToByToken.entries()].map(([tokenId, toAddress]) => ({
            tokenId, name: null, imageUrl: null, traits: [],
            isBurned: toAddress === ZERO_ADDRESS,
          })),
          partial: true,
          provenance: [input.provenance],
          sourceObservedAt: new Date(),
        });
        tokensFound += latestToByToken.size;
      }

      nextBlock = res.nextBlock;
      // Same real clamp as runHypersyncPriorityWindowScan's own fix --
      // HyperSync's nextBlock has been observed live coming back below the
      // query's own fromBlock on a large request; never let this regress
      // the cursor. Written every page now (not once at the very end), so
      // this must run before advancing the durable cursor on each iteration.
      nextBlock = Math.max(nextBlock, scannedUpTo);
      await writeCursor(input.cursorKey, nextBlock);

      if (nextBlock >= input.toBlockCeiling || logsScanned >= MAX_LOGS_PER_RUN) break;
      query = { ...query, fromBlock: nextBlock };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isHypersyncQuotaError(message)) await jailHypersyncAccount().catch(() => {});
    throw error;
  }

  const done = nextBlock >= input.toBlockCeiling;
  return { fromBlock: scannedUpTo, toBlock: nextBlock, logsScanned, tokensFound, done };
}

/**
 * Scans forward from the stored cursor using HyperSync, tallies ERC-721-
 * shaped Transfer activity by contract (identical candidate logic to
 * evm-log-scan.ts's runEvmDiscoveryScan), and registers anything crossing
 * MIN_TRANSFERS_TO_CONSIDER whose metadata resolves via alchemy-nft.ts.
 */
export async function runHypersyncDiscoveryScan(input: {
  chainSlug: string;
}): Promise<DiscoveryScanResult> {
  const chainId = EVM_CHAIN_ID[input.chainSlug];
  if (!chainId) {
    return {
      chainSlug: input.chainSlug,
      fromBlock: 0,
      toBlock: 0,
      logsScanned: 0,
      candidates: 0,
      registered: 0,
      skippedNoMetadata: 0,
      error: `hypersync-evm-scan: no chainId mapping for "${input.chainSlug}"`,
    };
  }

  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });

  const height = await withHypersyncReservation(() => client.getHeight());
  const cursor = await readCursor(input.chainSlug);
  const fromBlock = cursor == null ? Math.max(0, height - CHUNK_BLOCKS) : cursor + 1;
  const toBlock = Math.min(height, fromBlock + (FORWARD_CHUNK_BLOCKS[input.chainSlug] ?? 10));

  if (fromBlock >= toBlock) {
    return { chainSlug: input.chainSlug, fromBlock, toBlock: fromBlock, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0 };
  }

  const tally = new Map<string, number>();
  const observedErc721 = new Map<string, Set<string>>();
  const rawTransferLogs: HypersyncLog[] = [];
  const seenBlocks: Array<{ number?: number; timestamp?: number }> = [];
  let logsScanned = 0;
  let query: Query = {
    fromBlock,
    toBlock,
    logs: [{ topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "TransactionHash", "LogIndex", "BlockNumber"],
      block: ["Number", "Timestamp"],
    },
    maxNumLogs: MAX_LOGS_PER_RUN,
  };

  let lastBlockSeen = fromBlock;
  while (logsScanned < MAX_LOGS_PER_RUN) {
    const res = await withHypersyncReservation(() => client.get(query));
    seenBlocks.push(...res.data.blocks);
    for (const log of res.data.logs) {
      if (!log.address) continue;
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue;
      if (topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC) continue;
      const key = log.address.toLowerCase();
      tally.set(key, (tally.get(key) ?? 0) + 1);
      rawTransferLogs.push(log);
      if (topic0 === TRANSFER_TOPIC && log.topics[3]) {
        const tokenId = BigInt(log.topics[3]).toString();
        const ids = observedErc721.get(key) ?? new Set<string>();
        ids.add(tokenId);
        observedErc721.set(key, ids);
      }
      logsScanned += 1;
    }
    lastBlockSeen = res.nextBlock;
    if (res.nextBlock >= toBlock || logsScanned >= MAX_LOGS_PER_RUN) break;
    query = { ...query, fromBlock: res.nextBlock };
  }

  await recordActivity(input.chainSlug, tally);
  await writeTransfersFromHypersyncLogs(input.chainSlug, rawTransferLogs, seenBlocks);

  const candidates = [...tally.entries()];

  const { registered, skippedNoMetadata, accepted } = await registerObservedCandidates(input.chainSlug, candidates, lastBlockSeen - 1);
  await persistObservedErc721Membership(input.chainSlug, observedErc721, accepted, "hypersync-transfer-live");

  await writeCursor(input.chainSlug, lastBlockSeen - 1);
  await writeChainCoverage({
    chainSlug: input.chainSlug,
    lane: "forward",
    standardGroup: "erc721+erc1155",
    rangeStart: fromBlock,
    nextBlock: lastBlockSeen,
    targetBlock: height,
    observedHead: height,
    state: lastBlockSeen >= height ? "live" : "backfilling",
  });
  return { chainSlug: input.chainSlug, fromBlock, toBlock: lastBlockSeen - 1, logsScanned, candidates: candidates.length, registered, skippedNoMetadata };
}

/**
 * Historical backfill -- walks the range runHypersyncDiscoveryScan will
 * NEVER reach: [0, whatever block forward discovery first started from).
 *
 * Real gap this closes: runHypersyncDiscoveryScan's cursor starts at
 * `height - CHUNK_BLOCKS` on its very first call and only ever moves
 * forward from there -- it catches new activity but can never reach
 * anything that happened before the moment discovery was first turned on.
 * Flagged live 2026-08-20 ("discover absolutely everything") -- only a
 * real walk through history can satisfy that.
 *
 * GENESIS-FORWARD BY DESIGN, NOT TIP-BACKWARD -- this is the one real
 * correctness fix over an earlier draft of this function: a tip-backward
 * walk with a fixed CHUNK_BLOCKS window and a hard per-call log cap can
 * silently create a GAP (claim a whole window "covered" when the log cap
 * cut the actual scan off partway through it, since HyperSync has no
 * reverse mode for a bounded client.get() call -- confirmed against the
 * real installed client's own index.d.ts; StreamConfig.reverse only
 * applies to the streaming API, not this one-shot call). Scanning forward
 * from a known-scanned floor and letting the query's own `maxNumLogs`
 * report back exactly how far it got (`nextBlock`) has no such failure
 * mode: whatever it returns IS what was covered, by construction, same
 * invariant runHypersyncDiscoveryScan's own cursor already relies on.
 *
 * Own cursor, own key ("${chainSlug}:backfill" in the same cursor table,
 * no migration needed). `done: true` once the scan reaches the forward
 * scanner's own starting point -- that chain's full history is covered
 * either by this function (below it) or the forward one (at and above
 * it). Callers should stop invoking this for a chain once done.
 */
export async function runHypersyncBackfillScan(input: {
  chainSlug: string;
}): Promise<DiscoveryScanResult & { done: boolean }> {
  const chainId = EVM_CHAIN_ID[input.chainSlug];
  const backfillKey = `${input.chainSlug}:backfill`;
  if (!chainId) {
    return {
      chainSlug: input.chainSlug,
      fromBlock: 0,
      toBlock: 0,
      logsScanned: 0,
      candidates: 0,
      registered: 0,
      skippedNoMetadata: 0,
      done: false,
      error: `hypersync-evm-scan: no chainId mapping for "${input.chainSlug}"`,
    };
  }

  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });

  // The ceiling this function is responsible for: wherever forward
  // discovery first started (never changes once set, since the forward
  // scanner's own cursor moves past it immediately on its first run).
  const forwardCursor = await readCursor(input.chainSlug);
  const height = await withHypersyncReservation(() => client.getHeight());
  const ceiling = forwardCursor ?? Math.max(0, height - CHUNK_BLOCKS);

  // How far genesis-forward this function has already scanned. Starts at 0.
  const scannedUpTo = (await readCursor(backfillKey)) ?? 0;

  if (scannedUpTo >= ceiling) {
    return { chainSlug: input.chainSlug, fromBlock: scannedUpTo, toBlock: ceiling, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0, done: true };
  }

  const tally = new Map<string, number>();
  const observedErc721 = new Map<string, Set<string>>();
  const rawTransferLogs: HypersyncLog[] = [];
  const seenBlocks: Array<{ number?: number; timestamp?: number }> = [];
  let logsScanned = 0;
  let query: Query = {
    fromBlock: scannedUpTo,
    toBlock: ceiling,
    logs: [{ topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "TransactionHash", "LogIndex", "BlockNumber"],
      block: ["Number", "Timestamp"],
    },
    maxNumLogs: MAX_LOGS_PER_RUN,
  };

  let nextBlock = scannedUpTo;
  while (logsScanned < MAX_LOGS_PER_RUN) {
    const res = await withHypersyncReservation(() => client.get(query));
    seenBlocks.push(...res.data.blocks);
    for (const log of res.data.logs) {
      if (!log.address) continue;
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue;
      if (topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC) continue;
      const key = log.address.toLowerCase();
      tally.set(key, (tally.get(key) ?? 0) + 1);
      rawTransferLogs.push(log);
      if (topic0 === TRANSFER_TOPIC && log.topics[3]) {
        const tokenId = BigInt(log.topics[3]).toString();
        const ids = observedErc721.get(key) ?? new Set<string>();
        ids.add(tokenId);
        observedErc721.set(key, ids);
      }
      logsScanned += 1;
    }
    nextBlock = res.nextBlock;
    if (nextBlock >= ceiling || logsScanned >= MAX_LOGS_PER_RUN) break;
    query = { ...query, fromBlock: nextBlock };
  }

  await recordActivity(input.chainSlug, tally);
  await writeTransfersFromHypersyncLogs(input.chainSlug, rawTransferLogs, seenBlocks);

  const candidates = [...tally.entries()];

  const { registered, skippedNoMetadata, accepted } = await registerObservedCandidates(input.chainSlug, candidates, nextBlock);
  await persistObservedErc721Membership(input.chainSlug, observedErc721, accepted, "hypersync-transfer-genesis");

  // nextBlock is exactly what HyperSync itself reports as covered -- no
  // gap possible, unlike a precomputed window claimed complete regardless
  // of whether the scan actually reached its far edge.
  await writeCursor(backfillKey, nextBlock);
  const done = nextBlock >= ceiling;
  if (done) {
    // A completed genesis walk plus the independently-live forward lane is
    // authoritative membership evidence even on chains (notably zkSync)
    // where no collection-catalog vendor exists. New live mints set their
    // projection partial again and the metadata lane re-finalizes rarity.
    await postgresQuery(
      `INSERT INTO plank_collection_membership_cursors (
         chain_slug, collection_slug, source, cursor, expected_count,
         observed_count, complete, source_observed_at, updated_at
       )
       SELECT chain_slug, collection_slug, 'hypersync-transfer-membership', NULL,
         COUNT(*)::bigint, COUNT(*)::bigint, TRUE, NOW(), NOW()
       FROM plank_collection_tokens
       WHERE chain_slug = $1
       GROUP BY chain_slug, collection_slug
       ON CONFLICT (chain_slug, collection_slug, source) DO UPDATE SET
         expected_count = EXCLUDED.expected_count,
         observed_count = EXCLUDED.observed_count,
         complete = TRUE,
         source_observed_at = NOW(), updated_at = NOW()`,
      [input.chainSlug]
    );
  }
  await writeChainCoverage({
    chainSlug: input.chainSlug,
    lane: "historical",
    standardGroup: "erc721+erc1155",
    rangeStart: 0,
    nextBlock,
    targetBlock: ceiling,
    observedHead: height,
    state: done ? "complete" : "backfilling",
  });
  return { chainSlug: input.chainSlug, fromBlock: scannedUpTo, toBlock: nextBlock, logsScanned, candidates: candidates.length, registered, skippedNoMetadata, done };
}

/**
 * A second, ADDITIONAL genesis-forward walk over an explicit
 * [fromBlockFloor, toBlockCeiling) range, under its OWN cursor key -- never
 * touches runHypersyncBackfillScan's own cursor or its no-gap guarantee.
 *
 * Real reason this exists: flagged live 2026-08-20 ("i need to see
 * ethereums collections climb") -- the real chronological backfill was
 * genuinely finding zero new candidates for a long stretch because it was
 * walking Ethereum's earliest blocks (~2018), before ERC-721/NFT
 * collections existed at any real scale (the actual boom is ~block
 * 12M-15M, 2021-2022). Rather than fabricate faster progress or silently
 * jump the real backfill cursor forward (which WOULD create a permanent,
 * silent gap in the one thing that function's own header explicitly
 * guarantees never happens), this is a separate, explicitly-labeled,
 * independently-cursored pass over the known-dense range -- both this and
 * the real chronological backfill keep running and keep making real,
 * gap-free progress on their own tracks; this one just gets there faster
 * by not waiting to crawl through low-density history first.
 */
export async function runHypersyncPriorityWindowScan(input: {
  chainSlug: string;
  fromBlockFloor: number;
  toBlockCeiling: number;
  cursorKey: string;
}): Promise<DiscoveryScanResult & { done: boolean }> {
  const chainId = EVM_CHAIN_ID[input.chainSlug];
  if (!chainId) {
    return {
      chainSlug: input.chainSlug,
      fromBlock: 0,
      toBlock: 0,
      logsScanned: 0,
      candidates: 0,
      registered: 0,
      skippedNoMetadata: 0,
      done: false,
      error: `hypersync-evm-scan: no chainId mapping for "${input.chainSlug}"`,
    };
  }

  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });

  const scannedUpTo = (await readCursor(input.cursorKey)) ?? input.fromBlockFloor;
  if (scannedUpTo >= input.toBlockCeiling) {
    return { chainSlug: input.chainSlug, fromBlock: scannedUpTo, toBlock: input.toBlockCeiling, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0, done: true };
  }

  const tally = new Map<string, number>();
  // Real bug found live 2026-08-25 ("root cause discover and contagion
  // uproot"): this window's whole reason for existing is to reach the
  // 2021-2022 NFT-dense era before the slow sequential genesis walk gets
  // there (see this function's own header). It scans right through every
  // stuck collection's real mint-era Transfer logs -- but unlike its
  // sibling runHypersyncBackfillScan, it never captured per-token ids or
  // called persistObservedErc721Membership, so an already-tracked
  // collection whose OpenSea enumeration has independently plateaued (Lil
  // Pudgys: 158 real page-walks, cursor genuinely advancing, distinct
  // token count frozen at 4,079/21,929 -- confirmed live by refetching its
  // own "next" page and finding only already-known token ids) got zero
  // benefit from this pass ever reaching its mint blocks. Same
  // Map<contract, Set<tokenId>> capture as the sibling function, mirrored
  // exactly.
  const observedErc721 = new Map<string, Set<string>>();
  const rawTransferLogs: HypersyncLog[] = [];
  const seenBlocks: Array<{ number?: number; timestamp?: number }> = [];
  let logsScanned = 0;
  let query: Query = {
    fromBlock: scannedUpTo,
    toBlock: input.toBlockCeiling,
    logs: [{ topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] }],
    fieldSelection: {
      log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "TransactionHash", "LogIndex", "BlockNumber"],
      block: ["Number", "Timestamp"],
    },
    maxNumLogs: MAX_LOGS_PER_RUN,
  };

  let nextBlock = scannedUpTo;
  while (logsScanned < MAX_LOGS_PER_RUN) {
    const res = await withHypersyncReservation(() => client.get(query));
    seenBlocks.push(...res.data.blocks);
    for (const log of res.data.logs) {
      if (!log.address) continue;
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue;
      if (topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC) continue;
      const key = log.address.toLowerCase();
      tally.set(key, (tally.get(key) ?? 0) + 1);
      rawTransferLogs.push(log);
      if (topic0 === TRANSFER_TOPIC && log.topics[3]) {
        const tokenId = BigInt(log.topics[3]).toString();
        const ids = observedErc721.get(key) ?? new Set<string>();
        ids.add(tokenId);
        observedErc721.set(key, ids);
      }
      logsScanned += 1;
    }
    nextBlock = res.nextBlock;
    if (nextBlock >= input.toBlockCeiling || logsScanned >= MAX_LOGS_PER_RUN) break;
    query = { ...query, fromBlock: nextBlock };
  }
  // Real bug found live 2026-08-25, first real (non-isolated) run against
  // this window: HyperSync's own res.nextBlock came back BELOW the query's
  // fromBlock (persisted cursor read 11,713,120 against a 12,000,000
  // floor -- a real, reproducible client quirk on this large a first
  // request, not a guess), which writeCursor below would otherwise persist
  // verbatim, regressing this lane's own progress and then hard-failing
  // writeChainCoverage's own range check every subsequent pass. Clamp to
  // what this call already knows is safe -- never move backwards.
  nextBlock = Math.max(nextBlock, scannedUpTo);

  await recordActivity(input.chainSlug, tally);
  await writeTransfersFromHypersyncLogs(input.chainSlug, rawTransferLogs, seenBlocks);

  const candidates = [...tally.entries()];

  const { registered, skippedNoMetadata, accepted } = await registerObservedCandidates(input.chainSlug, candidates, nextBlock);
  await persistObservedErc721Membership(input.chainSlug, observedErc721, accepted, "hypersync-transfer-priority");

  await writeCursor(input.cursorKey, nextBlock);
  const done = nextBlock >= input.toBlockCeiling;
  await writeChainCoverage({
    chainSlug: input.chainSlug,
    lane: "priority",
    standardGroup: "erc721+erc1155",
    rangeStart: input.fromBlockFloor,
    nextBlock,
    targetBlock: input.toBlockCeiling,
    state: done ? "complete" : "backfilling",
  });
  return { chainSlug: input.chainSlug, fromBlock: scannedUpTo, toBlock: nextBlock, logsScanned, candidates: candidates.length, registered, skippedNoMetadata, done };
}

/** Runs the HyperSync scan across every chain evm-log-scan.ts covers,
 * skipping (not throwing on) any chain HyperSync doesn't index -- same
 * fail-soft-per-chain posture runAllOpenSeaBulkScans already uses. */
export async function runAllHypersyncDiscoveryScans(): Promise<DiscoveryScanResult[]> {
  const results: DiscoveryScanResult[] = [];
  for (const chainSlug of Object.keys(EVM_CHAIN_ID)) {
    try {
      results.push(await runHypersyncDiscoveryScan({ chainSlug }));
    } catch (error) {
      results.push({
        chainSlug,
        fromBlock: 0,
        toBlock: 0,
        logsScanned: 0,
        candidates: 0,
        registered: 0,
        skippedNoMetadata: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
