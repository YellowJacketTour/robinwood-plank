/**
 * Permanent on-chain event indexer — the ledger's WRITER.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Nothing. It sits alongside the existing live-fetch code and *uses* it: the
 * ABI decoding, the Seaport OrderFulfilled price/attribution logic and the
 * transfer classification all still live in lib/market/activity.ts and
 * lib/market/vault-activity.ts. This module is the thing that calls them on a
 * schedule and writes the result down forever. The read path
 * (app/api/market/activity/route.ts) then serves from the ledger instead of
 * re-fetching a 40/800-event window per request.
 *
 * WHY POLLING, NOT A SUBSCRIPTION
 * -------------------------------
 * The app runs on InMotion under Passenger, which has no always-on process:
 * a websocket subscription or a provider webhook receiver would have nothing
 * to live in. Provider webhook services (Alchemy Webhooks, QuickNode Streams)
 * are also paid at any real volume. So the only recurring execution context
 * available is the existing 2-minute cron (scripts/refresh-market-data.ts).
 * That is a constraint, not a shortcut — and it is enough, because a stored
 * cursor makes polling resumable.
 *
 * BACKFILL == LIVE SYNC
 * ---------------------
 * There is no separate backfill script. Each tick reads the cursor, scans
 * forward in logScanBudget()-sized windows, writes rows, and advances the
 * cursor. On the very first tick the cursor is absent so it starts at
 * CHAIN_INDEX_GENESIS_BLOCK; by the time it catches up to the head, the exact
 * same code is doing live sync. One code path, two regimes.
 *
 * RESPECTING THE FREE-TIER RPC LIMITS
 * -----------------------------------
 * Every eth_getLogs here is (a) address-filtered to one contract and
 * (b) chunked by the existing logScanBudget() helper. Both matter. Wide
 * unfiltered queries on this chain return "logs matched by query exceeds limit
 * of 10000" — which is precisely why this indexer does NOT query Seaport's
 * OrderFulfilled globally: that event carries the collection only in its data
 * payload, never in an indexed topic, so it cannot be filtered server-side at
 * all. Sales are therefore discovered exactly the way the live feed already
 * discovers them — from the collection's own Transfer log, enriched per
 * transaction — and never from a global Seaport scan.
 */

import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES, SEAPORT_ADDRESS } from "@/lib/constants";
import { ethBlockNumberDisplay, ethGetLogsDisplay, rpcCall } from "@/lib/market/fetch-rpc";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import { logScanBudget } from "@/lib/market/rpc-budget";
import {
  TRANSFER_TOPIC,
  classifyTransfer,
  isMarketplankAttributed,
  readCachedSalePriceWei,
  resolveMarketplankAttribution,
  type ActivityEvent,
} from "@/lib/market/activity";
import { VAULT_TOPIC_SET, decodeVaultLog } from "@/lib/market/vault-activity";
import {
  appendChainEvents,
  activityEventToRow,
  hasChainEventStore,
  readChainCursor,
  vaultEventToRow,
  writeChainCursor,
  type ChainEventRow,
  type ChainEventSource,
} from "@/lib/market/chain-events";

/**
 * Read a non-negative integer override from the environment.
 *
 * Written out rather than inlined because the obvious one-liner is wrong in a
 * way that silently disables both constants below: `Number(env?.trim() || "")`
 * is `Number("")`, which is `0` — an integer, and non-negative, so a naive
 * validity check accepts it. That would have set the genesis block to 0 (a
 * ~17-million-block scan of empty history on every cold start) and, far worse,
 * the reorg confirmation depth to 0 (no reorg protection at all) on every
 * deployment that did not explicitly set these. Caught by the unit tests.
 */
function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * First block worth scanning: the block that CREATED the RobinWood collection
 * contract (0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156), verified from its
 * creation transaction
 * 0x072c01ae10e343bd2414d7e74a9ad3819b70dc31b052e0e4173cbc9360c62169 via
 * Blockscout on 2026-08-04. No log this ledger cares about can exist before
 * it — the collection did not exist, and every vault was deployed later still
 * (the current pool at block 25,375,216).
 *
 * Every vault therefore shares this floor rather than carrying a per-address
 * deploy block. Scanning an address-filtered range that predates a contract is
 * nearly free — eth_getLogs returns an empty array — and one documented
 * constant cannot go stale the way a hand-maintained per-vault table would.
 * Override with CHAIN_INDEX_GENESIS_BLOCK if the collection is ever redeployed.
 */
