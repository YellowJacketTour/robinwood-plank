/**
 * Self-hosted, on-chain Wyvern Exchange OrdersMatched fill decode/write --
 * the shared plumbing hypersync-wyvern-scan.ts's HyperSync fetch loop feeds
 * into, same split as seaport-fill-indexer.ts/hypersync-seaport-scan.ts
 * (decode + write here, fetch there).
 *
 * REAL EVENT SIGNATURE, REAL SOURCE
 * ------------------------------------------------------------------
 * `event OrdersMatched(bytes32 buyHash, bytes32 sellHash, address indexed
 * maker, address indexed taker, uint256 price, bytes32 indexed metadata)`
 * -- ProjectWyvern/wyvern-ethereum, contracts/exchange/ExchangeCore.sol
 * (https://github.com/ProjectWyvern/wyvern-ethereum/blob/master/contracts/exchange/ExchangeCore.sol),
 * the same ExchangeCore both the v1 (0x7Be8...) and v2/bulk-cancellations
 * (0x7f26...) deployments compile from. See wyvern-deployments.ts for the
 * real, independently-verified deployment blocks.
 *
 * HONEST LIMITATION (see 048_wyvern_fill_index.sql's own header for the
 * full reasoning): OrdersMatched carries maker, taker, price, and the two
 * order hashes, but NOT the traded NFT contract/token id -- that lives
 * only inside atomicMatch_'s calldata, which this indexer does not decode.
 * Every row here is a real, confirmed on-chain trade; nft_contract/token_id
 * are left NULL rather than guessed.
 */
import { Interface } from "ethers";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import { wyvernVersionForAddress } from "@/lib/market/multichain/wyvern-deployments";

const ORDERS_MATCHED_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "buyHash", type: "bytes32" },
      { indexed: false, internalType: "bytes32", name: "sellHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "maker", type: "address" },
      { indexed: true, internalType: "address", name: "taker", type: "address" },
      { indexed: false, internalType: "uint256", name: "price", type: "uint256" },
      { indexed: true, internalType: "bytes32", name: "metadata", type: "bytes32" },
    ],
    name: "OrdersMatched",
    type: "event",
  },
] as const;

const iface = new Interface(ORDERS_MATCHED_ABI);
export const ORDERS_MATCHED_TOPIC = iface.getEvent("OrdersMatched")!.topicHash;

export type DecodedWyvernFill = {
  buyHash: string;
  sellHash: string;
  maker: string;
  taker: string;
  priceWei: string;
  metadata: string;
};

/**
 * Pure decode -- no I/O. Mirrors decodeOrderFulfilled's own try/catch
 * shape (seaport-fill-indexer.ts): a log that fails to parse against this
 * exact ABI returns null rather than throwing, so one malformed/unrelated
 * log can never abort a whole scan window.
 */
export function decodeOrdersMatched(topics: string[], data: string): DecodedWyvernFill | null {
  let parsed;
  try {
    parsed = iface.parseLog({ topics, data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "OrdersMatched") return null;

  return {
    buyHash: parsed.args.buyHash as string,
    sellHash: parsed.args.sellHash as string,
    maker: (parsed.args.maker as string).toLowerCase(),
    taker: (parsed.args.taker as string).toLowerCase(),
    priceWei: (parsed.args.price as bigint).toString(),
    metadata: parsed.args.metadata as string,
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_wyvern_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_wyvern_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_wyvern_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type WyvernFillScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  fillsWritten: number;
  error?: string;
};

export async function writeWyvernFills(
  rows: {
    chainSlug: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockTimestamp?: number | null;
    deploymentAddress?: string | null;
    fill: DecodedWyvernFill;
  }[]
): Promise<number> {
  // Dedupe within-batch -- same reason writeFills does (ON CONFLICT DO
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
    const result = await withPostgresTransaction((client) =>
      client.query(
        `INSERT INTO plank_wyvern_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, deployment_address, protocol_version, buy_hash, sell_hash, maker, taker, price_wei, metadata)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10, $11, $12::numeric, $13)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
        [
          r.chainSlug,
          r.txHash,
          r.logIndex,
          r.blockNumber,
          r.blockTimestamp ?? null,
          r.deploymentAddress ?? null,
          r.deploymentAddress ? wyvernVersionForAddress(r.deploymentAddress) : null,
          r.fill.buyHash,
          r.fill.sellHash,
          r.fill.maker,
          r.fill.taker,
          r.fill.priceWei,
          r.fill.metadata,
        ]
      )
    );
    written += (result.rowCount ?? 0) > 0 ? 1 : 0;
  }
  return written;
}
