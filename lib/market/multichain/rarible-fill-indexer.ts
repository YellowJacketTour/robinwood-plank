/**
 * Self-hosted, on-chain Rarible ExchangeV2 matchOrders fill decode/write --
 * the SAME real "why" as seaport-fill-indexer.ts's own header, applied to
 * the venue this app's own venue-registry.ts previously left `planned` as a
 * real, evidenced blocker (see its `rarible` entry, now updated in this
 * pass).
 *
 * REAL SOURCES, CITED (2026-08-23 research pass)
 * ---------------------------------------------------------------------------
 * ExchangeV2 0x9757F2d2b135150BBeb65308D4a91804107cd8D6 (eth-mainnet) --
 * Rarible's own docs, docs.rarible.org/reference/contract-addresses, same
 * address venue-registry.ts already cited. Fetched verbatim from Rarible's
 * own repo, https://github.com/rarible/protocol-contracts,
 * projects/exchange-v2/contracts/ExchangeV2Core.sol:
 *
 *   event Match(bytes32 leftHash, bytes32 rightHash, uint newLeftFill, uint newRightFill);
 *   function matchOrders(LibOrder.Order orderLeft, bytes signatureLeft,
 *     LibOrder.Order orderRight, bytes signatureRight) external payable;
 *
 * Confirmed by exact line match: Match carries only two order hashes and two
 * fill amounts -- no nftContract/tokenId/price/party fields. Real asset and
 * party data lives entirely in matchOrders' own calldata, which DOES carry
 * two full LibOrder.Order structs (maker, makeAsset, taker, takeAsset, ...),
 * confirmed against LibOrder.sol / LibAsset.sol (both in the same repo).
 *
 * THE REAL TECHNIQUE: CALLDATA DECODE, NOT RECEIPT CORRELATION
 * ---------------------------------------------------------------------------
 * Unlike Sudoswap (see sudoswap-fill-indexer.ts), Rarible's real asset
 * identity (maker/taker, NFT contract+tokenId, currency+amount) is fully
 * present in the transaction's own input data -- matchOrders is a plain
 * external function taking explicit struct arguments, not an ID-agnostic
 * "give me any N" call. This module ABI-decodes `matchOrders`'s real input
 * using the exact tuple shape above, confirmed field-by-field against
 * LibOrder.sol/LibAsset.sol, cross-checked against the REAL asset-data
 * encoding TransferExecutor.sol actually uses at execution time
 * (projects/transfer-manager/contracts/TransferExecutor.sol,
 * function `transfer`): ERC721/ERC1155 assetType.data ==
 * abi.encode(address token, uint256 tokenId); ERC20 assetType.data ==
 * abi.encode(address token); ETH assetType.data is unused/empty. This is the
 * real function's own real argument encoding, not guessed.
 *
 * WHICH ORDER IS THE SELLER, WHICH IS THE PRICE
 * ---------------------------------------------------------------------------
 * Whichever of orderLeft/orderRight has an ERC721/ERC1155 `makeAsset` is the
 * seller's order (real: they are giving up the NFT). The other order's
 * `makeAsset` (ETH/ERC20) is the real buyer-side payment amount actually
 * offered -- preferred over the seller's mirrored `takeAsset.value` when
 * both are present, since the buyer's own makeAsset.value is what they are
 * really committing.
 *
 * HONEST, STATED LIMITATION -- PARTIAL FILLS NOT CROSS-VALIDATED
 * ---------------------------------------------------------------------------
 * The real, final settled amount for a PARTIAL fill against an order-book-
 * style order is only in the Match event's own newLeftFill/newRightFill
 * (fill-unit accounting that depends on the order's own isMakeFill
 * direction, itself calldata-dependent) -- this pass reads the calldata-
 * declared value on each order's asset as the price, which is correct for
 * the overwhelmingly common case (buy-now / single-fill listing execution,
 * Rarible's real dominant usage pattern) but would silently misreport a
 * genuine partial fill against a resting order-book order. Not cross-
 * validated against newLeftFill/newRightFill this pass -- a real, stated
 * limitation, not a silent wrong decode.
 *
 * ASSET CLASSES LEFT UNDECODED, HONESTLY
 * ---------------------------------------------------------------------------
 * LibAsset.sol also defines COLLECTION and CRYPTO_PUNKS asset classes (a
 * collection-wide offer resolved to a specific token off-chain, and a
 * CryptoPunks-specific wrapper). Neither is ERC721/ERC1155/ERC20/ETH, and
 * this pass did not verify their real data encodings against source --
 * matches whose NFT-side asset class is one of these are decoded as far as
 * maker/taker/order hashes go but leave nft_contract/token_id NULL rather
 * than guess the encoding.
 *
 * REUSES THE SAME LOSSLESS LEG TABLES OTHER VENUES ALREADY WRITE TO
 * ---------------------------------------------------------------------------
 * plank_market_event_assets / plank_market_event_payments (migration 046)
 * are venue-generic -- reused here with venue_id = 'rarible'.
 */
