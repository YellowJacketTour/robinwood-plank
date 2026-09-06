import { postgresQuery } from "@/lib/postgres";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";
import { amountUsdAtSale } from "@/lib/market/asset-price-hourly";

/**
 * The one sink (2026-09-06, AUDIT lens 6 section 3): every venue's fill
 * writer records the same normalized, confirmed 'sale' row in
 * plank_market_events, so the buyer board, the live feed and the single
 * volume aggregator (store.ts updateVolumeFromMarketEvents) see every
 * venue's sales with one definition. A stream row for the same transaction
 * is promoted to 'confirmed' instead of lingering as an unconfirmed copy.
 *
 * Idempotent by the ledger's unique key (chain, venue, tx, event_index,
 * sub_index); safe to call after the venue table's own transaction.
 */
export type SaleEventInput = {
  chainSlug: string;
  venue: string;
  protocol: string;
  collectionKey: string;
  tokenId: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number | null;
  /** Unix seconds; null when the indexer did not have the block timestamp. */
  blockTimestamp: number | null;
  seller: string | null;
  buyer: string | null;
  currencyToken: string | null;
  priceWei: string | null;
  raw?: Record<string, unknown>;
};

const pendingAggregation = new Map<string, Set<string>>();

export async function recordSaleEvent(input: SaleEventInput): Promise<boolean> {
  if (!input.collectionKey || !input.txHash) return false;
  const collectionKey = input.collectionKey.toLowerCase();
  const nativeSymbol = chainManifest(input.chainSlug)?.nativeCurrencySymbol ?? null;
  const priced = await amountUsdAtSale(input.chainSlug, input.currencyToken, input.priceWei, input.blockTimestamp).catch(() => ({ amountUsd: null, source: null, asset: null }));
  const result = await postgresQuery(
    `INSERT INTO plank_market_events
       (chain_slug, venue_id, protocol, event_type, collection_key, token_id, tx_hash,
        event_index, sub_index, block_number, block_timestamp, seller, buyer,
        currency_address, currency_symbol, currency_decimals, amount_atomic,
        amount_usd, usd_price_source, usd_price_timestamp,
        finality, chain_namespace, event_identity, raw_event)
     VALUES ($1, $2, $3, 'sale', $4, $5, $6,
        $7, 0, $8, CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9) END, $10, $11,
        $12, $13, 18, $14::numeric,
        $15::numeric, $16, CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9) END,
        'confirmed', 'eip155', $17, $18::jsonb)
     ON CONFLICT (chain_slug, venue_id, tx_hash, event_index, sub_index) DO NOTHING`,
    [
      input.chainSlug,
      input.venue,
      input.protocol,
      collectionKey,
      input.tokenId,
      input.txHash,
      input.logIndex,
      input.blockNumber,
      input.blockTimestamp,
      input.seller?.toLowerCase() ?? null,
      input.buyer?.toLowerCase() ?? null,
      input.currencyToken?.toLowerCase() ?? null,
      input.currencyToken ? null : nativeSymbol,
      input.priceWei,
      priced.amountUsd,
      priced.source,
      `${input.chainSlug}:${input.venue}:${input.txHash}:${input.logIndex}`,
      JSON.stringify(input.raw ?? {}).slice(0, 4_000),
    ]
  );
  const inserted = (result.rowCount ?? 0) > 0;
  if (inserted) {
    await postgresQuery(
      `UPDATE plank_market_events SET finality = 'confirmed', block_number = COALESCE(block_number, $3),
         block_timestamp = COALESCE(block_timestamp, CASE WHEN $4::double precision IS NULL THEN NULL ELSE to_timestamp($4) END)
        WHERE chain_slug = $1 AND venue_id = 'opensea-stream' AND tx_hash = $2 AND finality = 'observed'`,
      [input.chainSlug, input.txHash, input.blockNumber, input.blockTimestamp]
    ).catch(() => undefined);
    const set = pendingAggregation.get(input.chainSlug) ?? new Set<string>();
    set.add(collectionKey);
    pendingAggregation.set(input.chainSlug, set);
  }
  return inserted;
}

/** Run the one aggregator for every collection recorded since the last flush. Call once per writer pass. */
export async function flushLedgerAggregation(): Promise<{ chains: number; collections: number }> {
  const { updateVolumeFromMarketEvents } = await import("@/lib/market/multichain/store");
  let chains = 0;
  let collections = 0;
  for (const [chainSlug, keys] of pendingAggregation) {
    pendingAggregation.delete(chainSlug);
    chains += 1;
    collections += keys.size;
    await updateVolumeFromMarketEvents(chainSlug, [...keys]).catch(() => undefined);
  }
  return { chains, collections };
}