export const CHAIN_INDEX_GENESIS_BLOCK = numericEnv("CHAIN_INDEX_GENESIS_BLOCK", 17_048_370);

/**
 * How far behind the chain head the cursor is allowed to advance.
 *
 * A generic "12 blocks" would be almost meaningless here. Robinhood Chain is an
 * Arbitrum L2 producing roughly 10 blocks a second (head ~27.9M within about a
 * month of the July 2026 mainnet launch), so 12 blocks is barely one second of
 * finality — no protection at all against a reorg the app could actually
 * observe. 600 blocks is about a minute of chain, comfortably inside one
 * 2-minute cron interval, so holding it back costs at most one tick of latency
 * on the newest events while giving a reorg a realistic window to settle
 * before anything is written down permanently.
 *
 * The ledger is append-only, so this is the one line of defence that matters:
 * a row written for a block that later reorgs out would be wrong forever.
 */
export const CONFIRMATION_DEPTH_BLOCKS = numericEnv("CHAIN_INDEX_CONFIRMATION_DEPTH", 600);

/* --------------------------------------------------------------- *
 * Pure range math. No I/O — unit-tested in test/market/chain-indexer.test.ts *
 * --------------------------------------------------------------- */

/**
 * The highest block safe to write to an append-only ledger.
 *
 * Never negative: on a chain shallower than the confirmation depth (a fresh
 * local devnet) this returns -1, which nextScanRange reads as "nothing is
 * confirmed yet, do not scan".
 */
export function confirmedHead(head: number, depth = CONFIRMATION_DEPTH_BLOCKS): number {
  if (!Number.isFinite(head)) return -1;
  return Math.floor(head) - Math.max(0, Math.floor(depth));
}

export type ScanRange = { fromBlock: number; toBlock: number };

export type ScanPlan = {
  /** Windows to query, in ascending block order. Empty when nothing is due. */
  windows: ScanRange[];
  /** Cursor value to store if EVERY window succeeds. */
  targetCursor: number;
  /** True when this plan reaches the confirmed head (i.e. backfill is done). */
  caughtUp: boolean;
};

/**
 * Plan one tick's worth of scanning.
 *
 * This is the single place backfill and live-sync differ, and they differ only
 * in the value of `lastIndexedBlock`:
 *   - null/absent  → start at CHAIN_INDEX_GENESIS_BLOCK (first run ever)
 *   - far behind   → a full budget of windows (backfill, many ticks)
 *   - near head    → one small window (steady-state live sync)
 *
 * The window count and size come from logScanBudget(), never from a local
 * constant, so the free-tier RPC ceiling is respected in exactly one place.
 */
export function planScan(input: {
  lastIndexedBlock: number | null;
  head: number;
  genesisBlock?: number;
  confirmationDepth?: number;
  chunkBlocks: number;
  maxChunks: number;
}): ScanPlan {
  const genesis = input.genesisBlock ?? CHAIN_INDEX_GENESIS_BLOCK;
  const depth = input.confirmationDepth ?? CONFIRMATION_DEPTH_BLOCKS;
  const safeHead = confirmedHead(input.head, depth);

  const from =
    input.lastIndexedBlock == null || input.lastIndexedBlock < genesis
      ? genesis
      : input.lastIndexedBlock + 1;

  if (safeHead < from) {
    // Either the chain has not produced a confirmed block past the cursor yet,
    // or the only new blocks are still inside the confirmation depth. Both mean
    // "nothing to do", and both must leave the cursor exactly where it is.
    return { windows: [], targetCursor: input.lastIndexedBlock ?? genesis - 1, caughtUp: true };
  }

  const chunk = Math.max(1, Math.floor(input.chunkBlocks));
  const maxWindows = Math.max(1, Math.floor(input.maxChunks));

  const windows: ScanRange[] = [];
  let cursor = from;
  while (windows.length < maxWindows && cursor <= safeHead) {
    const toBlock = Math.min(safeHead, cursor + chunk - 1);
    windows.push({ fromBlock: cursor, toBlock });
    cursor = toBlock + 1;
  }

  const targetCursor = windows[windows.length - 1].toBlock;
  return { windows, targetCursor, caughtUp: targetCursor >= safeHead };
}

