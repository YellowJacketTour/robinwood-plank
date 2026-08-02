import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getPlankPoolStats } from "@/lib/plank-price";
import { getPlankPools } from "@/lib/plank-pools";
import { getPlankSupply } from "@/lib/plank-supply";
import {
  PLANK_SUPPLY_BASIS,
  computeFdvUsd,
  supplySharePct,
  valuationDivergencePct,
} from "@/lib/plank-valuation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * $PLANK's fully diluted valuation, computed here rather than copied from an
 * aggregator: our own `totalSupply()` read (lib/plank-supply.ts) times the
 * deepest pool's USD price (lib/plank-price.ts).
 *
 * The response carries BOTH third-party figures alongside ours so the client
 * can show the cross-check instead of asking anyone to take one number on
 * faith. See lib/plank-valuation.ts for why this endpoint has no market cap
 * to report and never will until a real lock contract exists.
 *
 * Every upstream here is independently cached (supply 6h, GeckoTerminal 60s,
 * DexScreener 60s), so this route adds no chain reads and no new provider
 * spend of its own.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "trade-valuation",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;

  try {
    // A DexScreener outage must not blank the headline figure — its only job
    // here is the secondary cross-check, so it degrades to null on its own.
    const [stats, supply, pools] = await Promise.all([
      getPlankPoolStats(),
      getPlankSupply(),
      getPlankPools().catch(() => null),
    ]);

    const fdvUsd = computeFdvUsd(stats.priceUsd, supply.totalSupply);
    // pools[] is sorted liquidity-descending, so [0] is the same Uniswap v2
    // pool the chart and our price reference use — a like-for-like comparison.
    const dexscreenerFdvUsd = pools?.pools?.[0]?.fdvUsd ?? null;

    return publicJson({
      basis: PLANK_SUPPLY_BASIS,
      fdvUsd,
      /**
       * Always null, by decision, not by accident — 56.8% of supply sits in
       * an unlocked wallet, so there is no defensible circulating supply to
       * divide by. Sent explicitly so a client can never mistake an absent
       * key for "not fetched yet" and substitute the FDV.
       */
      marketCapUsd: null,
      priceUsd: stats.priceUsd,
      priceSource: "GeckoTerminal · Uniswap v2 pool (deepest)",
      totalSupply: supply.totalSupply,
      totalSupplyRaw: supply.totalSupplyRaw,
      burnAddressBalance: supply.burnAddressBalance,
      supplyRecipient: supply.supplyRecipient,
      supplyRecipientBalance: supply.supplyRecipientBalance,
      supplyRecipientPct: supplySharePct(supply.supplyRecipientBalance, supply.totalSupply),
      crossCheck: {
        geckoterminalFdvUsd: stats.fdvUsd,
        geckoterminalMarketCapUsd: stats.marketCapUsd,
        dexscreenerFdvUsd,
        geckoterminalDivergencePct: valuationDivergencePct(fdvUsd, stats.fdvUsd),
        dexscreenerDivergencePct: valuationDivergencePct(fdvUsd, dexscreenerFdvUsd),
      },
      supplyFetchedAt: supply.fetchedAt,
      fetchedAt: Date.now(),
      stale: (stats.stale ?? false) || (supply.stale ?? false),
    });
  } catch (err) {
    return publicError(err, "Could not load the $PLANK valuation.");
  }
}
