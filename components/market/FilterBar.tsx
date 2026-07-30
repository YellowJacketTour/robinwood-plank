"use client";

import { TIER_ORDER } from "@/lib/rarity";
import type { RarityTier } from "@/lib/rarity";
import type { RarityLookup } from "@/lib/market/rarityClient";

export type MarketFilters = {
  /** Free-text token id search. */
  query: string;
  /** Price bounds in ETH, as typed. Empty string means unbounded. */
  minEth: string;
  maxEth: string;
  /** "all" or one of the site's shared rarity tiers (lib/rarity.ts) — the
   * SAME six-tier scale shown everywhere else, never a second scheme. */
  tier: RarityTier | "all";
};

export const EMPTY_FILTERS: MarketFilters = { query: "", minEth: "", maxEth: "", tier: "all" };

type Props = {
  filters: MarketFilters;
  onChange: (next: MarketFilters) => void;
  /** Count after filtering, shown so an empty grid is never ambiguous. */
  resultCount: number;
  /** Omit to hide the tier filter entirely (e.g. rarity data not loaded yet). */
  rarityAvailable?: boolean;
  orientation?: "inline" | "sidebar";
};

export default function FilterBar({
  filters,
  onChange,
  resultCount,
  rarityAvailable,
  orientation = "inline",
}: Props) {
  const dirty =
    filters.query !== "" || filters.minEth !== "" || filters.maxEth !== "" || filters.tier !== "all";

  if (orientation === "sidebar") {
    return (
      <div className="space-y-5">
        <div>
          <label
            htmlFor="market-token-filter"
            className="mb-2 block text-[0.62rem] font-black uppercase tracking-wider text-gold-300"
          >
            Find a plank
          </label>
          <input
            id="market-token-filter"
            type="search"
            inputMode="numeric"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Token ID"
            className="min-h-11 w-full rounded-md border border-gold-500/30 bg-wood-950 px-3 text-sm text-foreground placeholder:text-foreground/35"
          />
        </div>

        <fieldset>
          <legend className="mb-2 text-[0.62rem] font-black uppercase tracking-wider text-gold-300">
            Price in ETH
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={filters.minEth}
              onChange={(e) => onChange({ ...filters, minEth: e.target.value })}
              placeholder="Min"
              aria-label="Minimum price in ETH"
              className="min-h-11 min-w-0 rounded-md border border-gold-500/30 bg-wood-950 px-3 text-sm text-foreground placeholder:text-foreground/35"
            />
            <input
              type="text"
              inputMode="decimal"
              value={filters.maxEth}
              onChange={(e) => onChange({ ...filters, maxEth: e.target.value })}
              placeholder="Max"
              aria-label="Maximum price in ETH"
              className="min-h-11 min-w-0 rounded-md border border-gold-500/30 bg-wood-950 px-3 text-sm text-foreground placeholder:text-foreground/35"
            />
          </div>
        </fieldset>

        {rarityAvailable && (
          <fieldset>
            <legend className="mb-2 text-[0.62rem] font-black uppercase tracking-wider text-gold-300">
              Rarity
            </legend>
            <div className="space-y-1">
              {(["all", ...TIER_ORDER] as Array<MarketFilters["tier"]>).map((tier) => (
                <label
                  key={tier}
                  className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground/75 hover:bg-gold-500/10"
                >
                  <input
                    type="radio"
                    name="market-rarity"
                    value={tier}
                    checked={filters.tier === tier}
                    onChange={() => onChange({ ...filters, tier })}
                    className="accent-[#d9a441]"
                  />
                  <span>{tier === "all" ? "All rarities" : tier}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-gold-500/20 pt-4">
          <span className="text-[0.68rem] text-foreground/55">{resultCount} items</span>
          {dirty && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTERS)}
              className="min-h-9 rounded-md border border-gold-500/30 px-3 text-xs text-gold-300"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5">
      <input
        type="search"
        inputMode="numeric"
        value={filters.query}
        onChange={(e) => onChange({ ...filters, query: e.target.value })}
        placeholder="Token ID"
        aria-label="Search by token ID"
        className="min-h-9 min-w-0 flex-1 rounded-md border border-gold-500/30 bg-wood-950 px-2.5 text-xs text-foreground placeholder:text-foreground/30 sm:max-w-[10rem]"
      />
      <input
        type="text"
        inputMode="decimal"
        value={filters.minEth}
        onChange={(e) => onChange({ ...filters, minEth: e.target.value })}
        placeholder="Min Ξ"
        aria-label="Minimum price in ETH"
        className="min-h-9 w-[4.5rem] rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground placeholder:text-foreground/30"
      />
      <input
        type="text"
        inputMode="decimal"
        value={filters.maxEth}
        onChange={(e) => onChange({ ...filters, maxEth: e.target.value })}
        placeholder="Max Ξ"
        aria-label="Maximum price in ETH"
        className="min-h-9 w-[4.5rem] rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground placeholder:text-foreground/30"
      />
      {rarityAvailable && (
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Filter by rarity tier</span>
          <select
            value={filters.tier}
            onChange={(e) => onChange({ ...filters, tier: e.target.value as MarketFilters["tier"] })}
            className="min-h-9 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
          >
            <option value="all">Any rarity</option>
            {TIER_ORDER.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {dirty && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="min-h-9 rounded-md border border-gold-500/30 px-2.5 text-xs text-foreground/60 transition hover:border-gold-400"
        >
          Clear
        </button>
      )}
      <span className="ml-auto whitespace-nowrap text-[0.65rem] text-foreground/45">
        {resultCount} items
      </span>
    </div>
  );
}

/**
 * Apply the filters to a list of orders.
 *
 * Price bounds are parsed leniently: an unparseable bound is treated as absent
 * rather than as zero, so a half-typed "0." never silently hides every item.
 * Rarity is looked up from the SAME shared map every card/badge on the page
 * reads (lib/market/rarityClient.ts) — never a second, drifted rarity source.
 */
export function applyFilters<T extends { tokenId?: string; priceWei: string }>(
  items: T[],
  filters: MarketFilters,
  rarityMap?: Map<string, RarityLookup>
): T[] {
  const q = filters.query.trim();
  const min = toWei(filters.minEth);
  const max = toWei(filters.maxEth);

  return items.filter((item) => {
    if (q && !(item.tokenId ?? "").includes(q)) return false;
    let price: bigint;
    try {
      price = BigInt(item.priceWei);
    } catch {
      return false;
    }
    if (min !== null && price < min) return false;
    if (max !== null && price > max) return false;
    if (filters.tier !== "all") {
      // A collection-wide item (no tokenId) has no rarity to match — excluded
      // under any specific tier filter, same as it would be under a search.
      const r = item.tokenId ? rarityMap?.get(item.tokenId) : undefined;
      if (!r || r.tier !== filters.tier) return false;
    }
    return true;
  });
}

function toWei(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  try {
    return BigInt(whole || "0") * BigInt("1000000000000000000") + BigInt(padded || "0");
  } catch {
    return null;
  }
}