/* ---------------- *
 * Log fetching     *
 * ---------------- */

type RawLog = {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type IndexSourceResult = {
  source: ChainEventSource;
  contract: string;
  fromBlock: number;
  /** Cursor after this run. Unchanged from the input when a window failed. */
  toBlock: number;
  logsScanned: number;
  rowsInserted: number;
  caughtUp: boolean;
  /** Set when a window threw — the cursor stops before the failed window. */
  error: string | null;
};

async function readBlockTimestamps(blockNumbers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Bounded fan-out for the same reason the live feed bounds it: a backfill
  // window can contain hundreds of distinct blocks and the free endpoints
  // 429 under an unbounded burst.
  const slice = blockNumbers.slice(0, 120);
  const CONCURRENCY = 8;
  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    await Promise.all(
      slice.slice(i, i + CONCURRENCY).map(async (bn) => {
        try {
          const block = await rpcCall<{ timestamp?: string }>(
            "eth_getBlockByNumber",
            [bn, false],
            { timeoutMs: 6_000, urls: SERVER_DISPLAY_RPC_URLS }
          );
          if (block?.timestamp) {
            out.set(bn, new Date(Number(BigInt(block.timestamp)) * 1000).toISOString());
          }
        } catch {
          /* a missing timestamp stores as NULL rather than failing the row */
        }
      })
    );
  }
  return out;
}

/**
 * Turn the collection's raw Transfer logs into ledger rows.
 *
 * Deliberately reuses classifyTransfer (mint vs sale vs transfer vs vault
 * mechanic) and the Seaport OrderFulfilled decoding from lib/market/activity.ts
 * rather than restating either — those two carry hard-won corrections
 * (the vault deposit/redeem carve-out, the positive-orderHash-only
 * "marketplank" attribution rule) that a second implementation would lose.
 */
