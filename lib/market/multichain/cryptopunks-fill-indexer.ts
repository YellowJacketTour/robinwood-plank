/**
 * CryptoPunks market fills: decode + write. The HyperSync fetch loop lives
 * in discovery/hypersync-cryptopunks-scan.ts, the same decode-here /
 * fetch-there split as wyvern-fill-indexer.ts and
 * cryptokitties-fill-indexer.ts.
 *
 * REAL EVENTS, REAL SOURCE
 * ------------------------------------------------------------------
 * larvalabs/cryptopunks, contracts/CryptoPunksMarket.sol (the source
 * verified on Etherscan for 0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB):
 *
 *   event PunkBought(uint indexed punkIndex, uint value, address indexed fromAddress, address indexed toAddress);
 *   event PunkBidEntered(uint indexed punkIndex, uint value, address indexed fromAddress);
 *
 * THE acceptBidForPunk QUIRK, confirmed in that source: it takes a storage
 * reference to the bid, clears `punkBids[punkIndex]`, and only THEN emits
 * PunkBought -- so on that path the event carries value = 0 and
 * toAddress = 0x0. The real price and buyer are the latest PunkBidEntered
 * for that index before the sale. A 0-value PunkBought is therefore never
 * written as a 0-price sale: it is resolved through the bid (sale_kind
 * 'accept-bid', with the bid's tx/log recorded as provenance) or, if no
 * bid can be found, skipped and counted as unresolved -- an honest hole,
 * not a free Punk.
 *
 * Topic hashes are derived from the ABI by ethers and pinned in the test
 * against the values computed independently (keccak of the canonical
 * signatures), so a typo in the ABI cannot silently index nothing.
 */
import { Interface } from "ethers";
import { withPostgresTransaction } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";

export const CRYPTOPUNKS_MARKET_ADDRESS = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
/** The market contract was created in June 2017 (block 3,914,495). A
 * conservative floor, honestly below it, like CRYPTOKITTIES_GENESIS_BLOCK. */
export const CRYPTOPUNKS_GENESIS_BLOCK = 3_900_000;

const MARKET_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "punkIndex", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
      { indexed: true, internalType: "address", name: "fromAddress", type: "address" },
      { indexed: true, internalType: "address", name: "toAddress", type: "address" },
    ],
    name: "PunkBought",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "punkIndex", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
      { indexed: true, internalType: "address", name: "fromAddress", type: "address" },
    ],
    name: "PunkBidEntered",
    type: "event",
  },
] as const;

const iface = new Interface(MARKET_ABI);
export const PUNK_BOUGHT_TOPIC = iface.getEvent("PunkBought")!.topicHash;
export const PUNK_BID_ENTERED_TOPIC = iface.getEvent("PunkBidEntered")!.topicHash;

export type DecodedPunkBought = {
  punkIndex: string;
  valueWei: string;
  from: string;
  to: string;
};

export type DecodedPunkBid = {
  punkIndex: string;
  valueWei: string;
  bidder: string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Pure decode -- a log that is not this exact event returns null. */
export function decodePunkBought(topics: string[], data: string): DecodedPunkBought | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "PunkBought") return null;
  return {
    punkIndex: (parsed.args.punkIndex as bigint).toString(),
    valueWei: (parsed.args.value as bigint).toString(),
    from: (parsed.args.fromAddress as string).toLowerCase(),
    to: (parsed.args.toAddress as string).toLowerCase(),
  };
}

export function decodePunkBidEntered(topics: string[], data: string): DecodedPunkBid | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "PunkBidEntered") return null;
  return {
    punkIndex: (parsed.args.punkIndex as bigint).toString(),
    valueWei: (parsed.args.value as bigint).toString(),
    bidder: (parsed.args.fromAddress as string).toLowerCase(),
  };
}

export type PunkBoughtLog = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  bought: DecodedPunkBought;
};

export type ResolvedPunkSale = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  punkIndex: string;
  seller: string;
  buyer: string;
  priceWei: string;
  saleKind: "buy" | "accept-bid";
  bidTxHash: string | null;
  bidLogIndex: number | null;
};

