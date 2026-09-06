/**
 * Self-hosted, on-chain Foundation Market fill decode/write -- the SAME
 * real "why" as seaport-fill-indexer.ts's own header (Reservoir and
 * SimpleHash both shut down; this app builds its own first-party record
 * straight from the chain).
 *
 * REAL SOURCES, CITED (2026-08-23 research pass)
 * ---------------------------------------------------------------------------
 * Address 0xcDA72070E455bb31C7690a170224Ce43623d0B6f (FNDNFTMarket proxy,
 * eth-mainnet) -- Foundation's own official open-source repo
 * https://github.com/f8n/fnd-protocol, addresses.js, `prod[1].nftMarket`.
 * Cross-confirmed by Etherscan's own "Foundation: Market" label at the
 * identical address (independent search hit, 2026-08-23).
 *
 * Event signatures copied verbatim from the same repo,
 * contracts/mixins/nftMarket/NFTMarketBuyPrice.sol,
 * contracts/mixins/nftMarket/NFTMarketOffer.sol,
 * contracts/mixins/nftMarket/NFTMarketReserveAuction.sol -- see this
 * module's ABI below and deploy/inmotion/postgres/migrations/
 * 050_foundation_fill_index.sql for the full field-by-field citation.
 *
 * THREE REAL COMPLETED-SALE EVENTS, ONE NORMALIZED SHAPE
 * ---------------------------------------------------------------------------
 * BuyPriceAccepted (fixed-price buy), OfferAccepted (accepted standing
 * offer), and ReserveAuctionFinalized (24h reserve auction settlement) are
 * Foundation's three real, distinct "an NFT sale actually completed" events.
 * All three share the same totalFees/creatorRev/sellerRev fee-split shape,
 * which is why they land in one table (plank_foundation_fills) instead of
 * three, unlike LooksRare/Wyvern's one-table-per-protocol split -- these
 * are one protocol's three real sale mechanics, not three protocols.
 *
 * ReserveAuctionFinalized ONLY carries auctionId, not nftContract/tokenId/
 * price -- resolved via a genesis-forward auctionId lookup populated from
 * ReserveAuctionCreated (same contract, scanned in the same pass). See the
 * migration header for the exact honest-NULL fallback when a finalize log
 * is seen before its creation row.
 *
 * REUSES THE SAME LOSSLESS LEG TABLES SEAPORT/LOOKSRARE ALREADY WRITE TO
 * ---------------------------------------------------------------------------
 * plank_market_event_assets / plank_market_event_payments (migration 046)
 * are venue-generic -- reused here with venue_id = 'foundation'.
 */
import { Interface } from "ethers";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";
import { postgresQuery } from "@/lib/postgres";

export const FOUNDATION_MARKET_ADDRESS = "0xcda72070e455bb31c7690a170224ce43623d0b6f";
export const FOUNDATION_CHAIN_SLUG = "eth-mainnet";

const FOUNDATION_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "nftContract", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: false, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "uint256", name: "totalFees", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "creatorRev", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "sellerRev", type: "uint256" },
    ],
    name: "BuyPriceAccepted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "nftContract", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "address", name: "seller", type: "address" },
      { indexed: false, internalType: "uint256", name: "totalFees", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "creatorRev", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "sellerRev", type: "uint256" },
    ],
    name: "OfferAccepted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: true, internalType: "address", name: "nftContract", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "duration", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "extensionDuration", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "reservePrice", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "auctionId", type: "uint256" },
    ],
    name: "ReserveAuctionCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "auctionId", type: "uint256" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: true, internalType: "address", name: "bidder", type: "address" },
      { indexed: false, internalType: "uint256", name: "totalFees", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "creatorRev", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "sellerRev", type: "uint256" },
    ],
    name: "ReserveAuctionFinalized",
    type: "event",
  },
] as const;