import { Interface, AbiCoder, id as keccakId } from "ethers";
import { postgresQuery } from "@/lib/postgres";

export const RARIBLE_EXCHANGE_V2_ADDRESS = "0x9757f2d2b135150bbeb65308d4a91804107cd8d6";
export const RARIBLE_CHAIN_SLUG = "eth-mainnet";

const MATCH_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "leftHash", type: "bytes32" },
      { indexed: false, internalType: "bytes32", name: "rightHash", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "newLeftFill", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newRightFill", type: "uint256" },
    ],
    name: "Match",
    type: "event",
  },
] as const;
const matchIface = new Interface(MATCH_EVENT_ABI);
export const MATCH_TOPIC = matchIface.getEvent("Match")!.topicHash;
export const RARIBLE_TOPICS = [MATCH_TOPIC];

// LibOrder.Order / LibAsset.Asset / LibAsset.AssetType, verbatim shape from
// LibOrder.sol / LibAsset.sol (both cited above).
const ASSET_TYPE_TUPLE = "tuple(bytes4 assetClass, bytes data)";
const ASSET_TUPLE = `tuple(${ASSET_TYPE_TUPLE} assetType, uint256 value)`;
const ORDER_TUPLE = `tuple(address maker, ${ASSET_TUPLE} makeAsset, address taker, ${ASSET_TUPLE} takeAsset, uint256 salt, uint256 start, uint256 end, bytes4 dataType, bytes data)`;

const MATCH_ORDERS_ABI = [
  `function matchOrders(${ORDER_TUPLE} orderLeft, bytes signatureLeft, ${ORDER_TUPLE} orderRight, bytes signatureRight) payable`,
];
const matchOrdersIface = new Interface(MATCH_ORDERS_ABI);
export const MATCH_ORDERS_SIGHASH = matchOrdersIface.getFunction("matchOrders")!.selector;

const abiCoder = AbiCoder.defaultAbiCoder();

// bytes4(keccak256(...)) asset-class constants, verbatim from LibAsset.sol.
const ETH_ASSET_CLASS = keccakId("ETH").slice(0, 10);
const ERC20_ASSET_CLASS = keccakId("ERC20").slice(0, 10);
const ERC721_ASSET_CLASS = keccakId("ERC721").slice(0, 10);
const ERC1155_ASSET_CLASS = keccakId("ERC1155").slice(0, 10);

type DecodedAsset = { assetClass: string; data: string; value: bigint };
type DecodedOrder = { maker: string; makeAsset: DecodedAsset; taker: string; takeAsset: DecodedAsset };

export type DecodedRaribleMatch = {
  leftHash: string;
  rightHash: string;
  seller: string;
  buyer: string;
  nftContract: string | null;
  tokenId: string | null;
  nftAmount: string;
  currencyToken: string | null; // null = ETH
  priceWei: string | null;
  undecodedAssetClass: string | null; // set when the NFT-side asset class was neither ERC721 nor ERC1155
};

