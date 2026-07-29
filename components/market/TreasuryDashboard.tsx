"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { useVaultLive } from "@/lib/market/useVaultLive";

type TreasuryData = {
  balanceWei: string;
  /** True only once the owner has permanently thrown the one-way openPool() switch. */
  open: boolean;
  source: "vault" | "treasury-proxy";
};

/**
 * Pre-launch bootstrap progress only — once the pool is open this has
 * nothing left to say (VaultDashboard already shows real liquidity).
 * Uses live vault stats.poolOpen as source of truth: /api/market/treasury
 * was falling back to treasury-proxy with open:false after the vault RPC
 * failed on Cloudflare, which re-mounted this "Bootstrapping" card on a
 * live Instant Swap page.
 */
export default function TreasuryDashboard() {
  const { stats } = useVaultLive();
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

  // Live stats win: if the vault is open, never show bootstrap chrome.
  if (stats?.poolOpen === true) return null;
  if (data?.open === true) return null;
  // Still loading — don't flash bootstrap.
  if (stats == null && !data) return null;
  // Only show when we positively know the pool is still closed.
  if (stats?.poolOpen !== false && data?.open !== false) return null;
  if (!data) return null;

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
