import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

/**
 * Biggest buyers for one collection, from REAL settled sales only
 * (plank_market_events, event_type = 'sale', the multi-venue ledger the
 * fill indexers write). No venue API, no estimate: a wallet appears here
 * because a fill with it as buyer was indexed. USD is the per-fill
 * amount_usd the ledger stored at fill time; rows without it count toward
 * `sales` but not toward `usd`, and that is reported, never blended.
 */

export type BuyerRow = {
  buyer: string;
  sales: number;
  /** Sum of amount_usd over fills that carry one. */
  usd: number | null;
  /** Fills that had no USD figure at index time. */
  unpricedSales: number;
  /** Sum of atomic amounts in the collection's dominant currency, as a string (exact). */
  amountAtomic: string | null;
  currencySymbol: string | null;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  distinctTokens: number;
};

export type BiggestBuyers = {
  chainSlug: string;
  collectionKey: string;
  windowHours: number;
  buyers: BuyerRow[];
  totalSales: number;
  coverageNote: string;
};

export function rankBuyers(rows: BuyerRow[]): BuyerRow[] {
  return [...rows].sort((a, b) => {
    const au = a.usd ?? -1;
    const bu = b.usd ?? -1;
    if (bu !== au) return bu - au;
    if (b.sales !== a.sales) return b.sales - a.sales;
    return a.buyer.localeCompare(b.buyer);
  });
}

export async function readBiggestBuyers(input: { chainSlug: string; collectionKey: string; windowHours?: number; limit?: number }): Promise<BiggestBuyers | null> {
  if (!hasPostgresConfig()) return null;
  const windowHours = Math.min(Math.max(Math.floor(input.windowHours ?? 24 * 7), 1), 24 * 365);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), 100);
  const r = await postgresQuery<{
    buyer: string; sales: string; usd: string | null; unpriced: string; amount_atomic: string | null; currency_symbol: string | null;
    first_buy: Date | null; last_buy: Date | null; distinct_tokens: string;
  }>(
    `WITH fills AS (
       -- AUDIT lens 6 #7 (2026-09-06): a stream row whose transaction the
       -- on-chain Seaport indexer already holds is the same sale, so it is
       -- excluded here; and a stream item_sold fires once per item of a
       -- bundle carrying the whole bundle price, so each item takes its
       -- 1/quantity share.
       SELECT e.buyer,
              CASE WHEN e.venue_id = 'opensea-stream'
                   THEN e.amount_usd / GREATEST(COALESCE((e.raw_event->>'quantity')::numeric, 1), 1)
                   ELSE e.amount_usd END AS amount_usd,
              CASE WHEN e.venue_id = 'opensea-stream'
                   THEN e.amount_atomic / GREATEST(COALESCE((e.raw_event->>'quantity')::numeric, 1), 1)
                   ELSE e.amount_atomic END AS amount_atomic,
              e.currency_symbol, e.block_timestamp, e.token_id
         FROM plank_market_events e
        WHERE e.chain_slug = $1 AND lower(e.collection_key) = lower($2) AND e.event_type = 'sale' AND e.buyer IS NOT NULL
          AND e.block_timestamp >= NOW() - ($3::text || ' hours')::interval
          AND e.finality <> 'reverted'
          AND NOT (e.venue_id = 'opensea-stream' AND EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash))
     ), dominant AS (
       SELECT currency_symbol FROM fills WHERE currency_symbol IS NOT NULL GROUP BY currency_symbol ORDER BY COUNT(*) DESC LIMIT 1
     )
     SELECT f.buyer, COUNT(*)::text AS sales,
            SUM(f.amount_usd)::text AS usd,
            COUNT(*) FILTER (WHERE f.amount_usd IS NULL)::text AS unpriced,
            SUM(f.amount_atomic) FILTER (WHERE f.currency_symbol = (SELECT currency_symbol FROM dominant))::text AS amount_atomic,
            (SELECT currency_symbol FROM dominant) AS currency_symbol,
            MIN(f.block_timestamp) AS first_buy, MAX(f.block_timestamp) AS last_buy,
            COUNT(DISTINCT f.token_id)::text AS distinct_tokens
       FROM fills f
      GROUP BY f.buyer
      ORDER BY SUM(f.amount_usd) DESC NULLS LAST, COUNT(*) DESC
      LIMIT $4`,
    [input.chainSlug, input.collectionKey, windowHours, limit]
  );
  const total = await postgresQuery<{ n: string }>(
    `SELECT COUNT(*)::text n FROM plank_market_events e
      WHERE e.chain_slug = $1 AND lower(e.collection_key) = lower($2) AND e.event_type = 'sale'
        AND e.block_timestamp >= NOW() - ($3::text || ' hours')::interval AND e.finality <> 'reverted'
        AND NOT (e.venue_id = 'opensea-stream' AND EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash))`,
    [input.chainSlug, input.collectionKey, windowHours]
  );
  const buyers = rankBuyers(
    r.rows.map((row) => ({
      buyer: row.buyer,
      sales: Number(row.sales),
      usd: row.usd != null ? Number(row.usd) : null,
      unpricedSales: Number(row.unpriced),
      amountAtomic: row.amount_atomic,
      currencySymbol: row.currency_symbol,
      firstBuyAt: row.first_buy ? new Date(row.first_buy).toISOString() : null,
      lastBuyAt: row.last_buy ? new Date(row.last_buy).toISOString() : null,
      distinctTokens: Number(row.distinct_tokens),
    }))
  );
  return {
    chainSlug: input.chainSlug,
    collectionKey: input.collectionKey,
    windowHours,
    buyers,
    totalSales: Number(total.rows[0]?.n ?? 0),
    coverageNote: "Only fills indexed into plank_market_events count; see venue-registry.ts for which venues are indexed on this chain.",
  };
}
