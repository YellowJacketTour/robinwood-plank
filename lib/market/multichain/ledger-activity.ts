import "server-only";

import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { activityValue } from "@/lib/market/activity-value";
import { foreignChainByChainSlug, foreignOfferCurrency } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { STABLECOINS_BY_CHAIN } from "@/lib/market/multichain/trading/stablecoins";

/**
 * Real, unioned, per-collection activity across every first-party ledger
 * this app actually writes to today: the canonical wallet-transfer ledger
 * (plank_market_events, venue_id='wallet-transfer' -- transfer-ledger.ts's
 * own header notes it already excludes any tx hash matched to a known
 * marketplace fill, so a transfer row here can never double-count a sale
 * also present below) plus all eight self-hosted on-chain fill indexes
 * (migrations 023/048-055): Seaport, Wyvern, LooksRare, Blur, X2Y2,
 * Foundation, Sudoswap, Rarible, CryptoKitties.
 *
 * HONEST GAPS, NOT SILENTLY PAPERED OVER
 * ----------------------------------------------------------------------
 * - Every source here is EVM-only (chain_slug values like eth-mainnet,
 *   base-mainnet, etc.). Solana and Bitcoin have their OWN real ledger
 *   tables (plank_solana_transfer_scan_cursors / plank_bitcoin_transfer_
 *   scan_cursor per the discovery scanners in helius-transfer-scan.ts /
 *   unisat-transfer-scan.ts) but this reader does not touch those --
 *   callers that need Solana/Bitcoin activity keep using the existing
 *   Magic Eden / UniSat live-API branches in the activity route.
 * - A collection whose scanners have simply never run against a given
 *   deployment's database has zero rows in every one of these tables --
 *   that reads as a real, honest empty result (coverage.indexedEvents=0),
 *   never a fabricated "no activity" narrative layered on top.
 * - plank_wyvern_fills / plank_cryptokitties_fills can have NULL
 *   nft_contract/token_id for real, cited protocol reasons documented in
 *   their own migrations (049/055) -- rows with a NULL token_id for this
 *   collection's contract cannot be correlated to it and are excluded by
 *   the WHERE nft_contract = $2 filter below, same as any other venue.
 * - plank_foundation_fills and plank_cryptokitties_fills carry no
 *   currency_token column at all (both are always native-ETH-denominated
 *   per their own migration headers) -- selected as a literal NULL here,
 *   not a lookup failure.
 * - Sudoswap fills store a real NUMERIC[] token_ids (batch swaps are real
 *   -- see 053's own header); this reader surfaces the first id as the
 *   row's tokenId and reports the true batch size in extra.batchSize so a
 *   UI can show "+3 more" honestly instead of hiding the other tokens.
 */

export type LedgerActivityKind =
  | "sale"
  | "transfer"
  | "mint"
  | "burn"
  | "listing-created"
  | "listing-cancelled"
  | "bid-created"
  | "bid-cancelled"
  | "pool-buy"
  | "pool-sell"
  | "siring";

export type LedgerVenueId =
  | "wallet-transfer"
  | "seaport"
  | "wyvern"
  | "looksrare"
  | "blur"
  | "x2y2"
  | "foundation"
  | "sudoswap"
  | "rarible"
  | "cryptokitties-auction";

export type LedgerActivityEvent = {
  kind: LedgerActivityKind;
  venueId: LedgerVenueId;
  timestamp: string | null;
  transaction: string;
  logIndex: number;
  blockNumber: string;
  priceWei: string | null;
  priceAmount: string | null;
  priceSymbol: string | null;
  priceUsd: number | null;
  from: string | null;
  to: string | null;
  tokenId: string | null;
  batchSize?: number;
  evidenceSource: "first-party-ledger";
};

export type LedgerActivityCoverage = {
  source: "first-party-ledger";
  indexedEvents: number;
  timestampedEvents: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  byVenue: Partial<Record<LedgerVenueId, number>>;
  completeMarketHistory: false;
};

type UnionRow = {
  kind: string;
  venue_id: string;
  tx_hash: string;
  log_index: string;
  block_number: string;
  block_timestamp: Date | null;
  from_addr: string | null;
  to_addr: string | null;
  token_id: string | null;
  batch_size: string | null;
  currency_token: string | null;
  price_wei: string | null;
};