/** The latest PunkBidEntered for an index strictly before (block, logIndex). */
export type AcceptedBidResolver = (punkIndex: string, beforeBlock: number, beforeLogIndex: number) => Promise<{ bid: DecodedPunkBid; txHash: string; logIndex: number } | null>;

/**
 * Pure orchestration, resolver injected: a PunkBought with a real value is
 * a 'buy'; one with value 0 (the acceptBid path) is resolved through the
 * latest prior bid or dropped as unresolved. Never a 0-price sale.
 */
export async function resolvePunkSales(
  logs: PunkBoughtLog[],
  resolveAcceptedBid: AcceptedBidResolver,
): Promise<{ sales: ResolvedPunkSale[]; unresolved: PunkBoughtLog[] }> {
  const sales: ResolvedPunkSale[] = [];
  const unresolved: PunkBoughtLog[] = [];
  for (const log of logs) {
    const base = { chainSlug: log.chainSlug, txHash: log.txHash, logIndex: log.logIndex, blockNumber: log.blockNumber, blockTimestamp: log.blockTimestamp, punkIndex: log.bought.punkIndex, seller: log.bought.from };
    if (log.bought.valueWei !== "0" && log.bought.to !== ZERO_ADDRESS) {
      sales.push({ ...base, buyer: log.bought.to, priceWei: log.bought.valueWei, saleKind: "buy", bidTxHash: null, bidLogIndex: null });
      continue;
    }
    const found = await resolveAcceptedBid(log.bought.punkIndex, log.blockNumber, log.logIndex);
    if (!found || found.bid.valueWei === "0") {
      unresolved.push(log);
      continue;
    }
    sales.push({ ...base, buyer: found.bid.bidder, priceWei: found.bid.valueWei, saleKind: "accept-bid", bidTxHash: found.txHash, bidLogIndex: found.logIndex });
  }
  return { sales, unresolved };
}

/** Cursor in the durable KV: no new table, same GREATEST semantics as the fill cursors. */
export async function readCursor(cursorKey: string): Promise<number | null> {
  const value = await durableKv.get<number>(`cryptopunks-fill-cursor:${cursorKey}`);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  const current = await readCursor(cursorKey);
  if (current != null && current >= block) return;
  await durableKv.set(`cryptopunks-fill-cursor:${cursorKey}`, block);
}

export type CryptoPunksFillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  unresolvedAcceptBids: number;
  error?: string;
};

export async function writeCryptoPunksFills(rows: ResolvedPunkSale[]): Promise<number> {
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
        `INSERT INTO plank_cryptopunks_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, nft_contract, token_id, seller, buyer, price_wei, sale_kind, bid_log_index, bid_tx_hash)
         VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7::numeric, $8, $9, $10::numeric, $11, $12, $13)
         ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
        [r.chainSlug, r.txHash, r.logIndex, r.blockNumber, r.blockTimestamp, CRYPTOPUNKS_MARKET_ADDRESS, r.punkIndex, r.seller, r.buyer, r.priceWei, r.saleKind, r.bidLogIndex, r.bidTxHash]
      )
    );
    if ((result.rowCount ?? 0) > 0) {
      written += 1;
      // Same mirror the other fill ledgers keep: the sale reaches
      // plank_market_events so the collection's volume/sales stats derive
      // from it like every other venue's.
      await recordSaleEvent({
        chainSlug: r.chainSlug,
        venue: "cryptopunks",
        protocol: "cryptopunks-market",
        collectionKey: CRYPTOPUNKS_MARKET_ADDRESS,
        tokenId: r.punkIndex,
        txHash: r.txHash,
        logIndex: r.logIndex,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
        seller: r.seller,
        buyer: r.buyer,
        currencyToken: null,
        priceWei: r.priceWei,
        raw: { saleKind: r.saleKind, bidTxHash: r.bidTxHash, bidLogIndex: r.bidLogIndex },
      });
    }
  }
  await flushLedgerAggregation();
  return written;
}
