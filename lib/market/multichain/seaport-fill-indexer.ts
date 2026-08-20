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
import { MARKET_FEE_RECIPIENT } from "@/lib/constants";
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

/**
 * Per-chain reorg confirmation depth, in THAT CHAIN'S OWN BLOCKS (audit
 * finding M3, 2026-08-19).
 *
 * This previously used a flat 12 for all 8 chains. Twelve is the
 * chain-agnostic folk convention and is wrong in both directions here: far
 * too shallow for Ethereum (where finality is ~2 epochs, not 12 blocks)
 * and needlessly deep for Avalanche (single-block deterministic finality).
 * It matters more than a data-quality nit now that points are scored on
 * fills -- points awarded on a block that later reorgs out are minted from
 * nothing, so this is a financial control, not just an accuracy one.
 *
 * Values target each chain's REAL settlement characteristic, using that
 * chain's own block time:
 *   eth-mainnet     12s blocks; 64 blocks ~= 2 epochs ~= true finality.
 *   polygon-mainnet ~2s blocks; deeper than Circle's aggressive 2-3,
 *                   because Polygon PoS has historically produced
 *                   genuinely deep reorgs.
 *   base / opt      OP Stack, 2s blocks; sequencer output stays reorgable
 *                   until it derives from L1, so this targets ~10 min.
 *   arb-mainnet     ~0.25s blocks; sequencer soft-confirms near-instantly.
 *   bnb-mainnet     BEP-126 fast finality is ~2 blocks; 30 is generous.
 *   avax-mainnet    Snowman: sub-second deterministic finality, no reorgs
 *                   by design; 5 is already belt-and-braces.
 *   zksync-mainnet  soft-confirms instantly.
 *
 * HONEST LIMITATION, stated rather than implied: for Arbitrum and zkSync
 * these depths protect against sequencer-level reversion only. True
 * finality on both requires L1 inclusion/proof submission (~30 min for
 * Arbitrum's force-inclusion window; ~3 hours for a zkSync batch to execute
 * on L1). Waiting that long would make the index uselessly stale, so the
 * tradeoff taken is: index promptly and accept that a deep L1-level
 * reversion on those two could leave a stale row. The genuinely correct
 * long-term fix is to read each chain's `finalized` block tag rather than
 * counting blocks -- a real improvement, deliberately named here rather
 * than silently skipped.
 */
const CONFIRMATION_DEPTH_BY_CHAIN: Record<string, number> = {
  "eth-mainnet": 64,
  "polygon-mainnet": 128,
  "arb-mainnet": 240,
  "base-mainnet": 300,
  "opt-mainnet": 300,
  "bnb-mainnet": 30,
  "avax-mainnet": 5,
  "zksync-mainnet": 100,
};

/** Conservative fallback for a chain absent from the table -- deeper than any entry, so a newly-added chain fails safe (stale) rather than unsafe (reorgable). */
const DEFAULT_CONFIRMATION_DEPTH = 300;

type SpentItem = { itemType: bigint; token: string; identifier: bigint; amount: bigint };

/** ReceivedItem (consideration) additionally carries a recipient; SpentItem (offer) does not. */
type ReceivedItem = SpentItem & { recipient: string };

export type DecodedFill = {
  orderHash: string;
  seller: string;
  buyer: string;
  nftContract: string | null;
  tokenId: string | null;
  currencyToken: string | null;
  priceWei: string | null;
  /**
   * Native/ERC-20 value that provably reached MARKET_FEE_RECIPIENT in this
   * exact fill, in the same currency as priceWei. This -- not priceWei --
   * is what points are awarded on (see writeFills). Zero for any fill this
   * app earned nothing from.
   */
  marketplaceFeeWei: string;
  /** How the shape was interpreted, for diagnosis; "unknown" fills still index but never score. */
  shape: "listing" | "bid" | "swap" | "unknown";
};