/**
 * Every SELECT below is normalized to the exact same 11-column shape so a
 * plain UNION ALL can order/limit across all sources in one query rather
 * than fetching each table separately and merge-sorting in JS. Each branch
 * is documented against the real column set its own migration defined --
 * see this file's header and each migration's own comments for the
 * per-venue honesty notes (NULL currency, NULL token_id, etc.).
 */
const UNION_SQL = `
  SELECT event_type AS kind, 'wallet-transfer' AS venue_id,
         tx_hash, event_index AS log_index, block_number::text AS block_number, block_timestamp,
         seller AS from_addr, buyer AS to_addr, token_id::text AS token_id, NULL::text AS batch_size,
         NULL::text AS currency_token, NULL::text AS price_wei
  FROM plank_market_events
  WHERE chain_slug = $1 AND lower(collection_key) = $2 AND event_type IN ('transfer', 'mint')

  UNION ALL
  SELECT 'sale', 'seaport',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_seaport_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'wyvern',
         tx_hash, log_index, block_number::text, block_timestamp,
         maker, taker, token_id::text, NULL,
         NULL, price_wei::text
  FROM plank_wyvern_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'looksrare',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_looksrare_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'blur',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_blur_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'x2y2',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_x2y2_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'foundation',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         NULL, price_wei::text
  FROM plank_foundation_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT CASE WHEN direction = 'buy-from-pool' THEN 'pool-buy' ELSE 'pool-sell' END, 'sudoswap',
         tx_hash, log_index, block_number::text, block_timestamp,
         CASE WHEN direction = 'sell-to-pool' THEN counterparty ELSE pool_address END,
         CASE WHEN direction = 'buy-from-pool' THEN counterparty ELSE pool_address END,
         (token_ids[1])::text, array_length(token_ids, 1)::text,
         currency_token, price_wei::text
  FROM plank_sudoswap_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'rarible',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_rarible_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT CASE WHEN auction_kind = 'sale' THEN 'sale' ELSE 'siring' END, 'cryptokitties-auction',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, winner, token_id::text, NULL,
         NULL, total_price_wei::text
  FROM plank_cryptokitties_fills
  WHERE chain_slug = $1 AND nft_contract = $2
`;

/**
 * Real, free, on-chain-derived holder-count fallback -- reuses the exact
 * same first-party ledger (transfer-ledger.ts's wallet-transfer writer +
 * every self-hosted fill indexer) `readLedgerActivity` already unions,
 * instead of building any new Transfer-log scanning/backfill infra. This
 * fixes a real gap: `holder_count` in plank_multichain_snapshots has
 * always come exclusively from Alchemy's getOwnersForContract (see
 * fetchHolderCount in alchemy-nft.ts) -- the same kind of single-vendor
 * dependency this session already found and fixed for metadata. When
 * Alchemy is jailed/exhausted, this gives a real, free alternative.
 *
 * HONESTY CAVEAT, stated in the return shape, never hidden: this ledger
 * only has complete Transfer history for a contract once its own
 * discovery/backfill scanner has walked back far enough (see this file's
 * own header and CollectionIntelligence's historyCoverage banner for the
 * same "not yet complete" signal elsewhere in this app) -- an older,
 * lightly-tracked contract can undercount real holders if some of its
 * transfer history was never indexed. `sampleSize` is the real indexed
 * event count this estimate was computed from, so a caller (or a human)
 * can judge confidence; this is NEVER written over a real Alchemy value,
 * only offered as a labeled fallback when Alchemy has none.
 */
export async function deriveApproxHolderCountFromLedger(
  chainSlug: string,
  contractAddress: string
): Promise<{ holderCount: number; sampleSize: number } | null> {
  if (!hasPostgresConfig()) return null;
  const contract = contractAddress.toLowerCase();
  const result = await postgresQuery<{ holder_count: string; sample_size: string }>(
    `WITH events AS (${UNION_SQL}),
     latest_per_token AS (
       SELECT DISTINCT ON (token_id) token_id, to_addr
       FROM events
       WHERE token_id IS NOT NULL AND to_addr IS NOT NULL
       ORDER BY token_id, block_number DESC, log_index DESC
     )
     SELECT COUNT(DISTINCT to_addr)::text AS holder_count, (SELECT COUNT(*) FROM events)::text AS sample_size
     FROM latest_per_token`,
    [chainSlug, contract]
  );
  const row = result.rows[0];
  const holderCount = row ? Number(row.holder_count) : 0;
  const sampleSize = row ? Number(row.sample_size) : 0;
  return sampleSize > 0 ? { holderCount, sampleSize } : null;
}

