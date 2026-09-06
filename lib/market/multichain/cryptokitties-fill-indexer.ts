/**
 * Self-hosted, on-chain CryptoKitties SaleClockAuction/SiringClockAuction
 * AuctionSuccessful fill decode/write -- same split as
 * wyvern-fill-indexer.ts/hypersync-wyvern-scan.ts (decode + write here,
 * fetch there), targeting CryptoKitties' own PRE-Wyvern native auction
 * houses (2017-11 launch, over half a year before Wyvern's 2018 debut) --
 * this history would otherwise be permanently invisible to every
 * Seaport/Wyvern/LooksRare/etc. fill-indexer this app runs, since none of
 * them existed yet.
 *
 * REAL EVENT SIGNATURE, REAL SOURCE
 * ------------------------------------------------------------------
 * `event AuctionSuccessful(uint256 tokenId, uint256 totalPrice, address
 * winner)` -- dapperlabs/cryptokitties-bounty, contracts/Auction/
 * ClockAuctionBase.sol (https://github.com/dapperlabs/cryptokitties-bounty/blob/master/contracts/Auction/ClockAuctionBase.sol).
 * Both SaleClockAuction and SiringClockAuction inherit this exact event
 * unmodified -- see cryptokitties-deployments.ts for the real, cross-checked
 * deployment addresses this indexer scans.
 *
 * HONEST LIMITATION (same shape as plank_wyvern_fills's own header):
 * AuctionSuccessful carries the kitty id, the winning bid, and the winner,
 * but NOT the seller -- unlike Seaport's OrderFulfilled. Recovering the
 * seller would require decoding the AuctionCreated event from the same
 * auction and joining it to the matching AuctionSuccessful/AuctionCancelled
 * by tokenId, a materially larger undertaking this indexer does not
 * attempt. Every row here is a real, confirmed on-chain trade at a real
 * settled price; seller is left NULL rather than guessed.
 *
 * A siring-auction fill is also honestly NOT an ownership transfer -- the
 * "winner" pays to breed with the kitty, they do not receive it. It is real
 * priced on-chain activity for the collection (and CryptoKitties' own siring
 * market was economically significant), so it is recorded here with
 * auction_kind='siring' rather than dropped, but readers that treat every
 * row as a transfer must filter on auction_kind='sale' first.
 */
import { Interface } from "ethers";
import { recordSaleEvent, flushLedgerAggregation } from "@/lib/market/multichain/ledger-sink";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import { cryptoKittiesAuctionKindForAddress, KITTY_CORE_ADDRESS } from "@/lib/market/multichain/cryptokitties-deployments";

const AUCTION_SUCCESSFUL_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "totalPrice", type: "uint256" },
      { indexed: false, internalType: "address", name: "winner", type: "address" },
    ],
    name: "AuctionSuccessful",
    type: "event",
  },
] as const;

const iface = new Interface(AUCTION_SUCCESSFUL_ABI);
export const AUCTION_SUCCESSFUL_TOPIC = iface.getEvent("AuctionSuccessful")!.topicHash;

export type DecodedCryptoKittiesFill = {
  tokenId: string;
  totalPriceWei: string;
  winner: string;
};

/**
 * Pure decode -- no I/O. Same try/catch shape as decodeOrdersMatched: a log
 * that fails to parse against this exact ABI returns null rather than
 * throwing, so one malformed/unrelated log can never abort a whole scan
 * window.
 */
export function decodeAuctionSuccessful(topics: string[], data: string): DecodedCryptoKittiesFill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "AuctionSuccessful") return null;

  return {
    tokenId: (parsed.args.tokenId as bigint).toString(),
    totalPriceWei: (parsed.args.totalPrice as bigint).toString(),
    winner: (parsed.args.winner as string).toLowerCase(),
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_cryptokitties_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_cryptokitties_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_cryptokitties_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type CryptoKittiesFillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  error?: string;
};

export async function writeCryptoKittiesFills(
  rows: {
    chainSlug: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockTimestamp?: number | null;
    deploymentAddress: string;
    fill: DecodedCryptoKittiesFill;
  }[]
): Promise<number> {
  // Dedupe within-batch -- same reason writeWyvernFills does (ON CONFLICT DO
  // NOTHING rejects two conflicting rows inside one statement).
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.chainSlug}:${r.txHash}:${r.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let written = 0;
  for (const r of deduped) {
    const auctionKind = cryptoKittiesAuctionKindForAddress(r.deploymentAddress);
    if (!auctionKind) continue; // defensive -- only our two known addresses are ever scanned
    const result = await withPostgresTransaction((client) =>
      client.query(
        `INSERT INTO plank_cryptokitties_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, deployment_address, auction_kind, nft_contract, token_id, winner, total_price_wei)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9::numeric, $10, $11::numeric)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
        [
          r.chainSlug,
          r.txHash,
          r.logIndex,
          r.blockNumber,
          r.blockTimestamp ?? null,
          r.deploymentAddress.toLowerCase(),
          auctionKind,
          KITTY_CORE_ADDRESS,
          r.fill.tokenId,
          r.fill.winner,
          r.fill.totalPriceWei,
        ]
      )
    );
    written += (result.rowCount ?? 0) > 0 ? 1 : 0;
    if ((result.rowCount ?? 0) > 0) {
      await recordSaleEvent({ chainSlug: r.chainSlug, venue: "cryptokitties", protocol: "cryptokitties-auction", collectionKey: KITTY_CORE_ADDRESS, tokenId: r.fill.tokenId != null ? String(r.fill.tokenId) : null, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, blockTimestamp: r.blockTimestamp ?? null, seller: null, buyer: r.fill.winner, currencyToken: null, priceWei: r.fill.totalPriceWei != null ? String(r.fill.totalPriceWei) : null, raw: { auctionKind } });
    }
  }
  await flushLedgerAggregation();
  return written;
}
