import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getPlankSupply } from "@/lib/plank-supply";
import { getPlankPoolStats } from "@/lib/plank-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 08:08 CDT (UTC-5 in August) 2026-08-26 == 13:08 UTC. Same real instant
 * as PLANK_KOTH_LAUNCH_AT_MS (lib/market/plank-koth.ts) -- duplicated here
 * ON PURPOSE: this route is the production-safe subset of Season 2 that
 * has ZERO Postgres/mesh-tick dependency (see this route's own header),
 * so it must not import anything from that DB-backed module. */
const LAUNCH_AT_MS = Date.parse("2026-08-26T13:08:00.000Z");
const COMPETITION_DAYS = 31;
const DEADLINE_MS = LAUNCH_AT_MS + COMPETITION_DAYS * 24 * 60 * 60 * 1000;
/** 0.69420% of total supply, exactly as specified. */
const PRIZE_SUPPLY_FRACTION = 0.0069420;

/**
 * Financials-only subset of Season 2's "Biggest Buyer Board": launch/
 * deadline countdown targets and the real, live prize amount/value.
 * Deliberately has NO dependency on Postgres or the mesh-tick job
 * scheduler (lib/market/plank-koth.ts, lib/market/plank-koth-watch.ts) --
 * this is the piece safe to ship standalone to a deployment that doesn't
 * yet have that backend running, while still giving users a real, live
 * countdown + prize display rather than nothing. The full live buy-
 * tracking leaderboard is a separate, heavier feature layered on top of
 * this once that backend is available.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-plank-koth-financials", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const [supply, poolStats] = await Promise.all([
      getPlankSupply().catch(() => null),
      getPlankPoolStats().catch(() => null),
    ]);

    const prizePlankAmount = supply ? (BigInt(supply.totalSupplyRaw) * 694_200n) / 100_000_000n : null;
    const prizePlankTokens = prizePlankAmount != null ? Number(prizePlankAmount) / 1e18 : null;
    const prizeUsdValue = prizePlankTokens != null && poolStats?.priceUsd != null ? prizePlankTokens * poolStats.priceUsd : null;
    const prizePlankEth = prizePlankTokens != null && poolStats?.priceEth != null ? prizePlankTokens * poolStats.priceEth : null;

    return publicJson({
      available: true,
      launchAt: new Date(LAUNCH_AT_MS).toISOString(),
      deadline: new Date(DEADLINE_MS).toISOString(),
      launched: Date.now() >= LAUNCH_AT_MS,
      prize: {
        supplyFraction: PRIZE_SUPPLY_FRACTION,
        plankAmount: prizePlankAmount != null ? prizePlankAmount.toString() : null,
        usdValue: prizeUsdValue,
        plankEth: prizePlankEth,
      },
      plankUsd: poolStats?.priceUsd ?? null,
    });
  } catch (error) {
    return publicError(error, "Could not load Biggest Buyer Board financials.");
  }
}
