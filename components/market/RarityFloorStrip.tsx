"use client";

import { useMemo } from "react";
import { formatTokenAmount, formatTokenAmountCompact } from "@/lib/trade";
import { formatUsd } from "@/lib/eth-price";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/rarity";
import { collectionFloorWei, formatPremiumBps, tierFloors } from "@/lib/market/floors";
import type { Listing } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";
import ChainIcon from "@/components/market/ChainIcon";

/** Renders the same "≈ $X.XX" shape as EthUsdValue, from a real precomputed chain-aware USD value instead of an ETH-only fetch. Null renders nothing, matching EthUsdValue's own null-hides behavior. */
function UsdFigure({ usd, className }: { usd: number | null; className?: string }) {
  if (usd == null) return null;
  return (
    <span className={className} title={`Approximate USD value: ${formatUsd(usd)}`}>
      ≈ {formatUsd(usd)}
    </span>
  );
}

type Props = {
  listings: Listing[];
  rarity: Map<string, RarityLookup>;
  /** Active tier filter / sweep scope — "all" highlights collection floor chip. */
  activeTier: RarityTier | "all";
  onSelectTier: (tier: RarityTier | "all") => void;
  /** Real per-chain native currency these floors are denominated in (see nativeCurrencySymbol in foreign-chain-registry.ts). Defaults to "ETH" only as a last resort -- callers should always pass the real value. */
  currencySymbol?: string;
  /** Real chain slug for ChainIcon's own recognizable per-chain mark instead of a plain-text ticker abbreviation. Defaults to "robinhood" to match currencySymbol's own "ETH" default. */
  chainSlug?: string;
  /** Real chain-aware USD equivalent for a wei amount, precomputed by the caller (lib/multi-asset-price.ts). Omit to keep this strip's own ETH-only EthUsdValue fetch. */
  usdValueFor?: (wei: bigint | string | null) => number | null;
  /** Venue-reported listed count when the loaded book is a page, not the full book. */
  listedTotal?: number | null;
  /** Full catalog counts so a tier with no listing in the loaded book is still filterable. */
  catalogCounts?: Record<string, number>;
  /**
   * Real wash-trade SUSPICION over the sales this floor strip's collection
   * page has loaded -- from lib/market/wash-trade-signal.ts's
   * computeWashSuspicion(), a principled heuristic (exact self-transfers +
   * reciprocal address-pair round-trips), not a fraud determination. Null
   * when there was no evaluable sale (no real from/to addresses to judge).
   */
  washSuspicion?: { ratio: number; evaluatedTradeCount: number } | null;
};

/** Below this many evaluable trades, a suspicion ratio is too noisy to show honestly -- one flagged trade out of two looks alarming (50%) but is not a real signal. Matches this module's general "never falsely accuse a legitimate collection" posture. */
const MIN_EVALUABLE_TRADES_TO_SHOW = 4;
/** Below this ratio, don't bother the user with a near-zero figure -- a couple of stray flagged trades in a large healthy window is expected noise, not a signal worth a UI element. */
const MIN_RATIO_TO_SHOW = 0.03;

function WashSuspicionBadge({ washSuspicion }: { washSuspicion: { ratio: number; evaluatedTradeCount: number } }) {
  if (
    washSuspicion.evaluatedTradeCount < MIN_EVALUABLE_TRADES_TO_SHOW ||
    washSuspicion.ratio < MIN_RATIO_TO_SHOW
  ) {
    return null;
  }
  const pct = Math.round(washSuspicion.ratio * 100);
  // Tone scales with magnitude but never reads as an accusation: amber only
  // past a fairly high bar, otherwise a neutral foreground tint -- this is a
  // heuristic estimate over a loaded sample, not a verdict on the collection.
  const tone = washSuspicion.ratio >= 0.25 ? "text-amber-300/90 border-amber-400/30 bg-amber-500/10" : "text-foreground/55 border-line";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.55rem] font-semibold tabular-nums ${tone}`}
      title={
        `~${pct}% of this page's loaded sale volume matches a real, cited wash-trading heuristic ` +
        `(exact self-transfers, or the same two wallets trading back and forth) over ${washSuspicion.evaluatedTradeCount} evaluable trades. ` +
        `This is an estimate from a public, principled pattern, not a determination that any specific trade or the collection is fraudulent.`
      }
    >
      ⚠︎ ~{pct}% possible wash trades
    </span>
  );
}

/**
 * State-of-the-art floorboard strip: collection floor + each rarity's floor
 * and premium/discount vs the collection floor. Clicking a chip filters the
 * grid and scopes sweeps — one control, two effects, no second scheme.
 */
