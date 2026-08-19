/**
 * Self-hosted, on-chain Seaport OrderFulfilled fill indexer -- see
 * migration 023_seaport_fill_index.sql's own header for the full "why"
 * (Reservoir and SimpleHash, the two APIs this ecosystem used to lean on
 * for real fill/volume data, both shut down; this is this app's own,
 * independent, first-party replacement).
 *
 * REUSES THE PROVEN CURSOR/CHUNK SKELETON, NOT A NEW ONE
 * ------------------------------------------------------------------
 * planScan/confirmedHead are IMPORTED from chain-indexer.ts, not
 * reimplemented -- that range math is already unit-tested and already
 * proven correct in production for Robinhood Chain; duplicating it here
 * would risk the two copies drifting apart. rpcCall is imported from
 * evm-log-scan.ts for the same reason (one real JSON-RPC POST helper, not
 * two). The 10-block eth_getLogs ceiling that module verified live against
 * a real Alchemy key applies here too -- same free tier, same constraint,
 * cited rather than re-verified.
 *
 * WHY A GLOBAL SCAN WORKS HERE (UNLIKE chain-indexer.ts's OWN
 * OrderFulfilled DECODE)
 * ------------------------------------------------------------------
 * chain-indexer.ts's own comment explains why it CAN'T filter eth_getLogs
 * by OrderFulfilled directly: the event carries collection identity only
 * in unindexed `data`, not a topic, so a single collection can't be
 * isolated server-side. This indexer doesn't need to isolate one
 * collection -- it wants EVERY fill, across every collection, on a chain.
 * Seaport's own CONTRACT ADDRESS *is* filterable (eth_getLogs' `address`
 * parameter, not a topic), and that address is identical on every chain
 * this app trades on (verified live, see foreign-chain-registry.ts) -- so
 * one address-filtered scan per chain captures every Seaport fill on that
 * chain, and each log's `data` is decoded client-side afterward to learn
 * which collection/token/price it was for.
 */
import { Interface } from "ethers";
import { postgresQuery } from "@/lib/postgres";
import { confirmedHead, planScan } from "@/lib/market/chain-indexer";
import { logScanBudget } from "@/lib/market/rpc-budget";
import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";
import { FOREIGN_CHAINS, FOREIGN_SEAPORT_ADDRESS, foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";

const ORDER_FULFILLED_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "orderHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "offerer", type: "address" },
      { indexed: true, internalType: "address", name: "zone", type: "address" },
      { indexed: false, internalType: "address", name: "recipient", type: "address" },
      {
        components: [
          { internalType: "enum ItemType", name: "itemType", type: "uint8" },
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "identifier", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
        ],
        indexed: false,
        internalType: "struct SpentItem[]",
        name: "offer",
        type: "tuple[]",
      },
      {
        components: [
          { internalType: "enum ItemType", name: "itemType", type: "uint8" },
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "identifier", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "address payable", name: "recipient", type: "address" },
        ],
        indexed: false,
        internalType: "struct ReceivedItem[]",
        name: "consideration",
        type: "tuple[]",
      },
    ],
    name: "OrderFulfilled",
    type: "event",
  },
] as const;

const iface = new Interface(ORDER_FULFILLED_ABI);
export const ORDER_FULFILLED_TOPIC = iface.getEvent("OrderFulfilled")!.topicHash;

const ITEM_ERC721 = 2;
const ITEM_ERC1155 = 3;
const ITEM_NATIVE = 0;
const ITEM_ERC20 = 1;

type SpentItem = { itemType: bigint; token: string; identifier: bigint; amount: bigint };

export type DecodedFill = {
  orderHash: string;
  seller: string;
  buyer: string;
  nftContract: string | null;
  tokenId: string | null;
  currencyToken: string | null;
  priceWei: string | null;
};

/**
 * Pure decode -- no I/O, unit-tested against a real ABI-encoded log built
 * with this same Interface (see test/market/seaport-fill-indexer.test.ts).
 * Finds the first NFT-shaped item and the first money-shaped item across
 * offer then consideration -- correct for every real order this app's own
 * validators (validateListingOrder/validateOfferOrder/
 * validateBundleListingOrder/validateSwapOrder) can produce, all of which
 * have exactly one NFT-vs-money split per side. A genuinely exotic
 * third-party order (e.g. a multi-NFT-for-multi-NFT swap with no money
 * leg at all) still indexes correctly for ownership/activity purposes --
 * nft_contract/token_id are still populated -- it just has a null price,
 * which the schema already allows for exactly this reason.
 */
