import "server-only";

import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { FEED_UNION_SQL, UNION_SQL } from "./ledger-union-sql";
import { readActivityCoverage, activityCoverageIsStale, requestActivityCoverage } from "./activity-coverage";
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
  | "opensea-stream"
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
  /** "counted": indexedEvents is the worker's full count, taken at countedAt
   * with no newer feed event since. "counting": no trustworthy count yet;
   * indexedEvents is the page's own length -- a certain lower bound. */
  countStatus: "counted" | "counting";
  countedAt: string | null;
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
// UNION_SQL and FEED_UNION_SQL live in ledger-union-sql.ts (no `server-only`)
// so the mesh worker can run the coverage count. Re-exported for readers.
export { UNION_SQL, FEED_UNION_SQL } from "./ledger-union-sql";




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
       ORDER BY token_id, block_number::numeric DESC NULLS LAST, log_index DESC
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
  if (!token || /^0x0{40}$/i.test(token)) return { symbol: chain?.nativeCurrencySymbol ?? "ETH", decimals: 18 };
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

  // THE FEED AND ITS COVERAGE ARE TWO READS OF THE SAME UNION. RUN THEM AS ONE.
  //
  // They were sequential: the feed query, then -- only after every row had
  // been mapped -- the coverage aggregate. Neither depends on the other; both
  // take exactly (chainSlug, contract). So the request paid the SUM of two
  // full passes over eleven ledgers where it owed the MAX of one, and on a
  // pool capped at PGPOOL_MAX=4 it held a connection for both, back to back.
  //
  // This is the read behind /api/market/multichain/activity for every EVM
  // collection. Measured on production 2026-09-14: BAYC 200 @ 22.6 s, Beezie
  // on Base 500 @ 22-25 s three times out of three -- the second pass pushed
  // the request past the 15 s statement_timeout, and the timeout propagated
  // as a 500. Migration 147 removes the Wyvern sequential scan that made each
  // pass expensive; this removes the serialisation that doubled it.
  //
  // THE FEED READS N ROWS PER VENUE, NOT EVERY ROW THE COLLECTION EVER HAD.
  //
  // FEED_UNION_SQL is UNION_SQL with each branch ORDER BY the exact global
  // key below and LIMIT $3. Because every branch's order IS the outer order,
  // the union of per-branch top-Ns is a superset of the true top-N and this
  // outer sort over (13 x N) rows is exact -- a structural property that
  // assumes nothing about the data. See ledger-union-sql.ts for the two
  // designs that assumed more and were wrong, and for the timestamp bound
  // that makes the plank_market_events branches exact AND cheap on the
  // index that exists.
  //
  // THE COVERAGE COUNT IS NOT ON THIS PATH. Until 2026-09-14 a second query
  // counted every row of the unbounded union alongside the feed. On
  // production's 167M-row plank_market_events that count was the 15 s
  // statement_timeout itself: BAYC, Beezie and Azuki answered 500 with the
  // bounded feed already live. Now the count is read from the durable KV
  // where the mesh worker (80 s budget, off the request) last wrote it, and
  // a recount is requested the moment the feed shows an event newer than
  // the count's newest -- evidence of new rows, not a timer.
  const result = await postgresQuery<UnionRow>(
    `SELECT * FROM (${FEED_UNION_SQL}) AS unioned
     -- AUDIT lens 6 #6: block_number is text in the union; text ordering put
     -- "9999999" above "10000000" and NULL stream rows first forever.
     ORDER BY COALESCE(block_timestamp, to_timestamp(0)) DESC, block_number::numeric DESC NULLS LAST, log_index DESC
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

  const feedNewest = result.rows.reduce<Date | null>((acc, row) => (row.block_timestamp && (!acc || row.block_timestamp > acc) ? row.block_timestamp : acc), null);
  const counted = await readActivityCoverage(input.chainSlug, contract).catch(() => null);
  const stale = activityCoverageIsStale(counted, feedNewest);
  if (stale) {
    // Fire-and-forget: the request never waits on the count. Deduplicated
    // by job key, so a hot collection asks once, not once per viewer.
    void requestActivityCoverage(input.chainSlug, contract).catch(() => undefined);
  }

  return {
    events,
    coverage: counted && !stale
      ? {
          source: "first-party-ledger",
          indexedEvents: counted.indexedEvents,
          timestampedEvents: counted.timestampedEvents,
          oldestTimestamp: counted.oldestTimestamp,
          newestTimestamp: counted.newestTimestamp,
          byVenue: counted.byVenue,
          completeMarketHistory: false,
          countStatus: "counted",
          countedAt: counted.countedAt,
        }
      : {
          // No trustworthy count yet (never counted, or new rows since).
          // The page itself is the only certain lower bound; the worker
          // has been asked and the next request after it finishes reads
          // the real count. Never a stale total presented as current.
          source: "first-party-ledger",
          indexedEvents: events.length,
          timestampedEvents: events.filter((e) => e.timestamp).length,
          oldestTimestamp: counted?.oldestTimestamp ?? null,
          newestTimestamp: feedNewest?.toISOString() ?? counted?.newestTimestamp ?? null,
          byVenue: counted?.byVenue ?? {},
          completeMarketHistory: false,
          countStatus: "counting",
          countedAt: counted?.countedAt ?? null,
        },
  };
}
