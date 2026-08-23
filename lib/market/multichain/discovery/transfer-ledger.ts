/**
 * The missing permanent record of plain wallet-to-wallet NFT transfers.
 *
 * WHY THIS EXISTS
 * ----------------
 * evm-log-scan.ts and hypersync-evm-scan.ts already decode every
 * Transfer/TransferSingle/TransferBatch log for every tracked EVM contract
 * (to build the discovery/ranking tally) and then discard the from/to/tx/
 * block data once the tally increment happens. Migration 042 already has
 * the exact right sink for that raw data (plank_market_events, event_type
 * 'transfer') -- it just has zero writers. This module is that writer,
 * shared by both scan paths so the decode/dedupe/marketplace-exclusion
 * logic lives in exactly one place.
 *
 * MARKETPLACE-FILL EXCLUSION (task requirement 4)
 * ------------------------------------------------
 * A marketplace-driven sale (Seaport/Wyvern/LooksRare/Blur/Rarible/X2Y2/
 * Foundation/Sudoswap) still emits a real Transfer log -- the NFT actually
 * moves. That fill is already captured, with full fidelity (price, buyer,
 * seller, legs), by this app's own dedicated per-venue fill indexer and
 * its own fill table. Writing a SECOND, thinner 'transfer' row for the same
 * on-chain event into plank_market_events would be a confusing near-
 * duplicate of a record that already exists elsewhere with more detail --
 * so this module takes the "exclude" design (4b): before writing, it checks
 * whether the same (chain_slug, tx_hash) already has a row in any of this
 * app's real fill tables, and skips writing a transfer row for it if so.
 * Genuine wallet-to-wallet transfers (no matching fill row on that tx) are
 * the only rows this ever adds -- exactly the coverage gap the task
 * describes, with zero double-counting against the fill tables' own future
 * plank_market_events writers (should those be added later; both would key
 * off the same tx_hash and Postgres's own UNIQUE constraint on
 * (chain_slug, venue_id, tx_hash, event_index, sub_index) still protects
 * against a literal duplicate even then, since 'wallet-transfer' is a
 * distinct venue_id from every real marketplace venue_id this app uses).
 */
import { AbiCoder } from "ethers";
import { postgresQuery } from "@/lib/postgres";
import { TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC } from "@/lib/market/multichain/discovery/evm-log-scan";

export type DecodedTransfer = {
  chainSlug: string;
  contractAddress: string;
  tokenId: string;
  fromAddress: string;
  toAddress: string;
  txHash: string;
  logIndex: number;
  subIndex: number;
  blockNumber: number;
  blockTimestamp: number | null;
};

export type RawTransferLog = {
  address: string | null | undefined;
  topics: Array<string | null | undefined>;
  data: string | null | undefined;
  transactionHash: string | null | undefined;
  logIndex: number;
  blockNumber: number;
};

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40).toLowerCase();
}

/**
 * Decodes ONE raw log into zero or more transfer events (TransferBatch can
 * carry many token IDs in a single log; sub_index distinguishes them within
 * that one tx/log so each gets its own row under the same UNIQUE key).
 * Returns [] for anything that isn't a real, well-shaped transfer log --
 * same shape gates (4-topic ERC-721 vs ERC-20, TransferSingle/Batch's
 * always-3-topic shape) evm-log-scan.ts's own tally loop already applies.
 */
export function decodeTransferLog(chainSlug: string, log: RawTransferLog): DecodedTransfer[] {
  const address = log.address?.toLowerCase();
  const txHash = log.transactionHash;
  const topic0 = log.topics[0]?.toLowerCase();
  if (!address || !txHash || !topic0) return [];

  const base = {
    chainSlug,
    contractAddress: address,
    txHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockTimestamp: null as number | null,
  };

  if (topic0 === TRANSFER_TOPIC.toLowerCase()) {
    // ERC-721 Transfer(indexed from, indexed to, indexed tokenId) -- must be
    // exactly 4 topics; 3-topic Transfer on this same signature is ERC-20
    // (amount in data, not indexed), not an NFT at all.
    if (log.topics.length !== 4 || !log.topics[1] || !log.topics[2] || !log.topics[3]) return [];
    return [
      {
        ...base,
        tokenId: BigInt(log.topics[3]!).toString(),
        fromAddress: topicToAddress(log.topics[1]!),
        toAddress: topicToAddress(log.topics[2]!),
        subIndex: 0,
      },
    ];
  }

  if (topic0 === TRANSFER_SINGLE_TOPIC.toLowerCase()) {
    // TransferSingle(indexed operator, indexed from, indexed to, id, value)
    // -- id/value are NOT indexed, they're in data.
    if (log.topics.length !== 4 || !log.topics[2] || !log.topics[3] || !log.data) return [];
    try {
      const [id] = AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
      return [
        {
          ...base,
          tokenId: (id as bigint).toString(),
          fromAddress: topicToAddress(log.topics[2]!),
          toAddress: topicToAddress(log.topics[3]!),
          subIndex: 0,
        },
      ];
    } catch {
      return [];
    }
  }

  if (topic0 === TRANSFER_BATCH_TOPIC.toLowerCase()) {
    // TransferBatch(indexed operator, indexed from, indexed to, ids[], values[])
    if (log.topics.length !== 4 || !log.topics[2] || !log.topics[3] || !log.data) return [];
    try {
      const [ids] = AbiCoder.defaultAbiCoder().decode(["uint256[]", "uint256[]"], log.data);
      const fromAddress = topicToAddress(log.topics[2]!);
      const toAddress = topicToAddress(log.topics[3]!);
      return (ids as bigint[]).map((id, subIndex) => ({
        ...base,
        tokenId: id.toString(),
        fromAddress,
        toAddress,
        subIndex,
      }));
    } catch {
      return [];
    }
  }

  return [];
}

