/**
 * Self-hosted, on-chain X2Y2 (X2Y2_r1) EvInventory fill decode/write -- the
 * shared plumbing hypersync-x2y2-scan.ts's HyperSync fetch loop feeds into,
 * same split as seaport-fill-indexer.ts/hypersync-seaport-scan.ts (decode +
 * write here, fetch there).
 *
 * REAL SOURCES, CITED (2026-08-23 research pass, corrected same pass after
 * a live-smoke-test catch -- see "TWO ADDRESSES" note below)
 * ---------------------------------------------------------------------------
 * Address 0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3 (eth-mainnet) is the
 * REAL, live-traffic X2Y2 Exchange proxy -- confirmed via Sourcify's own
 * verified-contract API (https://sourcify.dev/server/v2/contract/1/
 * 0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3), "exact match" verified
 * ERC1967-style proxy (deployed block 14139341, X2Y2_GENESIS_BLOCK below),
 * cross-confirmed by an independent Etherscan search result labelling it
 * "X2Y2: Exchange" with 901,846 real transactions. This is exactly the
 * address this task's own brief originally cited.
 *
 * TWO ADDRESSES, ONE REAL EVENT -- WHY BOTH MATTER
 * ---------------------------------------------------------------------------
 * X2Y2_ADDRESS (the proxy above, X2Y2_GENESIS_BLOCK) is what HyperSync must
 * scan logs FROM (delegatecall means all events are emitted under the
 * proxy's own address). The EvInventory ABI itself, however, only exists in
 * the IMPLEMENTATION contract's verified source: X2Y2_r1 at
 * 0x6D7812d41A08BC2a910B562d8B56411964A4eD88, also Sourcify "exact match"
 * verified (https://sourcify.dev/server/v2/contract/1/
 * 0x6D7812d41A08BC2a910B562d8B56411964A4eD88), cross-confirmed by
 * X2Y2's own published source repo, https://github.com/0xbe1/x2y2-contracts
 * (X2Y2_r1.sol / MarketConsts.sol). A first pass this session mistakenly
 * scanned logs FROM the implementation address instead of the proxy and
 * found near-zero real traffic (0 matching logs across a full year of
 * blocks, only 2 transactions ever sent directly to it) -- a live HyperSync
 * smoke test caught this before it shipped; the proxy address is the one
 * actually wired in below, confirmed live (5,069 real EvInventory logs in
 * the first 100k blocks after its real deployment, decoded with sane
 * maker/taker/price/NFT values -- see this task's own verification report
 * for sample rows).
 *
 * The EvInventory event ABI below is the REAL ABI pulled directly from
 * Sourcify's verified metadata for the implementation contract (not
 * reconstructed from log snippets) -- Sourcify's "exact match" status means
 * the deployed bytecode was recompiled byte-for-byte from this exact
 * source, the same evidentiary bar as an Etherscan "verified" badge. Struct
 * layouts cross-confirmed against X2Y2's own published source repo:
 *
 *   library Market {
 *     enum Op { INVALID, COMPLETE_SELL_OFFER, COMPLETE_BUY_OFFER,
 *       CANCEL_OFFER, BID, COMPLETE_AUCTION, REFUND_AUCTION,
 *       REFUND_AUCTION_STUCK_ITEM }
 *     struct OrderItem { uint256 price; bytes data; }
 *     struct Fee { uint256 percentage; address to; }
 *     struct SettleDetail {
 *       Market.Op op; uint256 orderIdx; uint256 itemIdx; uint256 price;
 *       bytes32 itemHash; address executionDelegate; bytes dataReplacement;
 *       uint256 bidIncentivePct; uint256 aucMinIncrementPct;
 *       uint256 aucIncDurationSecs; Fee[] fees;
 *     }
 *   }
 *   event EvInventory(bytes32 indexed itemHash, address maker, address taker,
 *     uint256 orderSalt, uint256 settleSalt, uint256 intent,
 *     uint256 delegateType, uint256 deadline, address currency,
 *     bytes dataMask, Market.OrderItem item, Market.SettleDetail detail);
 *
 * detail.op distinguishes a real direct fill from every other lifecycle
 * event this same EvInventory covers (BID/COMPLETE_AUCTION/REFUND_AUCTION/
 * CANCEL_OFFER also emit EvInventory with a different op) -- only
 * COMPLETE_SELL_OFFER (1, maker's resting sell order was taken -> maker is
 * seller, taker is buyer) and COMPLETE_BUY_OFFER (2, maker's resting buy
 * order was taken -> maker is buyer, taker is seller) represent a real
 * completed 1:1 trade; every other op is skipped, not guessed into a fill.
 *
 * NFT IDENTITY -- item.data DECODE, REAL SOURCE
 * ---------------------------------------------------------------------------
 * item.data does not carry a plain (address,uint256) pair; it is
 * ABI-encoded for whichever delegate contract actually executes the
 * transfer. The ONLY delegate whose decode this pass could confirm against
 * real published source is ERC721Delegate
 * (https://github.com/0xbe1/x2y2-contracts/blob/master/contracts/
 * ERC721Delegate.sol):
 *   struct Pair { IERC721 token; uint256 tokenId; }
 *   function decode(bytes calldata data) internal pure returns (Pair[] memory) {
 *     return abi.decode(data, (Pair[]));
 *   }
 * i.e. `abi.decode(item.data, (tuple(address,uint256)[]))`. This pass has no
 * confirmed real source for any other delegateType's data shape (no
 * ERC1155Delegate.sol exists in the verified repo), so decode is attempted
 * ONLY when it succeeds against this exact (address,uint256)[] shape;
 * anything else leaves nft_contract/token_id NULL rather than guessing.
 * Bundle fills (>1 Pair) use only the first pair as the primary leg, same
 * documented stance as the other three fill indexers' own bundle handling.
 */