/**
 * Pure decode -- no I/O, unit-tested against real ABI-encoded logs built
 * with this same Interface (see test/market/seaport-fill-indexer.test.ts).
 *
 * REWRITTEN 2026-08-19 after audit finding H4. The first version took the
 * FIRST NFT-shaped item and FIRST money-shaped item across
 * offer-concatenated-with-consideration. That was defensible for orders
 * this app produces, but this indexer watches EVERY Seaport fill on 8
 * chains -- overwhelmingly orders written by strangers. A crafted order
 * could put a decoy cheap money item first (with the real payment split
 * across later items) or a different collection's NFT first, and the
 * indexed row would misrepresent the trade -- poisoning floor/volume
 * analytics and, before the points rework below, minting points off a
 * fabricated price.
 *
 * The rewrite is side-aware and total-aware:
 *
 *  1. SHAPE. Seaport's semantics are directional: the offerer gives the
 *     offer array and receives the consideration array. NFTs in `offer`
 *     with money in `consideration` is a LISTING (seller offers the NFT).
 *     Money in `offer` with NFTs in `consideration` is a BID (bidder offers
 *     the money). NFTs on BOTH sides is a SWAP. Deciding this first is what
 *     makes "which item is the traded asset" a derivation rather than a
 *     guess.
 *
 *  2. PRICE. Sums EVERY money item on the paying side that shares the
 *     dominant currency, instead of trusting one item. Seaport splits a
 *     real payment across seller + marketplace fee + creator royalty
 *     legs routinely, so the first item is typically the seller's cut
 *     alone -- the old code systematically UNDER-reported real prices as
 *     well as being spoofable. Mixed-currency orders keep only the
 *     dominant currency's total and are never silently added together.
 *
 *  3. FEE. Consideration items paid to MARKET_FEE_RECIPIENT are summed
 *     separately -- the real, on-chain "what did this app actually earn"
 *     figure that now drives points.
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
  const consideration = parsed.args.consideration as ReceivedItem[];

  const isNft = (i: { itemType: bigint }) =>
    Number(i.itemType) === ITEM_ERC721 || Number(i.itemType) === ITEM_ERC1155;
  const isMoney = (i: { itemType: bigint }) =>
    Number(i.itemType) === ITEM_NATIVE || Number(i.itemType) === ITEM_ERC20;
  /** Native items have no meaningful token address; normalize them to null so native and ERC-20 totals can never be conflated. */
  const currencyOf = (i: { itemType: bigint; token: string }) =>
    Number(i.itemType) === ITEM_ERC20 ? i.token.toLowerCase() : null;

  const offerNfts = offer.filter(isNft);
  const considerationNfts = consideration.filter(isNft);

  let shape: DecodedFill["shape"];
  if (offerNfts.length > 0 && considerationNfts.length > 0) shape = "swap";
  else if (offerNfts.length > 0) shape = "listing";
  else if (considerationNfts.length > 0) shape = "bid";
  else shape = "unknown";

  // The traded asset comes from the side that is DEFINED to hold it for
  // this shape -- never "whichever side happened to list one first".
  // For a swap, the offerer's own side is the canonical subject of the
  // fill (that is the asset leaving the offerer, mirroring how a listing
  // is recorded).
  // Guarded indexing, NOT `arr[0]`: these arrays come from ethers' Result
  // proxy, which throws RangeError("out of result range") on an
  // out-of-bounds index instead of returning undefined. A money-only fill
  // (shape "unknown") has no NFT on either side and would otherwise crash
  // the whole scan window -- caught by this file's own test.
  const subjectNftSide = shape === "bid" ? considerationNfts : offerNfts;
  const subjectNft = subjectNftSide.length > 0 ? subjectNftSide[0] : null;

  // The paying side: for a listing the buyer pays via consideration; for a
  // bid the bidder's money is in the offer array.
  const payingItems: { itemType: bigint; token: string; amount: bigint }[] =
    shape === "bid" ? offer.filter(isMoney) : consideration.filter(isMoney);

  // Pick the price currency by PRESENCE, never by magnitude.
  //
  // A first version chose "the currency with the largest summed amount",
  // which its own test immediately broke: raw amounts across different
  // tokens are not comparable, so an attacker minting 1e21 of a worthless
  // ERC-20 trivially out-weighs a real 1e6-wei native payment and makes
  // their token "dominant". Native is therefore preferred whenever any
  // native leg exists (nobody can mint it), and only otherwise does the
  // largest ERC-20 total stand in -- purely as a display/volume figure,
  // never as a basis for scoring (see the fee rule below).
  const totalsByCurrency = new Map<string | null, bigint>();
  for (const item of payingItems) {
    const key = currencyOf(item);
    totalsByCurrency.set(key, (totalsByCurrency.get(key) ?? BigInt(0)) + item.amount);
  }
  let priceCurrency: string | null = null;
  let priceTotal = BigInt(0);
  if (totalsByCurrency.has(null)) {
    priceCurrency = null;
    priceTotal = totalsByCurrency.get(null)!;
  } else {
    for (const [currency, total] of totalsByCurrency) {
      if (total > priceTotal) {
        priceTotal = total;
        priceCurrency = currency;
      }
    }
  }

  // WHAT ACTUALLY REACHED THIS APP -- NATIVE LEGS ONLY.
  //
  // This drives points (see writeFills), so it has to be unforgeable, and
  // the strict rule is also the exactly-correct one: every fee this app
  // charges is denominated in the chain's NATIVE token -- the native
  // listing/bundle/swap fees (NATIVE_TOKEN_ADDRESS in
  // order-validation.ts) and the third-party fill tip (foreignFillTip)
  // alike. So "count only native fee legs" is not a heuristic or a
  // conservative approximation; it matches how we bill, exactly, while
  // making the H3 attack impossible by construction: an attacker cannot
  // mint the gas token, and a "fee" routed to us in a token they created
  // is correctly worth zero points because it is worth zero.
  //
  // If a real ERC-20-denominated fee is ever charged, this must gain an
  // explicit per-chain allowlist of verified currencies (WETH/USDC/USDT)
  // -- never a magnitude comparison.
  let marketplaceFee = BigInt(0);
  for (const item of consideration) {
    if (Number(item.itemType) !== ITEM_NATIVE) continue;
    if (item.recipient && item.recipient.toLowerCase() === MARKET_FEE_RECIPIENT.toLowerCase()) {
      marketplaceFee += item.amount;
    }
  }

  return {
    orderHash: parsed.args.orderHash as string,
    seller: (parsed.args.offerer as string).toLowerCase(),
    buyer: (parsed.args.recipient as string).toLowerCase(),
    nftContract: subjectNft ? subjectNft.token.toLowerCase() : null,
    tokenId: subjectNft ? subjectNft.identifier.toString() : null,
    currencyToken: priceCurrency,
    priceWei: payingItems.length > 0 ? priceTotal.toString() : null,
    marketplaceFeeWei: marketplaceFee.toString(),
    shape,
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
     * permanently. Defaults to this chain's own entry in
     * CONFIRMATION_DEPTH_BY_CHAIN (see that table for the per-chain
     * reasoning and its honest limitations). Test-only callers may
     * override to prove the scan/decode mechanism against a single-node
     * fork with no reorg risk at all.
     */
    confirmationDepth?: number;
  }
): Promise<FillScanResult> {
  const headHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  const head = Number.parseInt(headHex, 16);
  const confirmationDepth =
    opts?.confirmationDepth ?? CONFIRMATION_DEPTH_BY_CHAIN[chainSlug] ?? DEFAULT_CONFIRMATION_DEPTH;

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
         (chain_slug, tx_hash, log_index, block_number, order_hash, seller, buyer, nft_contract, token_id, currency_token, price_wei, marketplace_fee_wei, shape)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12::numeric, $13)
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
        r.fill.marketplaceFeeWei,
        r.fill.shape,
      ]
    );
    const isNew = (result.rowCount ?? 0) > 0;
    written += isNew ? 1 : 0;

    // POINTS ARE AWARDED ON FEE ACTUALLY RECEIVED, NOT ON SALE PRICE
    // ------------------------------------------------------------------
    // Rewritten 2026-08-19 after audit findings H2/H3, on the owner's own
    // direction ("points... attributed to the $ value that actually
    // reaches the marketplace itself"). The previous version scored
    // `salePoints(priceWei)` for the buyer of ANY observed fill, which was
    // freely farmable two ways:
    //   H2 -- self-wash trading: sign a listing from wallet A, fill from
    //         wallet B (both yours), directly against Seaport. The ETH
    //         round-trips to yourself, so the only cost is gas (cents on
    //         an L2) and the points are unbounded.
    //   H3 -- fabricated currency: mint a worthless ERC-20, "sell" your
    //         own NFT for 1,000,000 of it, self-fill. No real value moves
    //         at all, yet priceWei was astronomical.
    //
    // Scoring the marketplace fee closes BOTH structurally rather than by
    // detection heuristics (which are adversarial and eventually lose):
    // every point now costs its earner real, irreversible money paid to
    // this app, so farming is capped by arithmetic instead of by us
    // out-guessing the farmer. A wash trade earns points only in exact
    // proportion to what it paid us -- at which point it is simply a
    // customer. And decodeOrderFulfilled only counts fee legs denominated
    // in the fill's DOMINANT currency, so an attacker cannot "pay" the fee
    // in a token they minted.
    //
    // Awarded to the BUYER (the fulfiller, who actually parts with the
    // money), only for genuinely NEW rows, so a re-scanned window never
    // double-credits -- belt and suspenders over recordPointEvent's own
    // (source_tx_hash, category, wallet) idempotency.
    //
    // NOTE the deliberate remaining gap: fees paid to OTHER marketplaces
    // earn nothing here, which is correct -- this app is scoring its own
    // revenue, not third-party revenue.
    if (isNew && r.fill.marketplaceFeeWei !== "0") {
      try {
        const { marketplaceFeePoints, recordPointEvent } = await import("@/lib/plank-checks");
        const points = marketplaceFeePoints(BigInt(r.fill.marketplaceFeeWei));
        if (points > 0) {
          await recordPointEvent({
            wallet: r.fill.buyer,
            category: "sale",
            points,
            sourceTxHash: r.txHash,
            metadata: {
              chainSlug: r.chainSlug,
              nftContract: r.fill.nftContract,
              tokenId: r.fill.tokenId,
              shape: r.fill.shape,
              feeWei: r.fill.marketplaceFeeWei,
              currencyToken: r.fill.currencyToken,
            },
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
    // Real fallback across every URL foreignRpcUrls returns (Alchemy
    // first, a free PublicNode endpoint second) -- added live 2026-08-20
    // after Alchemy's own key hit its real monthly capacity limit and
    // took down fill scanning for every chain at once, since this loop
    // previously only ever tried URL [0]. Each URL gets one real attempt;
    // the last real error is what's reported if every URL fails, not a
    // generic "no RPC available" message.
    const urls = foreignRpcUrls(chain.chainSlug);
    let lastError: unknown = new Error(`no RPC URL configured for ${chain.chainSlug}`);
    let succeeded = false;
    for (const rpcUrl of urls) {
      try {
        results.push(await scanChainForFills(chain.chainSlug, rpcUrl));
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (succeeded) continue;
    results.push({
      chainSlug: chain.chainSlug,
      fromBlock: 0,
      toBlock: 0,
      logsScanned: 0,
      fillsWritten: 0,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }
  return results;
}
