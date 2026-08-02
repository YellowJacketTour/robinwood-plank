"use client";

import { useEffect, useState } from "react";
import type { PlankPool } from "@/lib/plank-price-types";
import { SkeletonRows } from "@/components/Skeleton";

type ApiResponse = {
  pools: PlankPool[];
  totalLiquidityUsd: number | null;
  totalVolumeUsd24h: number | null;
  fetchedAt: number;
  stale: boolean;
};

function formatCompactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1) return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function dexLabel(pool: PlankPool): string {
  const dex = pool.dexId === "uniswap" ? "Uniswap" : pool.dexId === "sushiswap" ? "Sushiswap" : pool.dexId;
  return pool.version ? `${dex} ${pool.version}` : dex;
}

/**
 * $PLANK trades across multiple real pools (Uniswap v2/v3/v4, Sushiswap v3)
 * with very different depth. The price chart above this panel tracks only
 * the single deepest pool as its price reference — this panel is the honest
 * token-level view so nobody mistakes one venue's liquidity for the whole
 * picture. Self-contained: owns its own fetch against /api/trade/pools,
 * which proxies DexScreener server-side (see lib/plank-pools.ts).
 */
export default function PlankPoolsPanel({ active = true }: { active?: boolean } = {}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/trade/pools")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json: ApiResponse) => {
          if (cancelled) return;
          setData(json);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };
    load();
    const id = active ? setInterval(load, 60_000) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [active]);

  const isLoading = data == null && !error;
  const isEmpty = data != null && data.pools.length === 0;

  return (
    <div className="w-full min-w-0 space-y-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-cream">
            $PLANK Pools
          </p>
          <p className="truncate text-[0.62rem] text-cream-muted">
            Every real trading venue, not just the one the chart tracks
          </p>
        </div>
      </div>

      {data?.stale && (
        <p className="w-fit rounded-md bg-[#8a6a1f]/25 px-2 py-1 text-[0.6rem] font-bold text-gold-300">
          Showing last known data — live feed is temporarily unavailable
        </p>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
          <p className="truncate text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
            Total Liquidity (all pools)
          </p>
          <p className="truncate text-[0.72rem] font-black text-cream">
            {formatCompactUsd(data?.totalLiquidityUsd)}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
          <p className="truncate text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
            Total 24H Volume (all pools)
          </p>
          <p className="truncate text-[0.72rem] font-black text-cream">
            {formatCompactUsd(data?.totalVolumeUsd24h)}
          </p>
        </div>
      </div>

      {error && data == null ? (
        <p className="rounded-lg border border-line bg-wood-950 px-3 py-6 text-center text-xs text-cream-muted">
          Could not load the $PLANK pool list.
        </p>
      ) : isLoading ? (
        <SkeletonRows rows={3} columns={["w-20", "w-14", "w-14", "w-10"]} />
      ) : isEmpty ? (
        <p className="rounded-lg border border-line bg-wood-950 px-3 py-6 text-center text-xs text-cream-muted">
          No $PLANK pools found.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-[0.66rem]">
            <thead>
              <tr className="text-left text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
                <th className="pb-1 pr-2">Pool</th>
                <th className="pb-1 pr-2">Liquidity</th>
                <th className="pb-1 pr-2">24H Volume</th>
                <th className="pb-1">Link</th>
              </tr>
            </thead>
            <tbody>
              {data?.pools.map((pool) => (
                <tr key={pool.pairAddress} className="border-t border-line">
                  <td className="py-1.5 pr-2 font-bold text-cream">
                    {dexLabel(pool)}
                    <span className="block text-cream-muted/70">PLANK/{pool.quoteSymbol}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-cream">{formatCompactUsd(pool.liquidityUsd)}</td>
                  <td className="py-1.5 pr-2 text-cream">{formatCompactUsd(pool.volumeUsd24h)}</td>
                  <td className="py-1.5">
                    <a
                      href={pool.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold text-gold-300 underline decoration-gold-500/40 underline-offset-2 hover:text-gold-200"
                    >
                      View ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