function decodeOrderTuple(t: unknown): DecodedOrder {
  const arr = t as [string, [[string, string], bigint], string, [[string, string], bigint], bigint, bigint, bigint, string, string];
  const [maker, makeAsset, taker, takeAsset] = arr;
  return {
    maker: (maker as string).toLowerCase(),
    makeAsset: { assetClass: makeAsset[0][0], data: makeAsset[0][1], value: makeAsset[1] },
    taker: (taker as string).toLowerCase(),
    takeAsset: { assetClass: takeAsset[0][0], data: takeAsset[0][1], value: takeAsset[1] },
  };
}

function isNftClass(assetClass: string): boolean {
  return assetClass === ERC721_ASSET_CLASS || assetClass === ERC1155_ASSET_CLASS;
}
function isPaymentClass(assetClass: string): boolean {
  return assetClass === ETH_ASSET_CLASS || assetClass === ERC20_ASSET_CLASS;
}

/** Pure decode -- no I/O. Takes the Match log's own topics/data (to recover leftHash/rightHash for correlation/audit) plus the transaction's real calldata. Returns null on any non-matching/malformed input rather than throwing. */
export function decodeRaribleMatch(logTopics: string[], logData: string, txInput: string): DecodedRaribleMatch | null {
  let parsedLog;
  try {
    parsedLog = matchIface.parseLog({ topics: logTopics, data: logData });
  } catch {
    return null;
  }
  if (!parsedLog || parsedLog.name !== "Match") return null;

  if (!txInput || txInput.length < 10 || txInput.slice(0, 10).toLowerCase() !== MATCH_ORDERS_SIGHASH.toLowerCase()) {
    // Not a matchOrders call -- directPurchase() and other ExchangeV2Core
    // entry points also emit Match but use a materially different calldata
    // shape (LibDirectTransfer.Purchase, a flat struct) not decoded by this
    // pass. Left undecoded rather than guessed; see module header.
    return null;
  }

  let decodedArgs;
  try {
    decodedArgs = matchOrdersIface.decodeFunctionData("matchOrders", txInput);
  } catch {
    return null;
  }

  const orderLeft = decodeOrderTuple(decodedArgs[0]);
  const orderRight = decodeOrderTuple(decodedArgs[2]);

  const sellerOrder = isNftClass(orderLeft.makeAsset.assetClass) ? orderLeft : isNftClass(orderRight.makeAsset.assetClass) ? orderRight : null;
  const buyerOrder = isPaymentClass(orderLeft.makeAsset.assetClass) ? orderLeft : isPaymentClass(orderRight.makeAsset.assetClass) ? orderRight : null;
  if (!sellerOrder && !buyerOrder) return null; // neither side recognizable -- do not fabricate

  const seller = sellerOrder ? sellerOrder.maker : buyerOrder!.taker;
  const buyer = buyerOrder ? buyerOrder.maker : sellerOrder!.taker;

  const nftAsset = sellerOrder ? sellerOrder.makeAsset : buyerOrder!.takeAsset;
  let nftContract: string | null = null;
  let tokenId: string | null = null;
  let undecodedAssetClass: string | null = null;
  if (isNftClass(nftAsset.assetClass)) {
    try {
      const decoded = abiCoder.decode(["address", "uint256"], nftAsset.data);
      const token = decoded[0] as string;
      const id = decoded[1] as bigint;
      nftContract = token.toLowerCase();
      tokenId = id.toString();
    } catch {
      /* leave null -- malformed data, do not guess */
    }
  } else if (nftAsset.assetClass !== "0x00000000") {
    undecodedAssetClass = nftAsset.assetClass;
  }
  const nftAmount = nftAsset.value.toString();

  const paymentAsset = buyerOrder ? buyerOrder.makeAsset : sellerOrder!.takeAsset;
  let currencyToken: string | null = null;
  let priceWei: string | null = null;
  if (paymentAsset.assetClass === ETH_ASSET_CLASS) {
    currencyToken = null;
    priceWei = paymentAsset.value.toString();
  } else if (paymentAsset.assetClass === ERC20_ASSET_CLASS) {
    try {
      const decoded = abiCoder.decode(["address"], paymentAsset.data);
      const token = decoded[0] as string;
      currencyToken = token.toLowerCase();
      priceWei = paymentAsset.value.toString();
    } catch {
      /* leave null -- malformed data, do not guess */
    }
  }

  return {
    leftHash: parsedLog.args.leftHash as string,
    rightHash: parsedLog.args.rightHash as string,
    seller,
    buyer,
    nftContract,
    tokenId,
    nftAmount,
    currencyToken,
    priceWei,
    undecodedAssetClass,
  };
}

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ last_indexed_block: string }>(
    `SELECT last_indexed_block FROM plank_rarible_fill_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].last_indexed_block) : null;
}

export async function writeCursor(cursorKey: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_rarible_fill_cursor (cursor_key, last_indexed_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET last_indexed_block = GREATEST(plank_rarible_fill_cursor.last_indexed_block, EXCLUDED.last_indexed_block), updated_at = NOW()`,
    [cursorKey, block]
  );
}

