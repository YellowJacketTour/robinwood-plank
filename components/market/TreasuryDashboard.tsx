"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";

type TreasuryData = {
  balanceWei: string;
  /** True only once the owner has permanently thrown the one-way openPool() switch. */
  open: boolean;
  source: "vault" | "treasury-proxy";
};

/**
 * Pre-launch bootstrap progress only — "the owner is stocking the vault,
 * here's how full it is." Once poolOpen flips true this has nothing left
 * to say (VaultDashboard already shows real liquidity/rate/inventory), so
 * it renders nothing rather than a stale "the workshop is open" message
 * sitting on screen forever after it stopped being useful. See
 * docs/marketplank/SPEC.md §9.
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

  if (!data || data.open) return null;

  const balanceEth = formatTokenAmount(data.balanceWei, 18, 4);

  return (
    <div className="wood-ledger space-y-2 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          Bootstrapping
        </span>
        <span className="font-display text-lg text-gold-300">{balanceEth} Ξ</span>
      </div>
      <p className="text-center text-[0.65rem] text-foreground/50">
        {data.source === "vault" ? "Stocking the vault." : "Building toward launch."}
      </p>
    </div>
  );
}