/** Every real fill table this app maintains -- see this file's own header
 * for why matching against these is how marketplace-driven transfers are
 * excluded rather than double-recorded. */
const FILL_TABLES = [
  "plank_seaport_fills",
  "plank_wyvern_fills",
  "plank_looksrare_fills",
  "plank_blur_fills",
  "plank_rarible_fills",
  "plank_x2y2_fills",
  "plank_foundation_fills",
  "plank_sudoswap_fills",
] as const;

export async function findMarketplaceFillTxHashes(chainSlug: string, txHashes: string[]): Promise<Set<string>> {
  // Every real fill writer in this app stores tx_hash as the raw lowercase
  // hex string straight from the RPC/HyperSync response (confirmed live
  // against plank_seaport_fills' actual rows, 2026-08-23) -- matching on
  // plain `tx_hash = ANY(...)` (already-lowercased input, no lower() on the
  // column) lets Postgres use each table's existing (chain_slug, tx_hash,
  // log_index) index. plank_seaport_fills alone holds 53M+ rows; wrapping
  // the column in lower() would force a full sequential scan there and
  // blow the pool's 15s statement_timeout -- confirmed live the hard way.
  const unique = [...new Set(txHashes.map((h) => h.toLowerCase()))];
  if (unique.length === 0) return new Set();
  const matched = new Set<string>();
  for (const table of FILL_TABLES) {
    const result = await postgresQuery<{ tx_hash: string }>(
      `SELECT DISTINCT tx_hash FROM ${table} WHERE chain_slug = $1 AND tx_hash = ANY($2::text[])`,
      [chainSlug, unique]
    );
    for (const row of result.rows) matched.add(row.tx_hash.toLowerCase());
  }
  return matched;
}

export type WriteTransferLedgerResult = { written: number; skippedMarketplaceFill: number };

/**
 * Writes real wallet-to-wallet transfer rows to plank_market_events,
 * excluding anything whose tx_hash already has a real fill row (see
 * findMarketplaceFillTxHashes / this file's own header). Idempotent via the
 * same ON CONFLICT DO NOTHING convention every other real writer in this
 * app uses -- safe to call repeatedly over the same block range.
 */
export async function writeTransferLedgerEvents(transfers: DecodedTransfer[]): Promise<WriteTransferLedgerResult> {
  if (transfers.length === 0) return { written: 0, skippedMarketplaceFill: 0 };

  const byChain = new Map<string, DecodedTransfer[]>();
  for (const t of transfers) {
    const arr = byChain.get(t.chainSlug) ?? [];
    arr.push(t);
    byChain.set(t.chainSlug, arr);
  }

  let written = 0;
  let skippedMarketplaceFill = 0;

  for (const [chainSlug, list] of byChain) {
    const marketplaceTx = await findMarketplaceFillTxHashes(chainSlug, list.map((t) => t.txHash));
    const seen = new Set<string>();
    for (const t of list) {
      if (marketplaceTx.has(t.txHash.toLowerCase())) {
        skippedMarketplaceFill += 1;
        continue;
      }
      // Dedupe within-batch against the same UNIQUE key Postgres enforces
      // (chain_slug, venue_id, tx_hash, event_index, sub_index) -- a log
      // seen twice across overlapping scan windows must not error the batch.
      const dedupeKey = `${chainSlug}:${t.txHash.toLowerCase()}:${t.logIndex}:${t.subIndex}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const eventIdentity = `${chainSlug}:${t.txHash}:${t.logIndex}:${t.subIndex}`;
      const result = await postgresQuery(
        `INSERT INTO plank_market_events
           (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
            event_index, sub_index, block_number, block_timestamp, seller, buyer,
            chain_namespace, event_identity, raw_event)
         VALUES
           ($1, 'wallet-transfer', 'erc-transfer', 'transfer', $2, $3, $4,
            $5, $6, $7, to_timestamp($8), $9, $10,
            'eip155', $11, $12::jsonb)
         ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
        [
          chainSlug,
          t.contractAddress,
          t.tokenId,
          t.txHash,
          t.logIndex,
          t.subIndex,
          t.blockNumber,
          t.blockTimestamp,
          t.fromAddress,
          t.toAddress,
          eventIdentity,
          JSON.stringify({ from: t.fromAddress, to: t.toAddress, contractAddress: t.contractAddress }),
        ]
      );
      if ((result.rowCount ?? 0) > 0) written += 1;
    }
  }

  return { written, skippedMarketplaceFill };
}
