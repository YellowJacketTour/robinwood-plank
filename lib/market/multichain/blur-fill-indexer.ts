/**
 * Self-hosted, on-chain BlurExchange OrdersMatched fill decode/write -- the
 * shared plumbing hypersync-blur-scan.ts's HyperSync fetch loop feeds into,
 * same split as seaport-fill-indexer.ts/hypersync-seaport-scan.ts (decode +
 * write here, fetch there).
 *
 * REAL SOURCES, CITED (2026-08-23 research pass)
 * ---------------------------------------------------------------------------
 * Address 0x000000000000Ad05Ccc4F10045630fb830B95127 (BlurExchange proxy,
 * eth-mainnet, "Blur.io: Marketplace 2" on Etherscan) -- independently
 * re-confirmed via Sourcify's own verified-contract API
 * (https://sourcify.dev/server/v2/contract/1/
 * 0x000000000000Ad05Ccc4F10045630fb830B95127), "exact match" verified
 * ERC1967Proxy, deployed at block 15779579 (BLUR_GENESIS_BLOCK below). The
 * proxy's own ABI only exposes AdminChanged/BeaconUpgraded/Upgraded (as
 * expected for an ERC1967Proxy -- logs are emitted from the proxy address
 * via delegatecall, but the *event definitions* live on the implementation
 * contract, which is why they aren't in the proxy's own verified ABI).
 * Event signature and struct layout below are copied verbatim from Blur's
 * own Code4rena-audited source (the real source Blur submitted for its own
 * October 2022 security audit):
 *   https://github.com/code-423n4/2022-10-blur/blob/main/contracts/BlurExchange.sol
 *   https://github.com/code-423n4/2022-10-blur/blob/main/contracts/lib/OrderStructs.sol
 *
 *   enum Side { Buy, Sell }
 *   struct Fee { uint16 rate; address payable recipient; }
 *   struct Order {
 *     address trader; Side side; address matchingPolicy; address collection;
 *     uint256 tokenId; uint256 amount; address paymentToken; uint256 price;
 *     uint256 listingTime; uint256 expirationTime; Fee[] fees; uint256 salt;
 *     bytes extraParams;
 *   }
 *   event OrdersMatched(address indexed maker, address indexed taker,
 *     Order sell, bytes32 sellHash, Order buy, bytes32 buyHash);
 *
 * `sell` is the Side.Sell order (trader = seller), `buy` is the Side.Buy
 * order (trader = buyer). The traded NFT/price/currency are read off the
 * `sell` order (both orders agree on collection/tokenId/price/paymentToken
 * once matched -- BlurExchange's own _canMatchOrders enforces that).
 *
 * BLEND IS DELIBERATELY OUT OF SCOPE THIS PASS -- REAL EVIDENCE, NOT A GUESS
 * ---------------------------------------------------------------------------
 * Blur's separate Blend contract (pooled peer-to-pool NFT-backed lending
 * used for "Blur Bids"/pool-funded buys) emits its own BuyLocked/Repay/
 * Refinance-shaped events over open loan positions, not a simple 1:1 fill --
 * a Blend-financed purchase is economically a loan origination against a
 * pool, not a matched maker/taker order, and normalizing it into the same
 * "buyer paid seller X for token Y" shape this table represents would
 * misrepresent what actually happened on-chain (who the real counterparty
 * is, whether the position can later be defaulted/reclaimed, etc). This
 * pass did not independently re-verify Blend's real event ABI against
 * primary source (time-boxed to what BlurExchange itself needed), so rather
 * than guess a normalization, Blend indexing remains an explicit documented
 * follow-up. BlurExchange's own OrdersMatched, built here, is Blur's real
 * direct marketplace event and covers the bulk of Blur's non-pool-financed
 * sell/buy-order matches.
 */
import { Interface } from "ethers";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";

export const BLUR_EXCHANGE_ADDRESS = "0x000000000000ad05ccc4f10045630fb830b95127";
export const BLUR_CHAIN_SLUG = "eth-mainnet";
export const BLUR_GENESIS_BLOCK = 15779579;

const FEE_TUPLE = "tuple(uint16 rate, address recipient)";
const ORDER_TUPLE = `tuple(address trader, uint8 side, address matchingPolicy, address collection, uint256 tokenId, uint256 amount, address paymentToken, uint256 price, uint256 listingTime, uint256 expirationTime, ${FEE_TUPLE}[] fees, uint256 salt, bytes extraParams)`;

const BLUR_EXCHANGE_ABI = [
  `event OrdersMatched(address indexed maker, address indexed taker, ${ORDER_TUPLE} sell, bytes32 sellHash, ${ORDER_TUPLE} buy, bytes32 buyHash)`,
] as const;