const iface = new Interface(FOUNDATION_ABI);
export const BUY_PRICE_ACCEPTED_TOPIC = iface.getEvent("BuyPriceAccepted")!.topicHash;
export const OFFER_ACCEPTED_TOPIC = iface.getEvent("OfferAccepted")!.topicHash;
export const RESERVE_AUCTION_CREATED_TOPIC = iface.getEvent("ReserveAuctionCreated")!.topicHash;
export const RESERVE_AUCTION_FINALIZED_TOPIC = iface.getEvent("ReserveAuctionFinalized")!.topicHash;
export const FOUNDATION_TOPICS = [
  BUY_PRICE_ACCEPTED_TOPIC,
  OFFER_ACCEPTED_TOPIC,
  RESERVE_AUCTION_CREATED_TOPIC,
  RESERVE_AUCTION_FINALIZED_TOPIC,
];

export type DecodedFoundationEvent =
  | {
      kind: "fill";
      eventName: "BuyPriceAccepted" | "OfferAccepted";
      seller: string;
      buyer: string;
      nftContract: string;
      tokenId: string;
      totalFees: string;
      creatorRev: string;
      sellerRev: string;
    }
  | {
      kind: "auction-created";
      auctionId: string;
      seller: string;
      nftContract: string;
      tokenId: string;
      reservePrice: string;
    }
  | {
      kind: "auction-finalized";
      auctionId: string;
      seller: string;
      buyer: string;
      totalFees: string;
      creatorRev: string;
      sellerRev: string;
    };

/** Pure decode -- no I/O. Throws-safe: returns null on any non-matching/malformed log. */
export function decodeFoundationEvent(topics: string[], data: string): DecodedFoundationEvent | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed) return null;

  if (parsed.name === "BuyPriceAccepted" || parsed.name === "OfferAccepted") {
    return {
      kind: "fill",
      eventName: parsed.name,
      seller: (parsed.args.seller as string).toLowerCase(),
      buyer: (parsed.args.buyer as string).toLowerCase(),
      nftContract: (parsed.args.nftContract as string).toLowerCase(),
      tokenId: (parsed.args.tokenId as bigint).toString(),
      totalFees: (parsed.args.totalFees as bigint).toString(),
      creatorRev: (parsed.args.creatorRev as bigint).toString(),
      sellerRev: (parsed.args.sellerRev as bigint).toString(),
    };
  }
  if (parsed.name === "ReserveAuctionCreated") {
    return {
      kind: "auction-created",
      auctionId: (parsed.args.auctionId as bigint).toString(),
      seller: (parsed.args.seller as string).toLowerCase(),
      nftContract: (parsed.args.nftContract as string).toLowerCase(),
      tokenId: (parsed.args.tokenId as bigint).toString(),
      reservePrice: (parsed.args.reservePrice as bigint).toString(),
    };
  }
  if (parsed.name === "ReserveAuctionFinalized") {
    return {
      kind: "auction-finalized",
      auctionId: (parsed.args.auctionId as bigint).toString(),
      seller: (parsed.args.seller as string).toLowerCase(),
      buyer: (parsed.args.bidder as string).toLowerCase(),
      totalFees: (parsed.args.totalFees as bigint).toString(),
      creatorRev: (parsed.args.creatorRev as bigint).toString(),
      sellerRev: (parsed.args.sellerRev as bigint).toString(),
    };
  }
  return null;
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_foundation_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_foundation_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_foundation_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type FoundationLogRow = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  decoded: DecodedFoundationEvent;
};

