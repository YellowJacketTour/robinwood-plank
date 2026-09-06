/**
 * Self-hosted, on-chain LooksRare v1 TakerAsk/TakerBid fill decode/write --
 * the SAME real "why" as seaport-fill-indexer.ts's own header (Reservoir
 * and SimpleHash both shut down; this app has no on-going third-party fill
 * API and builds its own first-party record straight from the chain).
 *
 * REAL SOURCES, CITED (2026-08-23 research pass)
 * ---------------------------------------------------------------------------
 * Address 0x59728544b08ab483533076417fbbb2fd0b17ce3a (LooksRareExchange v1,
 * eth-mainnet) -- LooksRare's own official docs,
 * https://docs.looksrare.org/developers/deployed-contract-addresses,
 * cross-confirmed by Etherscan's contract label "LooksRare: Exchange" at the
 * identical address (multiple independent search hits, 2026-08-23).
 *
 * Event signatures -- copied verbatim from LooksRare's own published
 * contract source,
 * https://github.com/LooksRare/contracts-exchange-v1/blob/master/contracts/LooksRareExchange.sol :
 *
 *   event TakerAsk(bytes32 orderHash, uint256 orderNonce, address indexed taker,
 *     address indexed maker, address indexed strategy, address currency,
 *     address collection, uint256 tokenId, uint256 amount, uint256 price);
 *   event TakerBid(bytes32 orderHash, uint256 orderNonce, address indexed taker,
 *     address indexed maker, address indexed strategy, address currency,
 *     address collection, uint256 tokenId, uint256 amount, uint256 price);
 *
 * TakerBid means a taker submitted a bid TX against a resting maker ASK, so
 * the taker is the BUYER and the maker is the SELLER. TakerAsk is the
 * mirror: the taker submitted an ask TX against a resting maker BID (offer),
 * so the taker is the SELLER and the maker is the BUYER.
 *
 * HONEST SCOPE, STATED NOT HIDDEN
 * ---------------------------------------------------------------------------
 * v1 ONLY, eth-mainnet ONLY. LooksRare v1 was never deployed to another
 * chain (it predates LooksRare's own multi-chain v2 rollout, which uses a
 * different LooksRareProtocol contract at 0x0000000000E655fAe4d56241588680F
 * 86E3b2377 with a different event shape this pass did not independently
 * verify against primary source). v2 is left "planned" rather than guessed.
 * v1's own real, meaningful 2022+ volume is what this scanner covers.
 *
 * v1 has no bundle support -- exactly one NFT leg and one currency leg per
 * fill, unlike Seaport's arbitrary offer/consideration arrays -- so no
 * shape-inference logic is needed here; the event itself is already
 * unambiguous about which side is buyer/seller and what the traded item is.
 *
 * REUSES THE SAME LOSSLESS LEG TABLES SEAPORT ALREADY WRITES TO
 * ---------------------------------------------------------------------------
 * plank_market_event_assets / plank_market_event_payments (migration 046)
 * are venue-generic already (venue_id TEXT, no CHECK constraint pinning it
 * to 'seaport') -- reused here with venue_id = 'looksrare', protocol_version
 * = 'v1'. The summary row lands in its OWN table, plank_looksrare_fills
 * (migration 048), not plank_seaport_fills -- that table's own name and
 * migration header are explicitly Seaport-scoped, and writing a different
 * protocol's fills into it would misrepresent what the table means.
 */
import { Interface } from "ethers";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";
import { postgresQuery } from "@/lib/postgres";

export const LOOKSRARE_V1_ADDRESS = "0x59728544b08ab483533076417fbbb2fd0b17ce3a";
export const LOOKSRARE_V1_CHAIN_SLUG = "eth-mainnet";

const LOOKSRARE_V1_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "orderHash", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "orderNonce", type: "uint256" },
      { indexed: true, internalType: "address", name: "taker", type: "address" },
      { indexed: true, internalType: "address", name: "maker", type: "address" },
      { indexed: true, internalType: "address", name: "strategy", type: "address" },
      { indexed: false, internalType: "address", name: "currency", type: "address" },
      { indexed: false, internalType: "address", name: "collection", type: "address" },
      { indexed: false, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "price", type: "uint256" },
    ],
    name: "TakerAsk",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "orderHash", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "orderNonce", type: "uint256" },
      { indexed: true, internalType: "address", name: "taker", type: "address" },
      { indexed: true, internalType: "address", name: "maker", type: "address" },
      { indexed: true, internalType: "address", name: "strategy", type: "address" },
      { indexed: false, internalType: "address", name: "currency", type: "address" },
      { indexed: false, internalType: "address", name: "collection", type: "address" },
      { indexed: false, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "price", type: "uint256" },
    ],
    name: "TakerBid",
    type: "event",
  },
] as const;

const iface = new Interface(LOOKSRARE_V1_ABI);
export const TAKER_ASK_TOPIC = iface.getEvent("TakerAsk")!.topicHash;
export const TAKER_BID_TOPIC = iface.getEvent("TakerBid")!.topicHash;
export const LOOKSRARE_V1_TOPICS = [TAKER_ASK_TOPIC, TAKER_BID_TOPIC];