async function buildNftRows(logs: RawLog[]): Promise<ChainEventRow[]> {
  // ERC-721 Transfer indexes all three args; three topics means an ERC-20
  // Transfer sharing the same signature, which is not ours.
  const transfers = logs.filter((log) => log.topics.length === 4);
  if (transfers.length === 0) return [];

  const uniqueBlocks = [...new Set(transfers.map((l) => l.blockNumber))];

  // Only NON-MINT transfers need their transaction fetched. classifyTransfer
  // decides "mint" purely from `from == 0x0`, and a mint has no venue and no
  // buyer-paid price to recover — so enriching it would be a wasted round-trip.
  // This matters enormously during backfill: the collection's 1,542 mints
  // dominate its Transfer log, and skipping them is what keeps a full-budget
  // backfill window inside a sane RPC cost.
  const uniqueTxs = [
    ...new Set(
      transfers
        .filter((l) => BigInt(l.topics[1]) !== BigInt(0))
        .map((l) => l.transactionHash)
    ),
  ];

  const txInfo = new Map<string, { to: string | null; value: bigint } | null>();
  const CONCURRENCY = 8;
  /**
   * A ceiling, not a budget: a 50k-block window on this collection has never
   * come close to it. It exists only so a pathological window (an airdrop
   * script moving thousands of tokens in distinct transactions) cannot turn one
   * cron tick into an unbounded RPC storm. If it ever binds, the affected rows
   * are still WRITTEN — they just record `transfer` with no venue rather than a
   * priced sale, and re-indexing that range later cannot fix them, so treat a
   * run that hits this as a signal to shrink chunkBlocks rather than raise it.
   */
  const txSlice = uniqueTxs.slice(0, 2_000);
  for (let i = 0; i < txSlice.length; i += CONCURRENCY) {
    await Promise.all(
      txSlice.slice(i, i + CONCURRENCY).map(async (hash) => {
        try {
          const fetched = await rpcCall<{ to?: string; value?: string }>(
            "eth_getTransactionByHash",
            [hash],
            { timeoutMs: 6_000, urls: SERVER_DISPLAY_RPC_URLS }
          );
          txInfo.set(
            hash,
            fetched ? { to: fetched.to ?? null, value: BigInt(fetched.value || "0x0") } : null
          );
        } catch {
          txInfo.set(hash, null);
        }
      })
    );
  }

  const timestamps = await readBlockTimestamps(uniqueBlocks);

  // Only decode OrderFulfilled for transactions that really went through
  // Seaport — never a blanket scan, for the reason in this file's header.
  const seaportTxs = txSlice.filter(
    (hash) => txInfo.get(hash)?.to?.toLowerCase() === SEAPORT_ADDRESS.toLowerCase()
  );
  for (let i = 0; i < seaportTxs.length; i += CONCURRENCY) {
    await Promise.all(
      seaportTxs.slice(i, i + CONCURRENCY).map(async (hash) => {
        try {
          await resolveMarketplankAttribution(hash);
        } catch {
          /* unpriced/unattributed beats guessing */
        }
      })
    );
  }

  const rows: ChainEventRow[] = [];
  for (const log of transfers) {
    let from: string;
    let to: string;
    let tokenId: string;
    try {
      from = "0x" + log.topics[1].slice(26);
      to = "0x" + log.topics[2].slice(26);
      tokenId = BigInt(log.topics[3]).toString();
    } catch {
      continue;
    }

    const tx = txInfo.get(log.transactionHash) ?? null;
    const { kind, venue } = classifyTransfer({
      // classifyTransfer's zero-address mint check compares against the
      // canonical lowercase zero address, which is what the topic slice yields.
      from,
      txTo: tx?.to ?? null,
      seaportAddress: SEAPORT_ADDRESS,
      nftContractAddress: NFT_CONTRACT_ADDRESS,
      vaultAddress: MARKET_VAULT_ADDRESS,
      // Every vault, primary and legacy. Getting this wrong writes a legacy
      // deposit/redeem into the ledger as an unpriced "sale" — and the ledger
      // is append-only, so a misclassification here is permanent.
      vaultAddresses: MARKET_VAULT_ADDRESSES,
    });

    if (venue?.kind === "seaport" && isMarketplankAttributed(log.transactionHash, tokenId)) {
      venue.kind = "marketplank";
    }

    // Same price rule as the live feed: a native fill moves value via tx.value,
    // a WETH fill moves it as a Seaport consideration leg (decoded above).
    const nativeWei = kind === "sale" && tx != null && tx.value > BigInt(0) ? tx.value : null;
    const wethWei =
      kind === "sale" ? readCachedSalePriceWei(log.transactionHash, tokenId) : null;
    const priceWei = nativeWei ?? wethWei;

    const event: ActivityEvent = {
      kind,
      tokenId,
      from,
      to,
      priceWei: priceWei == null ? null : priceWei.toString(),
      priceEth: null,
      txHash: log.transactionHash,
      blockNumber: Number(BigInt(log.blockNumber)),
      timestamp: timestamps.get(log.blockNumber) ?? null,
      imageUrl: null,
      venue,
    };
    rows.push(
      activityEventToRow(event, Number(BigInt(log.logIndex)), NFT_CONTRACT_ADDRESS)
    );
  }
  return rows;
}

async function buildVaultRows(logs: RawLog[], vault: string): Promise<ChainEventRow[]> {
  if (logs.length === 0) return [];
  const timestamps = await readBlockTimestamps([...new Set(logs.map((l) => l.blockNumber))]);
  const rows: ChainEventRow[] = [];
  for (const log of logs) {
    const decoded = decodeVaultLog(
      {
        topics: log.topics,
        data: log.data,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        timestamp: timestamps.get(log.blockNumber) ?? null,
      },
      vault
    );
    if (decoded) rows.push(vaultEventToRow(decoded, vault));
  }
  return rows;
}

/**
 * Index one contract forward from its stored cursor.
 *
 * Failure handling is the important part: if a window throws, the cursor is
 * advanced only to the end of the LAST window that actually succeeded. The next
 * tick then resumes at the failed window rather than skipping over a block
 * range nothing ever read — a gap in an append-only ledger is invisible and
 * permanent, which is the failure mode this whole feature exists to eliminate.
 */
