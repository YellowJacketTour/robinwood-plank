"use client";

import { useMemo } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/rarity";
import { collectionFloorWei, formatPremiumBps, tierFloors } from "@/lib/market/floors";
import type { Listing } from "@/lib/market/types";

type Props = {
  listings: Listing[];
  rarity: Map<string, RarityLookup>;
  /** Active tier filter / sweep scope — "all" highlights collection floor chip. */
  activeTier: RarityTier | "all";
  onSelectTier: (tier: RarityTier | "all") => void;
};

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
}: Props) {
  const collFloor = useMemo(() => collectionFloorWei(listings), [listings]);
  const rows = useMemo(() => tierFloors(listings, rarity), [listings, rarity]);

  if (listings.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Floors by rarity
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
              : "border-gold-500/20 bg-black/20 hover:border-gold-500/40"
          }`}
        >
          <p className="text-[0.55rem] font-bold uppercase tracking-wide text-foreground/45">All</p>
          <p className="font-display text-sm tabular-nums text-gold-300">
            {collFloor == null ? "—" : `${formatTokenAmount(collFloor, 18, 3)} Ξ`}
          </p>
          <p className="text-[0.55rem] text-foreground/40">{listings.length} listed</p>
        </button>

        {rows.map((row) => {
          const color = tierColor(row.tier);
          const active = activeTier === row.tier;
          const empty = row.listed === 0;
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
                  ? "bg-black/30 shadow-[0_0_14px_-4px_var(--tier-glow)]"
                  : "border-gold-500/15 bg-black/15 hover:border-gold-500/35"
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
              <p className="font-display text-sm tabular-nums text-foreground">
                {row.floorWei == null ? "—" : `${formatTokenAmount(row.floorWei, 18, 3)} Ξ`}
              </p>
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

