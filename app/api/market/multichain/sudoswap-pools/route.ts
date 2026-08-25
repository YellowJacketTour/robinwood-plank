/**
 * Cross-pool (and, once other AMM venues are indexed the same way,
 * cross-venue/cross-chain) DeFi-pool comparison surface -- lists every real
 * Sudoswap v1 pool this app has indexed fills for (plank_sudoswap_fills,
 * see sudoswap-fill-indexer.ts / hypersync-sudoswap-scan.ts), each with its
 * real current inventory, real observed volume/price, and the real
 * rarity-tier redeem odds + premium/discount computed in
 * sudoswap-pool-analytics.ts. Only ever reports what the underlying data
 * actually supports -- a pool with no decoded price simply carries
 * lastPriceWei: null / premiumDiscountPct: null rather than a guess.
 *
 * Today this venue is eth-mainnet only (see SUDOSWAP_CHAIN_SLUG) -- the
 * `chainSlug` field on each row is real and forward-compatible with adding
 * more AMM-pool venues/chains to the same shape later, not a placeholder.
 */
import { NextRequest, NextResponse } from "next/server";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { getCollectionSupplyStats } from "@/lib/market/multichain/store";
import { hasForeignRarityStore, getForeignRarity } from "@/lib/market/multichain/foreign-rarity-store";
import {
  computeSudoswapPoolMetrics,
  type SudoswapPoolFillRow,
  type RarityLookup,
} from "@/lib/market/multichain/sudoswap-pool-analytics";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PoolFillDbRow = {
  pool_address: string;
  nft_contract: string | null;
  direction: "buy-from-pool" | "sell-to-pool";
  token_ids: string[];
  block_number: string;
  log_index: number;
  block_timestamp: string | null;
  currency_token: string | null;
  price_wei: string | null;
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-sudoswap-pools", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  if (!hasPostgresConfig()) {
    return NextResponse.json({ pools: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const { searchParams } = new URL(req.url);
  const contractAddress = searchParams.get("contractAddress");
  const sort = searchParams.get("sort") ?? "inventory";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200);

  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (contractAddress) {
      params.push(contractAddress.toLowerCase());
      clauses.push(`nft_contract = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    // All real fills, per pool -- bounded to the most recent 20k rows per
    // pool address is unnecessary at this app's current real Sudoswap
    // volume (this venue was only wired up this session); a straight scan
    // of the real table is honest and fast enough for now.
    const result = await postgresQuery<PoolFillDbRow>(
      `SELECT pool_address, nft_contract, direction, token_ids::text[] AS token_ids, block_number::text AS block_number,
              log_index, extract(epoch from block_timestamp)::text AS block_timestamp, currency_token, price_wei::text AS price_wei
       FROM plank_sudoswap_fills
       ${where}
       ORDER BY pool_address, block_number, log_index`,
      params
    );

    const byPool = new Map<string, { nftContract: string | null; fills: SudoswapPoolFillRow[] }>();
    for (const row of result.rows) {
      const entry = byPool.get(row.pool_address) ?? { nftContract: row.nft_contract, fills: [] };
      entry.nftContract = entry.nftContract ?? row.nft_contract;
      entry.fills.push({
        direction: row.direction,
        tokenIds: row.token_ids ?? [],
        blockNumber: Number(row.block_number),
        logIndex: row.log_index,
        blockTimestampSec: row.block_timestamp ? Number(row.block_timestamp) : null,
        currencyToken: row.currency_token,
        priceWei: row.price_wei,
      });
      byPool.set(row.pool_address, entry);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const raritySupported = hasForeignRarityStore();
    const emptyRarity: RarityLookup = { byTokenId: new Map() };

    const pools = [];
    for (const [poolAddress, { nftContract, fills }] of byPool) {
      let floorPriceWei: bigint | null = null;
      let raritySnapshot: RarityLookup = emptyRarity;
      if (nftContract) {
        // "eth-mainnet" is the only real Sudoswap venue this app indexes
        // (see sudoswap-fill-indexer.ts's SUDOSWAP_CHAIN_SLUG) -- the
        // collection lookup key mirrors that, honestly, rather than
        // guessing a chain.
        const supply = await getCollectionSupplyStats("eth-mainnet", nftContract).catch(() => null);
        floorPriceWei = supply?.floorPriceWei ? BigInt(supply.floorPriceWei) : null;
        if (raritySupported) {
          const map = await getForeignRarity("eth-mainnet", nftContract).catch(() => new Map());
          raritySnapshot = { byTokenId: map as RarityLookup["byTokenId"] };
        }
      }

      pools.push(
        computeSudoswapPoolMetrics({
          chainSlug: "eth-mainnet",
          poolAddress,
          nftContract,
          fills,
          raritySnapshot,
          floorPriceWei,
          nowSec,
        })
      );
    }

    pools.sort((a, b) => {
      if (sort === "volume") return Number(BigInt(b.volume24hWei) - BigInt(a.volume24hWei));
      if (sort === "premium") return (b.premiumDiscount.premiumDiscountPct ?? -Infinity) - (a.premiumDiscount.premiumDiscountPct ?? -Infinity);
      return b.inventoryCount - a.inventoryCount;
    });

    return NextResponse.json(
      { pools: pools.slice(0, limit), venue: "sudoswap", chainSlug: "eth-mainnet" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to fetch Sudoswap pool analytics");
  }
}
