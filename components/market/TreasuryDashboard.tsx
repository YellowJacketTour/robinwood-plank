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
 * The actual "liquidity engine" — fees in ETH, publicly watchable, no new
 * token. See docs/marketplank/SPEC.md §9.
 *
 * There is no fixed target: the owner seeds at their own pace across as many
 * calls as they want, then decides when to call the vault's one-way
 * `openPool()`. Pre-deploy this reads the fee treasury's raw balance as a
 * proxy (the only real number that exists yet). Once the vault ships,
 * `/api/market/treasury` switches to `ethReserve()`/`poolOpen()` straight off
 * the deployed contract.
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

  return (
    <div className="wood-ledger space-y-2 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          Workshop fund
        </span>
        <span className="font-display text-lg text-gold-300">{balanceEth} Ξ</span>
      </div>
      <p className="text-center text-[0.65rem] text-foreground/50">
        {data.open
          ? "Workshop's open — instant swap is live, for good."
          : data.source === "vault"
            ? "Stocking up — the owner opens the workshop when it's ready."
            : "Built from marketplace fees — grows toward the vault's opening day."}
      </p>
    </div>
  );
}
