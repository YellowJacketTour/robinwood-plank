import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getPlankKoth, getFallenChampions, PLANK_KOTH_LAUNCH_AT_MS } from "@/lib/market/plank-koth";
import { postgresQuery } from "@/lib/postgres";
import { getPlankSupply } from "@/lib/plank-supply";
import { getPlankPoolStats } from "@/lib/plank-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOP_N = 25;
/** 0.69420% of total supply, exactly as specified. */
const PRIZE_SUPPLY_FRACTION = 0.0069420;

type LeaderboardRow = {
  tx_hash: string;
  wallet: string;
  eth_paid_wei: string;
  plank_amount: string;
  usd_value_at_buy: string | null;
  block_number: string;
  confirmed_at: Date;
};

/**
 * Real, authoritative Season 2 $PLANK King of the Hill state: the live
 * deadline (mutated only by the real extend-on-new-record rule, see
 * lib/market/king-of-the-hill-rules.ts, reused unmodified), the current
 * leading buy, the permanent winner once finalized, the "tower of top
 * buys" leaderboard, and the real prize amount/value at read time.
 *
 * A GET here is itself sufficient to finalize a timed-out round
 * (getPlankKoth lazily finalizes on read) — same discipline as the existing
 * NFT King of the Hill route.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-plank-koth", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const state = await getPlankKoth();
    if (!state) {
      return publicJson({
        available: false,
        note: "Plank King of the Hill requires PostgreSQL, which is not configured on this deployment.",
      });
    }

    const [leaderboard, fallenChampions, supply, poolStats] = await Promise.all([
      postgresQuery<LeaderboardRow>(
        `SELECT tx_hash, wallet, eth_paid_wei, plank_amount, usd_value_at_buy, block_number, confirmed_at
           FROM plank_koth_leaderboard
          ORDER BY usd_value_at_buy DESC NULLS LAST, block_number ASC
          LIMIT $1`,
        [TOP_N]
      ),
      getFallenChampions(20).catch(() => []),
      // Reuse the app's own existing, already-cached (6h) supply reader
      // (lib/plank-supply.ts) -- same real totalSupply() source /api/trade/
      // valuation already uses, rather than a second ad hoc on-chain read.
      getPlankSupply().catch(() => null),
      getPlankPoolStats().catch(() => null),
    ]);

    const prizePlankAmount = supply ? BigInt(supply.totalSupplyRaw) * 694_200n / 100_000_000n : null;
    const prizeUsdValue =
      prizePlankAmount != null && poolStats?.priceUsd != null
        ? (Number(prizePlankAmount) / 1e18) * poolStats.priceUsd
        : null;

    return publicJson({
      available: true,
      launchAt: new Date(PLANK_KOTH_LAUNCH_AT_MS).toISOString(),
      launched: Date.now() >= PLANK_KOTH_LAUNCH_AT_MS,
      deadline: new Date(state.deadlineMs).toISOString(),
      leadingBuy: state.leadingSale
        ? {
            txHash: state.leadingSale.txHash,
            wallet: state.leadingSale.wallet,
            ethPaidWei: state.leadingSale.ethPaidWei,
            plankAmount: state.leadingSale.plankAmount,
            usdValueAtBuy: state.leadingSale.usdValueAtBuy,
          }
        : null,
      finalized: state.winnerFinalizedAtMs != null,
      winnerFinalizedAt: state.winnerFinalizedAtMs == null ? null : new Date(state.winnerFinalizedAtMs).toISOString(),
      winner: state.winnerSale
        ? {
            txHash: state.winnerSale.txHash,
            wallet: state.winnerSale.wallet,
            ethPaidWei: state.winnerSale.ethPaidWei,
            plankAmount: state.winnerSale.plankAmount,
            usdValueAtBuy: state.winnerSale.usdValueAtBuy,
          }
        : null,
      leaderboard: leaderboard.rows.map((row) => ({
        txHash: row.tx_hash,
        wallet: row.wallet,
        ethPaidWei: row.eth_paid_wei,
        plankAmount: row.plank_amount,
        usdValueAtBuy: row.usd_value_at_buy != null ? Number(row.usd_value_at_buy) : null,
        confirmedAt: row.confirmed_at.toISOString(),
      })),
      fallenChampions,
      prize: {
        supplyFraction: PRIZE_SUPPLY_FRACTION,
        plankAmount: prizePlankAmount != null ? prizePlankAmount.toString() : null,
        usdValue: prizeUsdValue,
      },
      plankUsd: poolStats?.priceUsd ?? null,
    });
  } catch (error) {
    return publicError(error, "Could not load Plank King of the Hill state.");
  }
}