export default function RarityFloorStrip({
  listings,
  rarity,
  activeTier,
  onSelectTier,
  currencySymbol = "ETH",
  chainSlug = "robinhood",
  usdValueFor,
  listedTotal = null,
  catalogCounts,
  washSuspicion = null,
}: Props) {
  const collFloor = useMemo(() => collectionFloorWei(listings), [listings]);
  const rows = useMemo(() => tierFloors(listings, rarity), [listings, rarity]);

  // Rarity navigation is a catalog capability, not an order-book capability.
  // A venue may report a collection-level listed total before its executable
  // orders have reached our local book (MUGS exposed exactly this state). Keep
  // the proven tier controls available and render unknown floors as dashes.
  if (listings.length === 0 && rarity.size === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <p className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Floors by rarity
          {washSuspicion && <WashSuspicionBadge washSuspicion={washSuspicion} />}
        </p>
        <p className="text-[0.58rem] text-foreground/40">vs collection floor · tap to filter / sweep</p>
      </div>
      <div
        className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="listbox"
        aria-label="Floors by rarity tier"
      >
        <button
          type="button"
          role="option"
          aria-selected={activeTier === "all"}
          onClick={() => onSelectTier("all")}
          className={`min-w-[4.75rem] shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition ${
            activeTier === "all"
              ? "border-gold-400/60 bg-gold-500/15 shadow-[0_0_12px_-4px_rgba(248,217,138,0.45)]"
              : "border-line bg-panel-strong hover:border-line-strong"
          }`}
        >
          <p className="text-[0.55rem] font-bold uppercase tracking-wide text-foreground/45">All</p>
          <p
            className="flex min-w-0 items-center gap-1 font-display text-[clamp(0.85rem,3.5vw,1.05rem)] tabular-nums text-gold-300"
            aria-label={collFloor == null ? "—" : `${formatTokenAmount(collFloor, 18, 3)} ${currencySymbol}`}
          >
            {collFloor == null ? (
              "—"
            ) : (
              <>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={`${formatTokenAmount(collFloor, 18, 8)} ${currencySymbol}`}>
                  {formatTokenAmountCompact(collFloor, 18, 3)}
                </span>
                <ChainIcon chainSlug={chainSlug} size={20} className="shrink-0" />
              </>
            )}
          </p>
          {usdValueFor ? (
            <UsdFigure usd={usdValueFor(collFloor)} className="block text-[clamp(0.55rem,2.2vw,0.65rem)] tabular-nums text-foreground/50" />
          ) : (
            <EthUsdValue wei={collFloor} className="block text-[clamp(0.55rem,2.2vw,0.65rem)] tabular-nums text-foreground/50" />
          )}
          <p className="text-[0.55rem] text-foreground/40">
            {listedTotal != null && listedTotal > listings.length
              ? `${listings.length} loaded · ${listedTotal} reported listed`
              : `${listings.length} listed`}
          </p>
        </button>

        {rows.map((row) => {
          const color = tierColor(row.tier);
          const active = activeTier === row.tier;
          const empty = row.listed === 0 && !(catalogCounts?.[row.tier]);
          return (
            <button
              key={row.tier}
              type="button"
              role="option"
              aria-selected={active}
              disabled={empty}
              onClick={() => onSelectTier(row.tier)}
              className={`min-w-[5.25rem] shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-panel-strong shadow-[0_0_14px_-4px_var(--tier-glow)]"
                  : "border-line bg-panel-strong hover:border-line-strong"
              }`}
              style={
                active
                  ? {
                      borderColor: `${color}99`,
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ["--tier-glow" as any]: `${color}66`,
                    }
                  : { borderColor: `${color}33` }
              }
            >
              <p className="flex items-center gap-1 text-[0.55rem] font-bold uppercase tracking-wide">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                <span style={{ color }}>{row.tier}</span>
              </p>
              <p
                className="flex min-w-0 items-center gap-1 font-display text-[clamp(0.85rem,3.5vw,1.05rem)] tabular-nums text-foreground"
                aria-label={row.floorWei == null ? "—" : `${formatTokenAmount(row.floorWei, 18, 3)} ${currencySymbol}`}
              >
                {row.floorWei == null ? (
                  "—"
                ) : (
                  <>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={`${formatTokenAmount(row.floorWei, 18, 8)} ${currencySymbol}`}>
                      {formatTokenAmountCompact(row.floorWei, 18, 3)}
                    </span>
                    <ChainIcon chainSlug={chainSlug} size={20} className="shrink-0" />
                  </>
                )}
              </p>
              {usdValueFor ? (
                <UsdFigure usd={usdValueFor(row.floorWei)} className="block text-[clamp(0.55rem,2.2vw,0.65rem)] tabular-nums text-foreground/50" />
              ) : (
                <EthUsdValue wei={row.floorWei} className="block text-[clamp(0.55rem,2.2vw,0.65rem)] tabular-nums text-foreground/50" />
              )}
              <p
                className={`text-[0.55rem] tabular-nums ${
                  row.premiumBps == null
                    ? "text-foreground/35"
                    : row.premiumBps > 0
                      ? "text-amber-300/80"
                      : row.premiumBps < 0
                        ? "text-emerald-300/80"
                        : "text-gold-300/70"
                }`}
              >
                {empty ? "none listed" : `${formatPremiumBps(row.premiumBps)} · ${row.listed}`}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