export async function indexSource(input: {
  source: ChainEventSource;
  contract: string;
  topics: (string | string[])[];
  head: number;
}): Promise<IndexSourceResult> {
  const { chunkBlocks, maxChunks } = logScanBudget();
  const cursor = await readChainCursor(input.source, input.contract);
  const plan = planScan({
    lastIndexedBlock: cursor?.lastIndexedBlock ?? null,
    head: input.head,
    chunkBlocks,
    maxChunks,
  });

  const startCursor = cursor?.lastIndexedBlock ?? CHAIN_INDEX_GENESIS_BLOCK - 1;
  const result: IndexSourceResult = {
    source: input.source,
    contract: input.contract.toLowerCase(),
    fromBlock: plan.windows[0]?.fromBlock ?? startCursor + 1,
    toBlock: startCursor,
    logsScanned: 0,
    rowsInserted: 0,
    caughtUp: plan.caughtUp,
    error: null,
  };
  if (plan.windows.length === 0) return result;

  const logs: RawLog[] = [];
  let reached = startCursor;
  for (const window of plan.windows) {
    try {
      const found = (await ethGetLogsDisplay({
        address: input.contract,
        topics: input.topics,
        fromBlock: "0x" + window.fromBlock.toString(16),
        toBlock: "0x" + window.toBlock.toString(16),
      })) as RawLog[];
      logs.push(...found);
      reached = window.toBlock;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.caughtUp = false;
      break;
    }
  }
  result.logsScanned = logs.length;

  const rows =
    input.source === "nft"
      ? await buildNftRows(logs)
      : await buildVaultRows(logs, input.contract);

  // Rows are written BEFORE the cursor advances. If the process dies between
  // the two, the next run re-scans the same range and the UNIQUE
  // (tx_hash, log_index) constraint absorbs every duplicate — at-least-once
  // delivery into an idempotent sink. The reverse order would lose events.
  result.rowsInserted = await appendChainEvents(rows);
  if (reached > startCursor) {
    await writeChainCursor(input.source, input.contract, reached, input.head);
    result.toBlock = reached;
  }
  return result;
}

/** Every contract the ledger tracks: the collection plus every known vault. */
export function indexedSources(): Array<{
  source: ChainEventSource;
  contract: string;
  topics: (string | string[])[];
}> {
  const vaults =
    MARKET_VAULT_ADDRESSES.length > 0
      ? [...MARKET_VAULT_ADDRESSES]
      : MARKET_VAULT_ADDRESS
        ? [MARKET_VAULT_ADDRESS]
        : [];

  return [
    { source: "nft" as const, contract: NFT_CONTRACT_ADDRESS, topics: [TRANSFER_TOPIC] },
    ...vaults.map((vault) => ({
      source: "vault" as const,
      contract: vault,
      // Both pool generations' topics, derived from the decoder's own set so a
      // topic can never be decodable but unqueried.
      topics: [[...VAULT_TOPIC_SET]] as (string | string[])[],
    })),
  ];
}

export type IndexRunResult = {
  head: number;
  confirmedHead: number;
  sources: IndexSourceResult[];
  rowsInserted: number;
  caughtUp: boolean;
};

/**
 * One cron tick: advance every tracked contract's cursor.
 *
 * Sources run sequentially on purpose. During backfill each one issues a full
 * logScanBudget() worth of eth_getLogs plus per-transaction enrichment, and
 * running four of those concurrently against a free endpoint is how you earn a
 * 429 storm. Sequential is slower per tick and completes the backfill just the
 * same, because there is always another tick two minutes later.
 */
export async function runChainIndexer(): Promise<IndexRunResult> {
  if (!hasChainEventStore()) {
    throw new Error(
      "chain-indexer requires PostgreSQL (PGHOST/PGDATABASE/PGUSER/PGPASSWORD) — " +
        "the ledger has nowhere to write otherwise."
    );
  }
  const head = await ethBlockNumberDisplay();
  const sources: IndexSourceResult[] = [];
  for (const spec of indexedSources()) {
    try {
      sources.push(await indexSource({ ...spec, head }));
    } catch (error) {
      sources.push({
        source: spec.source,
        contract: spec.contract.toLowerCase(),
        fromBlock: 0,
        toBlock: 0,
        logsScanned: 0,
        rowsInserted: 0,
        caughtUp: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    head,
    confirmedHead: confirmedHead(head),
    sources,
    rowsInserted: sources.reduce((sum, s) => sum + s.rowsInserted, 0),
    caughtUp: sources.every((s) => s.caughtUp),
  };
}