import { AbiCoder, Interface } from "ethers";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";

/** The real, live-traffic proxy -- events are emitted here via delegatecall, NOT from the X2Y2_r1 implementation address. See this file's own header. */
export const X2Y2_ADDRESS = "0x74312363e45dcaba76c59ec49a7aa8a65a67eed3";
export const X2Y2_CHAIN_SLUG = "eth-mainnet";
export const X2Y2_GENESIS_BLOCK = 14139341;

const FEE_TUPLE = "tuple(uint256 percentage, address to)";
const SETTLE_DETAIL_TUPLE = `tuple(uint8 op, uint256 orderIdx, uint256 itemIdx, uint256 price, bytes32 itemHash, address executionDelegate, bytes dataReplacement, uint256 bidIncentivePct, uint256 aucMinIncrementPct, uint256 aucIncDurationSecs, ${FEE_TUPLE}[] fees)`;
const ORDER_ITEM_TUPLE = "tuple(uint256 price, bytes data)";

const X2Y2_ABI = [
  `event EvInventory(bytes32 indexed itemHash, address maker, address taker, uint256 orderSalt, uint256 settleSalt, uint256 intent, uint256 delegateType, uint256 deadline, address currency, bytes dataMask, ${ORDER_ITEM_TUPLE} item, ${SETTLE_DETAIL_TUPLE} detail)`,
] as const;

const iface = new Interface(X2Y2_ABI);
export const EV_INVENTORY_TOPIC = iface.getEvent("EvInventory")!.topicHash;
export const X2Y2_TOPICS = [EV_INVENTORY_TOPIC];

const abiCoder = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Market.Op: only these two represent a real completed direct fill.
const OP_COMPLETE_SELL_OFFER = 1;
const OP_COMPLETE_BUY_OFFER = 2;

export type DecodedX2Y2Fill = {
  itemHash: string;
  op: number;
  delegateType: string;
  seller: string;
  buyer: string;
  nftContract: string | null;
  tokenId: string | null;
  currencyToken: string | null;
  priceWei: string;
};

/** Best-effort ERC721Delegate item.data decode -- returns null (not a throw) for anything not shaped like (address,uint256)[], per this file's own header. */
function decodeErc721Pair(data: string): { nftContract: string; tokenId: string } | null {
  try {
    const [pairs] = abiCoder.decode(["tuple(address token, uint256 tokenId)[]"], data);
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    const first = pairs[0] as { token: string; tokenId: bigint };
    return { nftContract: first.token.toLowerCase(), tokenId: first.tokenId.toString() };
  } catch {
    return null;
  }
}

