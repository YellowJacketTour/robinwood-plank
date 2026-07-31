"use client";

import { useCallback, useEffect, useState } from "react";
import { BUTTON_SECONDARY, CARD, LABEL } from "../ui";

/**
 * Analytics section — aggregates the market/trade APIs the site already
 * computes into one admin overview. Nothing is recomputed here; each tile
 * names its source endpoint.
 */

type SalesStats = {
  saleCount: number;
  highestWei: string | null;
  totalVolumeWei: string | null;
};

type Pools = {
  totalLiquidityUsd?: number;
  totalVolumeUsd24h?: number;
  stale?: boolean;
};

type PriceHistory = {
  stats?: { last?: number; changePct?: number } | null;
  candles?: unknown[];
  stale?: boolean;
};

type Activity = { events?: { kind: string }[] };

function fromWei(wei: string | null | undefined, dp = 3): string {
  if (!wei) return "—";
  try {
    const v = BigInt(wei);
    const base = BigInt(10) ** BigInt(18);
    const fracStr = ((base + (v % base)).toString().slice(1, 1 + dp) || "0");
    return `${(v / base).toLocaleString()}.${fracStr}`;
  } catch {
    return "—";
  }
}

function usd(v: number | undefined): string {
  return typeof v === "number"
    ? v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";
}

function Tile({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source: string;
}) {
  return (
    <div className="rounded-md border border-line bg-panel-strong p-3">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-gold-300">{value}</p>
      <p className="mt-1 font-mono text-[0.6rem] text-cream-muted/70">{source}</p>
    </div>
  );
}

// Read-only — ignores the shell's `address` prop.
export default function AnalyticsSection() {
  const [sales, setSales] = useState<SalesStats | null>(null);
  const [pools, setPools] = useState<Pools | null>(null);
  const [price, setPrice] = useState<PriceHistory | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const grab = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [s, p, ph, a] = await Promise.all([
      grab<SalesStats>("/api/market/sales-stats"),
      grab<Pools>("/api/trade/pools"),
      grab<PriceHistory>("/api/trade/price-history?range=24H"),
      grab<Activity>("/api/market/activity"),
    ]);
    setSales(s);
    setPools(p);
    setPrice(ph);
    setActivity(a);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const eventCounts = (activity?.events ?? []).reduce<Record<string, number>>(
    (acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Analytics</h2>
          <p className={`mt-1 ${LABEL}`}>
            Aggregated from the live market &amp; trade APIs
          </p>
        </div>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-cream-muted">Loading…</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Tile
              label="NFT sales (all time)"
              value={sales ? sales.saleCount.toLocaleString() : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="NFT volume"
              value={sales ? `${fromWei(sales.totalVolumeWei)} ETH` : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="Highest sale"
              value={sales ? `${fromWei(sales.highestWei)} ETH` : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="$PLANK liquidity"
              value={usd(pools?.totalLiquidityUsd)}
              source="/api/trade/pools"
            />
            <Tile
              label="$PLANK 24h volume"
              value={usd(pools?.totalVolumeUsd24h)}
              source="/api/trade/pools"
            />
            <Tile
              label="$PLANK 24h change"
              value={
                typeof price?.stats?.changePct === "number"
                  ? `${price.stats.changePct > 0 ? "+" : ""}${price.stats.changePct.toFixed(2)}%`
                  : "—"
              }
              source="/api/trade/price-history"
            />
          </div>

          <div className="mt-3 rounded-md border border-line bg-panel-strong p-3">
            <p className={LABEL}>Recent on-chain activity (last fetch window)</p>
            {Object.keys(eventCounts).length === 0 ? (
              <p className="mt-2 text-sm text-cream-muted">No events returned.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {Object.entries(eventCounts).map(([kind, count]) => (
                  <li
                    key={kind}
                    className="rounded-full border border-line px-3 py-1 text-cream"
                  >
                    {kind}: <span className="tabular-nums text-gold-300">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 font-mono text-[0.6rem] text-cream-muted/70">
              /api/market/activity
            </p>
          </div>
        </>
      )}
    </section>
  );
}
