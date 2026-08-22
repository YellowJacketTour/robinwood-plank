import "server-only";

import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { activityValue } from "@/lib/market/activity-value";
import { foreignChainByChainSlug, foreignOfferCurrency } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { STABLECOINS_BY_CHAIN } from "@/lib/market/multichain/trading/stablecoins";

export type FillHistoryCoverage = {
  source: "first-party-seaport-ledger";
  scope: "seaport-1.6";
  indexedEvents: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  timestampedEvents: number;
  genesisBackfillBlock: number | null;
  liveIndexedBlock: number | null;
  completeThroughGenesis: boolean;
  completeMarketHistory: false;
};

type FillRow = {
  tx_hash: string;
  log_index: number;
  block_number: string;
  block_timestamp: Date | null;
  seller: string;
  buyer: string;
  token_id: string | null;
  currency_token: string | null;
  price_wei: string | null;
};

type CoverageRow = {
  total: string;
  timestamped: string;
  oldest: Date | null;
  newest: Date | null;
};

type CursorRow = { chain_slug: string; last_indexed_block: string };

/**
 * Reads the app's append-only, on-chain Seaport evidence for one collection.
 * This deliberately returns an explicit coverage envelope: a partial ledger
 * must never masquerade as total market history merely because it has rows.
 */
export async function readSeaportFillHistory(input: {
  chainSlug: string;
  contractAddress: string;
  limit: number;
}) {
  if (!hasPostgresConfig()) return null;
  const contract = input.contractAddress.toLowerCase();
  const chain = foreignChainByChainSlug(input.chainSlug);
  const currencyMetadata = (token: string | null) => {
    if (!token) return { symbol: chain?.nativeCurrencySymbol ?? "ETH", decimals: 18 };
    const stable = chain ? STABLECOINS_BY_CHAIN[chain.chainId]?.find((entry) => entry.address.toLowerCase() === token.toLowerCase()) : null;
    if (stable) return { symbol: stable.symbol, decimals: stable.decimals };
    if (foreignOfferCurrency(input.chainSlug)?.toLowerCase() === token.toLowerCase()) {
      return { symbol: input.chainSlug === "bnb-mainnet" ? "WBNB" : input.chainSlug === "avax-mainnet" ? "WAVAX" : "WETH", decimals: 18 };
    }
    return { symbol: undefined, decimals: undefined };
  };
  const [rowsResult, coverageResult, cursorsResult] = await Promise.all([
    postgresQuery<FillRow>(
      `SELECT tx_hash, log_index, block_number::text, block_timestamp,
              seller, buyer, token_id::text, currency_token, price_wei::text
       FROM plank_seaport_fills
       WHERE chain_slug = $1 AND nft_contract = $2
       ORDER BY block_number DESC, log_index DESC
       LIMIT $3`,
      [input.chainSlug, contract, input.limit]
    ),
    postgresQuery<CoverageRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(block_timestamp)::text AS timestamped,
              MIN(block_timestamp) AS oldest,
              MAX(block_timestamp) AS newest
       FROM plank_seaport_fills
       WHERE chain_slug = $1 AND nft_contract = $2`,
      [input.chainSlug, contract]
    ),
    postgresQuery<CursorRow>(
      `SELECT chain_slug, last_indexed_block::text
       FROM plank_seaport_fill_cursor
       WHERE chain_slug = $1 OR chain_slug = $2`,
      [input.chainSlug, `${input.chainSlug}::genesis-backfill`]
    ),
  ]);

  const events = await Promise.all(rowsResult.rows.map(async (row) => ({
    type: "sale" as const,
    timestamp: row.block_timestamp?.toISOString() ?? null,
    transaction: row.tx_hash,
    logIndex: row.log_index,
    blockNumber: row.block_number,
    priceWei: row.price_wei,
    ...(await activityValue({
      atomic: row.price_wei,
      ...currencyMetadata(row.currency_token),
      tokenAddress: row.currency_token,
      chain: input.chainSlug,
    })),
    from: row.seller,
    to: row.buyer,
    tokenId: row.token_id,
    tokenName: null,
    imageUrl: null,
    evidenceSource: "first-party-seaport-ledger" as const,
  })));

  const aggregate = coverageResult.rows[0];
  const cursors = new Map(cursorsResult.rows.map((row) => [row.chain_slug, Number(row.last_indexed_block)]));
  const genesisBackfillBlock = cursors.get(`${input.chainSlug}::genesis-backfill`) ?? null;
  const liveIndexedBlock = cursors.get(input.chainSlug) ?? null;
  const coverage: FillHistoryCoverage = {
    source: "first-party-seaport-ledger",
    scope: "seaport-1.6",
    indexedEvents: Number(aggregate?.total ?? 0),
    timestampedEvents: Number(aggregate?.timestamped ?? 0),
    oldestTimestamp: aggregate?.oldest?.toISOString() ?? null,
    newestTimestamp: aggregate?.newest?.toISOString() ?? null,
    genesisBackfillBlock,
    liveIndexedBlock,
    completeThroughGenesis:
      genesisBackfillBlock != null && liveIndexedBlock != null && genesisBackfillBlock >= liveIndexedBlock,
    // A complete scan of one protocol address is not complete marketplace
    // history. Collections can predate Seaport 1.6 or trade on Wyvern,
    // LooksRare, Blur, native books, and chain-specific venues.
    completeMarketHistory: false,
  };
  return { events, coverage };
}