/** Pure decode -- no I/O. Returns null for any non-matching/malformed log OR any op that isn't a real completed fill (BID/auction/cancel/refund lifecycle events all share this same event name). */
export function decodeX2Y2Fill(topics: string[], data: string): DecodedX2Y2Fill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "EvInventory") return null;

  const detail = parsed.args.detail as unknown as { op: bigint; price: bigint };
  const op = Number(detail.op);
  if (op !== OP_COMPLETE_SELL_OFFER && op !== OP_COMPLETE_BUY_OFFER) return null;

  const maker = (parsed.args.maker as string).toLowerCase();
  const taker = (parsed.args.taker as string).toLowerCase();
  // COMPLETE_SELL_OFFER: maker's resting sell order was taken -> maker sells, taker buys.
  // COMPLETE_BUY_OFFER: maker's resting buy order was taken -> maker buys, taker sells.
  const seller = op === OP_COMPLETE_SELL_OFFER ? maker : taker;
  const buyer = op === OP_COMPLETE_SELL_OFFER ? taker : maker;

  const item = parsed.args.item as unknown as { data: string };
  const decodedNft = decodeErc721Pair(item.data);

  const currency = (parsed.args.currency as string).toLowerCase();
  return {
    itemHash: parsed.args.itemHash as string,
    op,
    delegateType: (parsed.args.delegateType as bigint).toString(),
    seller,
    buyer,
    nftContract: decodedNft?.nftContract ?? null,
    tokenId: decodedNft?.tokenId ?? null,
    currencyToken: currency === ZERO_ADDRESS ? null : currency,
    priceWei: detail.price.toString(),
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_x2y2_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_x2y2_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_x2y2_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type X2Y2FillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  error?: string;
};

export type X2Y2FillRow = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  fill: DecodedX2Y2Fill;
};

/** Idempotent insert, same (chain_slug, tx_hash, log_index) uniqueness contract as the other three fill writers. Returns the count of genuinely NEW rows written. */
export async function writeX2Y2Fills(rows: X2Y2FillRow[]): Promise<number> {
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
        `INSERT INTO plank_x2y2_fills
           (chain_slug, tx_hash, log_index, block_number, block_timestamp, item_hash, op, delegate_type, seller, buyer, nft_contract, token_id, currency_token, price_wei)
         VALUES ($1, $2, $3, $4, to_timestamp($14), $5, $6, $7::numeric, $8, $9, $10, $11::numeric, $12, $13::numeric)
         ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
        [
          r.chainSlug,
          r.txHash,
          r.logIndex,
          r.blockNumber,
          r.fill.itemHash,
          r.fill.op,
          r.fill.delegateType,
          r.fill.seller,
          r.fill.buyer,
          r.fill.nftContract,
          r.fill.tokenId,
          r.fill.currencyToken,
          r.fill.priceWei,
          r.blockTimestamp ?? null,
        ]
      )
    );
    const isNew = (result.rowCount ?? 0) > 0;
    if (isNew && r.fill.nftContract) {
      await recordSaleEvent({ chainSlug: r.chainSlug, venue: "x2y2", protocol: "x2y2", collectionKey: r.fill.nftContract, tokenId: r.fill.tokenId != null ? String(r.fill.tokenId) : null, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockTimestamp: r.blockTimestamp ?? null, seller: r.fill.seller, buyer: r.fill.buyer, currencyToken: r.fill.currencyToken ?? null, priceWei: r.fill.priceWei != null ? String(r.fill.priceWei) : null, raw: { itemHash: r.fill.itemHash, op: r.fill.op } });
    }
    written += isNew ? 1 : 0;
    if (!isNew || !r.fill.nftContract || !r.fill.tokenId) continue;

    // Lossless per-leg mirror -- only written when the NFT identity was
    // actually decoded (see this file's own header on undecodable delegate
    // types); a fill row still lands in plank_x2y2_fills either way.
    await postgresQuery(
      `INSERT INTO plank_market_event_assets
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, item_type, token_address, token_id, amount_atomic, recipient)
       VALUES ($1, 'x2y2', 'v1', $2, $3, $4, 0, 'offer', 2, $5, $6, 1, $7)
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, X2Y2_ADDRESS, r.txHash, r.logIndex, r.fill.nftContract, r.fill.tokenId, r.fill.buyer]
    );
    await postgresQuery(
      `INSERT INTO plank_market_event_payments
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, token_address, amount_atomic, recipient, allocation_method)
       VALUES ($1, 'x2y2', 'v1', $2, $3, $4, 0, 'consideration', $5, $6::numeric, $7, 'protocol-explicit')
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, X2Y2_ADDRESS, r.txHash, r.logIndex, r.fill.currencyToken, r.fill.priceWei, r.fill.seller]
    );
  }
  await flushLedgerAggregation();
  return written;
}