export type RaribleFillRow = {
  chainSlug: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
  match: DecodedRaribleMatch;
};

/** Idempotent insert, same (chain_slug, tx_hash, log_index) uniqueness contract as every other venue's fill writer. Returns the count of genuinely NEW rows written. */
export async function writeRaribleFills(rows: RaribleFillRow[]): Promise<number> {
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
      `INSERT INTO plank_rarible_fills
         (chain_slug, tx_hash, log_index, block_number, block_timestamp, left_hash, right_hash, seller, buyer, nft_contract, token_id, nft_amount, currency_token, price_wei, undecoded_asset_class)
       VALUES ($1, $2, $3, $4, to_timestamp($16), $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12, $13::numeric, $14)
       ON CONFLICT (chain_slug, tx_hash, log_index) DO NOTHING`,
      [
        r.chainSlug,
        r.txHash,
        r.logIndex,
        r.blockNumber,
        r.match.leftHash,
        r.match.rightHash,
        r.match.seller,
        r.match.buyer,
        r.match.nftContract,
        r.match.tokenId,
        r.match.nftAmount,
        r.match.currencyToken,
        r.match.priceWei,
        r.match.undecodedAssetClass,
        r.blockTimestamp ?? null,
      ]
    );
    const isNew = (result.rowCount ?? 0) > 0;
    written += isNew ? 1 : 0;
    if (!isNew || !r.match.nftContract || !r.match.tokenId) continue;

    await postgresQuery(
      `INSERT INTO plank_market_event_assets
         (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, item_type, token_address, token_id, amount_atomic, recipient)
       VALUES ($1, 'rarible', 'exchange-v2', $2, $3, $4, 0, 'offer', 2, $5, $6, $7::numeric, $8)
       ON CONFLICT DO NOTHING`,
      [r.chainSlug, RARIBLE_EXCHANGE_V2_ADDRESS, r.txHash, r.logIndex, r.match.nftContract, r.match.tokenId, r.match.nftAmount, r.match.buyer]
    );
    if (r.match.priceWei) {
      await postgresQuery(
        `INSERT INTO plank_market_event_payments
           (chain_slug, venue_id, protocol_version, deployment_address, tx_hash, event_index, leg_index, side, token_address, amount_atomic, recipient, allocation_method)
         VALUES ($1, 'rarible', 'exchange-v2', $2, $3, $4, 0, 'consideration', $5, $6::numeric, $7, 'protocol-explicit')
         ON CONFLICT DO NOTHING`,
        [r.chainSlug, RARIBLE_EXCHANGE_V2_ADDRESS, r.txHash, r.logIndex, r.match.currencyToken, r.match.priceWei, r.match.seller]
      );
    }
  }
  return written;
}
