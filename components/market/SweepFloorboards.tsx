"use client";

import { useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { planSweep, SWEEP_MAX } from "@/lib/market/sweep";
import type { SweepPlan } from "@/lib/market/sweep";
import type { Listing, MarketCollection } from "@/lib/market/types";

type Props = {
  listings: Array<Listing & { rawOrder: unknown }>;
  collection: MarketCollection;
  account: string | null;
  /** Receives a fully validated plan; opens the confirm step. */
  onSweep: (plan: SweepPlan) => void;
};

const COUNTS = [3, 5, 10, SWEEP_MAX];

/**
 * "Sweep the floorboards" — pick how many of the cheapest planks to buy in
 * one transaction. The live total is re-derived client-side from each signed
 * order (planSweep), so the number here is the number the wallet will charge.
 */
export default function SweepFloorboards({ listings, collection, account, onSweep }: Props) {
  const [count, setCount] = useState(COUNTS[0]);

  const plan = useMemo(
    () => planSweep(listings, count, collection, account ?? undefined),
    [listings, count, collection, account]
  );

  // Not enough to sweep: a single listing is just a Buy, zero is nothing.
  if (plan.items.length < 2 && listings.length < 2) {
    return (
      <div className="flex min-h-9 items-center rounded-md border border-dashed border-gold-500/25 px-3 text-xs text-foreground/45">
        🧹 Nothing to sweep
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-foreground/60">🧹</span>
      {COUNTS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => setCount(n)}
          aria-pressed={count === n}
          className={`min-h-9 rounded-md border px-2.5 text-xs font-bold transition ${
            count === n
              ? "border-gold-400 bg-gold-500/15 text-gold-300"
              : "border-gold-500/30 text-foreground/60 hover:border-gold-400"
          }`}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        disabled={plan.items.length === 0}
        onClick={() => onSweep(plan)}
        className="min-h-9 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-40"
      >
        Sweep {plan.items.length} · {formatTokenAmount(plan.totalWei, 18, 4)} Ξ
      </button>
    </div>
  );
}