/** WETH on eth-mainnet -- LooksRare v1's real currency() convention is the zero address for native ETH, not a null/omitted field; normalized to null here, same convention plank_seaport_fills already uses. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type DecodedLooksRareFill = {
  eventName: "TakerAsk" | "TakerBid";
  orderHash: string;
  orderNonce: string;
  seller: string;
  buyer: string;
  strategy: string;
  nftContract: string;
  tokenId: string;
  amount: string;
  currencyToken: string | null;
  priceWei: string;
};

/** Pure decode -- no I/O. Throws-safe: returns null on any non-matching/malformed log rather than throwing into the caller's scan loop. */
export function decodeLooksRareFill(topics: string[], data: string): DecodedLooksRareFill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || (parsed.name !== "TakerAsk" && parsed.name !== "TakerBid")) return null;

  const taker = (parsed.args.taker as string).toLowerCase();
  const maker = (parsed.args.maker as string).toLowerCase();
  const eventName = parsed.name as "TakerAsk" | "TakerBid";
  // TakerBid: taker took a resting ask -> taker is buyer, maker is seller.
  // TakerAsk: taker took a resting bid -> taker is seller, maker is buyer.
  const seller = eventName === "TakerBid" ? maker : taker;
  const buyer = eventName === "TakerBid" ? taker : maker;
  const currency = (parsed.args.currency as string).toLowerCase();

  return {
    eventName,
    orderHash: parsed.args.orderHash as string,
    orderNonce: (parsed.args.orderNonce as bigint).toString(),
    seller,
    buyer,
    strategy: (parsed.args.strategy as string).toLowerCase(),
    nftContract: (parsed.args.collection as string).toLowerCase(),
    tokenId: (parsed.args.tokenId as bigint).toString(),
    amount: (parsed.args.amount as bigint).toString(),
    currencyToken: currency === ZERO_ADDRESS ? null : currency,
    priceWei: (parsed.args.price as bigint).toString(),
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_looksrare_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_looksrare_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_looksrare_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type LooksRareFillRow = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  fill: DecodedLooksRareFill;
};

/** Idempotent insert, same (chain_slug, tx_hash, log_index) uniqueness contract as writeFills in seaport-fill-indexer.ts. Returns the count of genuinely NEW rows written. */
export async function writeLooksRareFills(rows: LooksRareFillRow[]): Promise<number> {
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
      `INSERT INTO plank_looksrare_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, order_hash, order_nonce, event_name, seller, buyer, strategy, nft_contract, token_id, amount, currency_token, price_wei)
       VALUES ($1, $2, $3, $4, to_timestamp($16), $5, $6::numeric, $7, $8, $9, $10, $11, $12::numeric, $13::numeric, $14, $15::numeric)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
      [
        r.chainSlug,
        r.txHash,
        r.logIndex,
        r.blockNumber,
        r.fill.orderHash,
        r.fill.orderNonce,
        r.fill.eventName,
        r.fill.seller,
        r.fill.buyer,
        r.fill.strategy,
        r.fill.nftContract,
        r.fill.tokenId,
        r.fill.amount,
        r.fill.currencyToken,
        r.fill.priceWei,
        r.blockTimestamp ?? null,
      ]
    );
    const isNew = (result.rowCount ?? 0) > 0;
    if (isNew && r.fill.nftContract) {
      await recordSaleEvent({ chainSlug: r.chainSlug, venue: "looksrare", protocol: "looksrare", collectionKey: r.fill.nftContract, tokenId: r.fill.tokenId != null ? String(r.fill.tokenId) : null, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockTimestamp: r.blockTimestamp ?? null, seller: r.fill.seller, buyer: r.fill.buyer, currencyToken: r.fill.currencyToken ?? null, priceWei: r.fill.priceWei != null ? String(r.fill.priceWei) : null, raw: { orderHash: r.fill.orderHash, strategy: r.fill.strategy } });
    }
    written += isNew ? 1 : 0;
    if (!isNew) continue;

    // Lossless per-leg mirror into the shared venue-generic tables, same
    // shape seaport-fill-indexer.ts's own writeFills already populates for
    // Seaport -- event_index reuses log_index (this app's own convention
    // for "which log within the tx", already established there).
    await postgresQuery(
      `INSERT INTO plank_market_event_assets
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, item_type, token_address, token_id, amount_atomic, recipient)
       VALUES ($1, 'looksrare', 'v1', $2, $3, $4, 0, $5, 2, $6, $7, $8::numeric, $9)
       ON CONFLICT DO NOTHING`,
      [
        r.chainSlug,
        LOOKSRARE_V1_ADDRESS,
        r.txHash,
        r.logIndex,
        r.fill.eventName === "TakerBid" ? "offer" : "consideration",
        r.fill.nftContract,
        r.fill.tokenId,
        r.fill.amount,
        r.fill.buyer,
      ]
    );
    await postgresQuery(
      `INSERT INTO plank_market_event_payments
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, token_address, amount_atomic, recipient, allocation_method)
       VALUES ($1, 'looksrare', 'v1', $2, $3, $4, 0, $5, $6, $7::numeric, $8, 'protocol-explicit')
       ON CONFLICT DO NOTHING`,
      [
        r.chainSlug,
        LOOKSRARE_V1_ADDRESS,
        r.txHash,
        r.logIndex,
        r.fill.eventName === "TakerBid" ? "consideration" : "offer",
        r.fill.currencyToken,
        r.fill.priceWei,
        r.fill.seller,
      ]
    );
  }
  await flushLedgerAggregation();
  return written;
}