export function decodeOrderFulfilled(topics: string[], data: string): DecodedFill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "OrderFulfilled") return null;

  const offer = parsed.args.offer as SpentItem[];
  const consideration = parsed.args.consideration as SpentItem[];
  const allItems = [...offer, ...consideration];

  const nftItem = allItems.find((i) => Number(i.itemType) === ITEM_ERC721 || Number(i.itemType) === ITEM_ERC1155);
  const moneyItem = allItems.find((i) => Number(i.itemType) === ITEM_NATIVE || Number(i.itemType) === ITEM_ERC20);

  return {
    orderHash: parsed.args.orderHash as string,
    seller: (parsed.args.offerer as string).toLowerCase(),
    buyer: (parsed.args.recipient as string).toLowerCase(),
    nftContract: nftItem ? nftItem.token.toLowerCase() : null,
    tokenId: nftItem ? nftItem.identifier.toString() : null,
    currencyToken: moneyItem && Number(moneyItem.itemType) === ITEM_ERC20 ? moneyItem.token.toLowerCase() : null,
    priceWei: moneyItem ? moneyItem.amount.toString() : null,
  };
}

async function readCursor(chainSlug: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_seaport_fill_cursor WHERE chain_slug = $1`,
    [chainSlug]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

async function writeCursor(chainSlug: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_seaport_fill_cursor (chain_slug, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_indexed_block = GREATEST(plank_seaport_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [chainSlug, block]
  );
}

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };

export type FillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  error?: string;
};

/**
 * One tick for one chain: plans a scan (backfill-and-live-sync are the
 * same code path, same property chain-indexer.ts's own cursor already
 * has), fetches Seaport-address-filtered logs, decodes and writes every
 * fill idempotently, advances the cursor only past windows that actually
 * succeeded.
 */
export async function scanChainForFills(
  chainSlug: string,
  rpcUrl: string,
  opts?: {
    /**
     * Blocks to hold back from the head before a fill is safe to write
     * permanently -- see chain-indexer.ts's own CONFIRMATION_DEPTH_BLOCKS
     * for the underlying reasoning (append-only ledger, a written-then-
     * reorged-out row is wrong forever). That constant is tuned for
     * Robinhood Chain specifically (~600 blocks ~= 1 minute on a fast L2);
     * reusing it verbatim here would apply an L2-specific number to
     * Ethereum mainnet and every other foreign chain, which is wrong in
     * BOTH directions (too shallow for mainnet's real reorg risk, needlessly
     * deep for an equally-fast L2 like Base/Optimism/Arbitrum). Defaults to
     * 12 -- the long-standing, chain-agnostic "wait ~12 confirmations"
     * convention -- as an honestly-conservative default rather than a
     * precisely per-chain-tuned table (a real future improvement, not
     * silently skipped: per-chain block times are already known via
     * FOREIGN_CHAINS if this is ever worth tuning further). Test-only
     * callers may override this to prove the scan/decode mechanism against
     * a single-node fork with no reorg risk at all.
     */
    confirmationDepth?: number;
  }
): Promise<FillScanResult> {
  const headHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  const head = Number.parseInt(headHex, 16);
  const confirmationDepth = opts?.confirmationDepth ?? 12;

  const lastIndexedBlock = await readCursor(chainSlug);
  // No historical backfill target -- bootstraps from just-below-head on
  // first run (see migration's own "forward-only" scope note). A
  // genesis block one chunk behind head means the very first tick still
  // does real, useful work instead of an empty no-op window.
  const { chunkBlocks, maxChunks } = logScanBudget();
  const genesisBlock = lastIndexedBlock ?? Math.max(0, confirmedHead(head, confirmationDepth) - chunkBlocks);

  const plan = planScan({
    lastIndexedBlock,
    head,
    genesisBlock,
    confirmationDepth,
    chunkBlocks: Math.min(chunkBlocks, 10), // same free-tier ceiling evm-log-scan.ts verified live
    maxChunks,
  });

  if (plan.windows.length === 0) {
    return { chainSlug, fromBlock: lastIndexedBlock ?? genesisBlock, toBlock: lastIndexedBlock ?? genesisBlock, logsScanned: 0, fillsWritten: 0 };
  }

  let totalLogs = 0;
  let totalWritten = 0;
  let lastSucceededBlock: number | null = lastIndexedBlock;

  try {
    for (const window of plan.windows) {
      const logs = await rpcCall<RawLog[]>(rpcUrl, "eth_getLogs", [
        {
          fromBlock: "0x" + window.fromBlock.toString(16),
          toBlock: "0x" + window.toBlock.toString(16),
          address: FOREIGN_SEAPORT_ADDRESS,
          topics: [ORDER_FULFILLED_TOPIC],
        },
      ]);
      totalLogs += logs.length;

      const rows: {
        chainSlug: string;
        txHash: string;
        logIndex: number;
        blockNumber: number;
        fill: DecodedFill;
      }[] = [];
      for (const log of logs) {
        const fill = decodeOrderFulfilled(log.topics, log.data);
        if (!fill) continue;
        rows.push({
          chainSlug,
          txHash: log.transactionHash,
          logIndex: Number.parseInt(log.logIndex, 16),
          blockNumber: Number.parseInt(log.blockNumber, 16),
          fill,
        });
      }
      if (rows.length > 0) {
        totalWritten += await writeFills(rows);
      }
      await writeCursor(chainSlug, window.toBlock);
      lastSucceededBlock = window.toBlock;
    }
  } catch (err) {
    return {
      chainSlug,
      fromBlock: plan.windows[0].fromBlock,
      toBlock: lastSucceededBlock ?? plan.windows[0].fromBlock,
      logsScanned: totalLogs,
      fillsWritten: totalWritten,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    chainSlug,
    fromBlock: plan.windows[0].fromBlock,
    toBlock: plan.windows[plan.windows.length - 1].toBlock,
    logsScanned: totalLogs,
    fillsWritten: totalWritten,
  };
}

async function writeFills(
  rows: { chainSlug: string; txHash: string; logIndex: number; blockNumber: number; fill: DecodedFill }[]
): Promise<number> {
  // Dedupe within-batch -- same reason appendChainEvents does: Postgres
  // rejects ON CONFLICT DO NOTHING against two conflicting rows in one
  // statement.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.chainSlug}:${r.txHash}:${r.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let written = 0;
  for (const r of deduped) {
    const result = await postgresQuery(
      `INSERT INTO plank_seaport_fills
         (chain_slug, tx_hash, log_index, block_number, order_hash, seller, buyer, nft_contract, token_id, currency_token, price_wei)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
      [
        r.chainSlug,
        r.txHash,
        r.logIndex,
        r.blockNumber,
        r.fill.orderHash,
        r.fill.seller,
        r.fill.buyer,
        r.fill.nftContract,
        r.fill.tokenId,
        r.fill.currencyToken,
        r.fill.priceWei,
      ]
    );
    const isNew = (result.rowCount ?? 0) > 0;
    written += isNew ? 1 : 0;

    // Award real "sale" points -- see lib/plank-checks.ts's PointCategory
    // and its own "TRUSTED-CALLER-ONLY BOUNDARY" doc comment: this IS a
    // safe caller because the points here are derived from a REAL,
    // confirmed on-chain OrderFulfilled log this function just decoded --
    // never client-supplied. Only for genuinely NEW rows (isNew), so a
    // re-run over an already-indexed window never double-awards (belt and
    // suspenders on top of recordPointEvent's own (source_tx_hash,
    // category, wallet) idempotency). marketplankAttributed is always
    // false here -- this scan watches EVERY Seaport fill on a chain, not
    // only ones that came through this app's own native order tables;
    // cross-referencing order_hash against market_orders/
    // market_bundle_listings/market_swap_listings to earn the full
    // attributed rate is real, valuable future work, not silently skipped
    // -- see this file's own header on the indexer's stated scope.
    if (isNew && r.fill.priceWei && r.fill.priceWei !== "0") {
      try {
        const { salePoints, recordPointEvent } = await import("@/lib/plank-checks");
        const points = salePoints(BigInt(r.fill.priceWei), false);
        if (points > 0) {
          await recordPointEvent({
            wallet: r.fill.buyer,
            category: "sale",
            points,
            sourceTxHash: r.txHash,
            metadata: { chainSlug: r.chainSlug, nftContract: r.fill.nftContract, tokenId: r.fill.tokenId },
            earnedAt: new Date(),
          });
        }
      } catch {
        // Points are a vanity layer on top of the real fill record, which
        // is already durably written above -- a points-award failure must
        // never make the indexer itself look like it failed.
      }
    }
  }
  return written;
}

/**
 * Every chain this scans, in one place -- FOREIGN_CHAINS itself (not a
 * separately maintained list), so a chain added there (e.g. zkSync,
 * 2026-08-19) is automatically covered here too. Sequential, same
 * anti-RPC-burst reasoning as runChainIndexer/runAllEvmDiscoveryScans.
 */
export async function scanAllChainsForFills(): Promise<FillScanResult[]> {
  const results: FillScanResult[] = [];
  for (const chain of FOREIGN_CHAINS) {
    try {
      const rpcUrl = foreignRpcUrls(chain.chainSlug)[0];
      results.push(await scanChainForFills(chain.chainSlug, rpcUrl));
    } catch (err) {
      results.push({
        chainSlug: chain.chainSlug,
        fromBlock: 0,
        toBlock: 0,
        logsScanned: 0,
        fillsWritten: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