const iface = new Interface(BLUR_EXCHANGE_ABI);
export const ORDERS_MATCHED_TOPIC = iface.getEvent("OrdersMatched")!.topicHash;
export const BLUR_TOPICS = [ORDERS_MATCHED_TOPIC];

/** paymentToken's real zero-address convention for native ETH, same normalization plank_seaport_fills/plank_looksrare_fills already use. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type DecodedBlurFill = {
  sellHash: string;
  buyHash: string;
  seller: string;
  buyer: string;
  nftContract: string;
  tokenId: string;
  amount: string;
  currencyToken: string | null;
  priceWei: string;
};

/** Pure decode -- no I/O. Mirrors decodeOrdersMatched's (Wyvern) try/catch shape: a non-matching/malformed log returns null rather than throwing into the caller's scan loop. */
export function decodeBlurOrdersMatched(topics: string[], data: string): DecodedBlurFill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "OrdersMatched") return null;

  const sell = parsed.args.sell as unknown as {
    trader: string;
    side: bigint;
    collection: string;
    tokenId: bigint;
    amount: bigint;
    paymentToken: string;
    price: bigint;
  };
  const buy = parsed.args.buy as unknown as { trader: string };

  const currency = sell.paymentToken.toLowerCase();
  return {
    sellHash: parsed.args.sellHash as string,
    buyHash: parsed.args.buyHash as string,
    seller: sell.trader.toLowerCase(),
    buyer: buy.trader.toLowerCase(),
    nftContract: sell.collection.toLowerCase(),
    tokenId: sell.tokenId.toString(),
    amount: sell.amount.toString(),
    currencyToken: currency === ZERO_ADDRESS ? null : currency,
    priceWei: sell.price.toString(),
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_blur_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_blur_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_blur_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type BlurFillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  error?: string;
};

export type BlurFillRow = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  fill: DecodedBlurFill;
};

/** Idempotent insert, same (chain_slug, tx_hash, log_index) uniqueness contract as the other three fill writers. Returns the count of genuinely NEW rows written. */
export async function writeBlurFills(rows: BlurFillRow[]): Promise<number> {
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.chainSlug}:${r.txHash}:${r.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let written = 0;
  for (const r of deduped) {
    const result = await withPostgresTransaction((client) =>
      client.query(
        `INSERT INTO plank_blur_fills
           (chain_slug, tx_hash, log_index, block_number, block_timestamp, sell_hash, buy_hash, seller, buyer, nft_contract, token_id, amount, currency_token, price_wei)
         VALUES ($1, $2, $3, $4, to_timestamp($14), $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12, $13::numeric)
         ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
        [
          r.chainSlug,
          r.txHash,
          r.logIndex,
          r.blockNumber,
          r.fill.sellHash,
          r.fill.buyHash,
          r.fill.seller,
          r.fill.buyer,
          r.fill.nftContract,
          r.fill.tokenId,
          r.fill.amount,
          r.fill.currencyToken,
          r.fill.priceWei,
          r.blockTimestamp ?? null,
        ]
      )
    );
    const isNew = (result.rowCount ?? 0) > 0;
    if (isNew && r.fill.nftContract) {
      await recordSaleEvent({ chainSlug: r.chainSlug, venue: "blur", protocol: "blur", collectionKey: r.fill.nftContract, tokenId: r.fill.tokenId != null ? String(r.fill.tokenId) : null, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockTimestamp: r.blockTimestamp ?? null, seller: r.fill.seller, buyer: r.fill.buyer, currencyToken: r.fill.currencyToken ?? null, priceWei: r.fill.priceWei != null ? String(r.fill.priceWei) : null, raw: { sellHash: r.fill.sellHash, buyHash: r.fill.buyHash } });
    }
    written += isNew ? 1 : 0;
    if (!isNew) continue;

    // Lossless per-leg mirror into the shared venue-generic tables, same
    // shape looksrare-fill-indexer.ts's own writeLooksRareFills populates.
    await postgresQuery(
      `INSERT INTO plank_market_event_assets
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, item_type, token_address, token_id, amount_atomic, recipient)
       VALUES ($1, 'blur', 'v1', $2, $3, $4, 0, 'offer', 2, $5, $6, $7::numeric, $8)
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, BLUR_EXCHANGE_ADDRESS, r.txHash, r.logIndex, r.fill.nftContract, r.fill.tokenId, r.fill.amount, r.fill.buyer]
    );
    await postgresQuery(
      `INSERT INTO plank_market_event_payments
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, token_address, amount_atomic, recipient, allocation_method)
       VALUES ($1, 'blur', 'v1', $2, $3, $4, 0, 'consideration', $5, $6::numeric, $7, 'protocol-explicit')
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, BLUR_EXCHANGE_ADDRESS, r.txHash, r.logIndex, r.fill.currencyToken, r.fill.priceWei, r.fill.seller]
    );
  }
  await flushLedgerAggregation();
  return written;
}