/** Idempotent insert. ReserveAuctionCreated rows populate the lookup table only (no fill row); the other three event kinds each produce one fill row. Returns the count of genuinely NEW fill rows written. */
export async function writeFoundationEvents(rows: FoundationLogRow[]): Promise<number> {
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.chainSlug}:${r.txHash}:${r.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let written = 0;
  for (const r of deduped) {
    if (r.decoded.kind === "auction-created") {
      await postgresQuery(
        `INSERT INTO plank_foundation_auction_lookup (auction_id, chain_slug, nft_contract, token_id, seller, reserve_price)
         VALUES ($1::numeric, $2, $3, $4::numeric, $5, $6::numeric)
         ON CONFLICT (auction_id) DO NOTHING`,
        [r.decoded.auctionId, r.chainSlug, r.decoded.nftContract, r.decoded.tokenId, r.decoded.seller, r.decoded.reservePrice]
      );
      continue;
    }

    let eventName: "BuyPriceAccepted" | "OfferAccepted" | "ReserveAuctionFinalized";
    let seller: string;
    let buyer: string;
    let nftContract: string | null;
    let tokenId: string | null;
    let auctionId: string | null = null;

    if (r.decoded.kind === "fill") {
      eventName = r.decoded.eventName;
      seller = r.decoded.seller;
      buyer = r.decoded.buyer;
      nftContract = r.decoded.nftContract;
      tokenId = r.decoded.tokenId;
    } else {
      eventName = "ReserveAuctionFinalized";
      seller = r.decoded.seller;
      buyer = r.decoded.buyer;
      auctionId = r.decoded.auctionId;
      const lookup = await postgresQuery<{ nft_contract: string; token_id: string }>(
        `SELECT nft_contract, token_id FROM plank_foundation_auction_lookup WHERE auction_id = $1::numeric`,
        [auctionId]
      );
      nftContract = lookup.rows[0]?.nft_contract ?? null;
      tokenId = lookup.rows[0]?.token_id ?? null;
    }

    const totalFees = r.decoded.kind === "fill" ? r.decoded.totalFees : r.decoded.totalFees;
    const creatorRev = r.decoded.kind === "fill" ? r.decoded.creatorRev : r.decoded.creatorRev;
    const sellerRev = r.decoded.kind === "fill" ? r.decoded.sellerRev : r.decoded.sellerRev;
    const priceWei = (BigInt(totalFees) + BigInt(creatorRev) + BigInt(sellerRev)).toString();

    const result = await postgresQuery(
      `INSERT INTO plank_foundation_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, event_name, auction_id, seller, buyer, nft_contract, token_id, total_fees, creator_rev, seller_rev, price_wei)
       VALUES ($1, $2, $3, $4, to_timestamp($15), $5, $6::numeric, $7, $8, $9, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
      [
        r.chainSlug,
        r.txHash,
        r.logIndex,
        r.blockNumber,
        eventName,
        auctionId,
        seller,
        buyer,
        nftContract,
        tokenId,
        totalFees,
        creatorRev,
        sellerRev,
        priceWei,
        r.blockTimestamp ?? null,
      ]
    );
    const isNew = (result.rowCount ?? 0) > 0;
    if (isNew && nftContract && priceWei != null) {
      await recordSaleEvent({ chainSlug: r.chainSlug, venue: "foundation", protocol: "foundation", collectionKey: String(nftContract), tokenId: tokenId != null ? String(tokenId) : null, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockTimestamp: r.blockTimestamp ?? null, seller: seller ?? null, buyer: buyer ?? null, currencyToken: null, priceWei: String(priceWei), raw: { eventName, auctionId } });
    }
    written += isNew ? 1 : 0;
    if (!isNew || !nftContract || !tokenId) continue;

    await postgresQuery(
      `INSERT INTO plank_market_event_assets
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, item_type, token_address, token_id, amount_atomic, recipient)
       VALUES ($1, 'foundation', 'v2', $2, $3, $4, 0, 'offer', 2, $5, $6, '1', $7)
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, FOUNDATION_MARKET_ADDRESS, r.txHash, r.logIndex, nftContract, tokenId, buyer]
    );
    await postgresQuery(
      `INSERT INTO plank_market_event_payments
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, token_address, amount_atomic, recipient, allocation_method)
       VALUES ($1, 'foundation', 'v2', $2, $3, $4, 0, 'consideration', NULL, $5::numeric, $6, 'protocol-explicit')
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, FOUNDATION_MARKET_ADDRESS, r.txHash, r.logIndex, priceWei, seller]
    );
  }
  await flushLedgerAggregation();
  return written;
}
