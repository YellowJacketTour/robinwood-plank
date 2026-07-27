"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";

type TreasuryData = {
  balanceWei: string;
  targetWei: string;
  readyToSeed: boolean;
  progressPct: number;
};

/**
 * The actual "liquidity engine" — fees in ETH, publicly watchable, no new
 * token. See docs/marketplank/SPEC.md §9.
 */
export default function TreasuryDashboard() {
  const [data, setData] = useState<TreasuryData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/treasury")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && !d.error) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  const balanceEth = formatTokenAmount(data.balanceWei, 18, 4);
  const targetEth = formatTokenAmount(data.targetWei, 18, 2);

  return (
    <div className="wood-ledger space-y-2 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          Liquidity engine
        </span>
        <span className="font-display text-lg text-gold-300">{balanceEth} Ξ</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-wood-900/70">
        <div
          className="h-full rounded-full bg-gold-500 transition-all"
          style={{ width: `${data.progressPct}%` }}
        />
      </div>
      <p className="text-center text-[0.65rem] text-foreground/50">
        {data.readyToSeed
          ? "Ready to seed the instant-swap vault."
          : `Built from marketplace fees — ${targetEth} Ξ funds the instant-swap vault.`}
      </p>
    </div>
  );
}