function currencyMetadata(chainSlug: string, token: string | null) {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!token) return { symbol: chain?.nativeCurrencySymbol ?? "ETH", decimals: 18 };
  const stable = chain
    ? STABLECOINS_BY_CHAIN[chain.chainId]?.find((entry) => entry.address.toLowerCase() === token.toLowerCase())
    : null;
  if (stable) return { symbol: stable.symbol, decimals: stable.decimals };
  if (foreignOfferCurrency(chainSlug)?.toLowerCase() === token.toLowerCase()) {
    return { symbol: chainSlug === "bnb-mainnet" ? "WBNB" : chainSlug === "avax-mainnet" ? "WAVAX" : "WETH", decimals: 18 };
  }
  return { symbol: undefined, decimals: undefined };
}

/**
 * Reads real, first-party, on-chain activity for one collection on one EVM
 * chain, unioned across every ledger this app actually writes to (see
 * header). Returns null when Postgres isn't configured, same "honest
 * unavailable, not a fabricated empty" contract readSeaportFillHistory
 * already uses.
 */
export async function readLedgerActivity(input: {
  chainSlug: string;
  contractAddress: string;
  limit: number;
}): Promise<{ events: LedgerActivityEvent[]; coverage: LedgerActivityCoverage } | null> {
  if (!hasPostgresConfig()) return null;
  const contract = input.contractAddress.toLowerCase();

  const result = await postgresQuery<UnionRow>(
    `SELECT * FROM (${UNION_SQL}) AS unioned
     ORDER BY block_number DESC, log_index DESC
     LIMIT $3`,
    [input.chainSlug, contract, input.limit]
  );

  const events = await Promise.all(
    result.rows.map(async (row): Promise<LedgerActivityEvent> => {
      const value = await activityValue({
        atomic: row.price_wei,
        ...currencyMetadata(input.chainSlug, row.currency_token),
        tokenAddress: row.currency_token,
        chain: input.chainSlug,
      });
      return {
        kind: row.kind as LedgerActivityKind,
        venueId: row.venue_id as LedgerVenueId,
        timestamp: row.block_timestamp?.toISOString() ?? null,
        transaction: row.tx_hash,
        logIndex: Number(row.log_index),
        blockNumber: row.block_number,
        priceWei: row.price_wei,
        priceAmount: value.priceAmount ?? null,
        priceSymbol: value.priceSymbol ?? null,
        priceUsd: value.priceUsd ?? null,
        from: row.from_addr,
        to: row.to_addr,
        tokenId: row.token_id,
        ...(row.batch_size ? { batchSize: Number(row.batch_size) } : {}),
        evidenceSource: "first-party-ledger",
      };
    })
  );

  // Aggregate coverage counted the same way, unioned across all sources --
  // a second, unlimited pass over the same normalized shape so "how much
  // real history exists" isn't capped by the row `limit` above.
  const coverageResult = await postgresQuery<{ venue_id: string; total: string; timestamped: string; oldest: Date | null; newest: Date | null }>(
    `SELECT venue_id, COUNT(*)::text AS total, COUNT(block_timestamp)::text AS timestamped,
            MIN(block_timestamp) AS oldest, MAX(block_timestamp) AS newest
     FROM (${UNION_SQL}) AS unioned
     GROUP BY venue_id`,
    [input.chainSlug, contract]
  );

  const byVenue: Partial<Record<LedgerVenueId, number>> = {};
  let indexedEvents = 0;
  let timestampedEvents = 0;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const row of coverageResult.rows) {
    const count = Number(row.total);
    byVenue[row.venue_id as LedgerVenueId] = count;
    indexedEvents += count;
    timestampedEvents += Number(row.timestamped);
    if (row.oldest && (!oldest || row.oldest < oldest)) oldest = row.oldest;
    if (row.newest && (!newest || row.newest > newest)) newest = row.newest;
  }

  return {
    events,
    coverage: {
      source: "first-party-ledger",
      indexedEvents,
      timestampedEvents,
      oldestTimestamp: oldest?.toISOString() ?? null,
      newestTimestamp: newest?.toISOString() ?? null,
      byVenue,
      completeMarketHistory: false,
    },
  };
}
