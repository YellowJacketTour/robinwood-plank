"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { swrJson } from "@/lib/market/swr-fetch";

type SaleLike = {
  tokenId: string;
  priceWei: string | null;
  timestamp: string | null;
};

type Props = {
  sales: SaleLike[];
};

type CatalogSale = {
  tokenId: string;
  priceWei: string;
  timestamp: string | null;
  txHash?: string;
};

function stat(label: string, value: string) {
  return (
    <div className="rounded-lg border border-gold-500/20 bg-wood-950/90 px-3 py-2.5">
      <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
        {label}
      </dt>
      <dd className="mt-0.5 font-display text-lg tabular-nums text-gold-300">{value}</dd>
    </div>
  );
}

/**
 * Priced-sale stats + ETH-over-time sparkline.
 * Merges activity-feed sales with the royalty-aware sales catalog so the
 * chart still has real Ξ points when the short activity window is sparse.
 */
export default function ActivityStats({ sales }: Props) {
  const [catalogSales, setCatalogSales] = useState<CatalogSale[]>([]);

  useEffect(() => {
    let cancelled = false;
    // sales-stats only returns aggregates; pull full catalog via activity full
    // and also accept catalog from a lightweight endpoint if we only have stats.
    // Use activity full=1 for timestamps when available; merge catalog prices
    // from sales-stats is insufficient — re-fetch catalog via dedicated field.
    swrJson<{
      saleCount?: number;
      highestWei?: string | null;
      // Prefer embedding recent sales if API grows; until then use activity sales
      // + synthetic points from known priced activity.
    }>("/api/market/sales-stats", { ttlMs: 60_000, swrMs: 300_000, session: true })
      .then(() => {
        /* stats used only as signal that catalog exists */
      })
      .catch(() => {});

    // Load royalty catalog sales for the chart (v2 blob via internal helper route).
    swrJson<{ sales?: CatalogSale[] }>("/api/market/sales-history", {
      ttlMs: 60_000,
      swrMs: 300_000,
      session: true,
    })
      .then((d) => {
        if (!cancelled && Array.isArray(d.sales)) setCatalogSales(d.sales);
      })
      .catch(() => {
        /* optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const priced = useMemo(() => {
    const map = new Map<string, { tokenId: string; priceWei: string; timestamp: string | null; wei: bigint; t: number }>();
    const add = (tokenId: string, priceWei: string, timestamp: string | null, keyHint?: string) => {
      try {
        const wei = BigInt(priceWei);
        if (wei <= BigInt(0)) return;
        const t = timestamp ? new Date(timestamp).getTime() : 0;
        const key = keyHint || `${tokenId}:${priceWei}:${timestamp || ""}`;
        const prev = map.get(key);
        if (!prev || (t && !prev.t)) {
          map.set(key, { tokenId, priceWei, timestamp, wei, t });
        }
      } catch {
        /* skip */
      }
    };
    for (const s of sales) {
      if (s.priceWei) add(s.tokenId, s.priceWei, s.timestamp);
    }
    for (const s of catalogSales) {
      if (s.priceWei) add(s.tokenId, s.priceWei, s.timestamp, s.txHash ? `${s.txHash}:${s.tokenId}` : undefined);
    }
    return Array.from(map.values()).sort((a, b) => {
      // chronological for chart (oldest → newest)
      if (a.t && b.t) return a.t - b.t;
      if (a.t) return -1;
      if (b.t) return 1;
      return 0;
    });
  }, [sales, catalogSales]);

  if (priced.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-3 py-6 text-center text-xs text-foreground/45">
        No priced sales yet — stats appear once trades settle.
      </div>
    );
  }

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const last24h = priced.filter((s) => s.t >= dayAgo);

  const sumWei = (rows: typeof priced) => rows.reduce((acc, r) => acc + r.wei, BigInt(0));
  const totalVolumeWei = sumWei(priced);
  const volume24hWei = sumWei(last24h);
  const avgWei = priced.length ? totalVolumeWei / BigInt(priced.length) : BigInt(0);

  // Chart series: prefer last 24h if ≥2 points, else last 24 sales overall.
  const series24 = last24h.length >= 2 ? last24h : priced.slice(-24);
  const maxWei = series24.reduce((m, r) => (r.wei > m ? r.wei : m), BigInt(1));
  const minWei = series24.reduce((m, r) => (r.wei < m ? r.wei : m), maxWei);

  const chartW = 100;
  const chartH = 40;
  const padY = 4;
  const points = series24
    .map((r, i) => {
      const x = series24.length > 1 ? (i / (series24.length - 1)) * chartW : chartW / 2;
      const span = maxWei - minWei;
      const ratio =
        span > BigInt(0) ? Number(r.wei - minWei) / Number(span) : 0.5;
      const y = chartH - padY - ratio * (chartH - padY * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  // Axis labels: first / mid / last ETH
  const first = series24[0];
  const mid = series24[Math.floor(series24.length / 2)];
  const last = series24[series24.length - 1];
  const fmtEth = (wei: bigint) => formatTokenAmount(wei.toString(), 18, 4);
  const fmtTime = (t: number) =>
    t
      ? new Date(t).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  const chartTitle =
    last24h.length >= 2
      ? `Price · last 24h (${series24.length} sales)`
      : `Price · last ${series24.length} sales`;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        {stat("24h volume", `${formatTokenAmount(volume24hWei.toString(), 18, 4)} Ξ`)}
        {stat("Total volume", `${formatTokenAmount(totalVolumeWei.toString(), 18, 3)} Ξ`)}
        {stat("Priced sales", String(priced.length))}
        {stat("Avg price", `${formatTokenAmount(avgWei.toString(), 18, 4)} Ξ`)}
      </dl>

      <div className="rounded-lg border border-gold-500/20 bg-wood-950/90 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
            {chartTitle}
          </p>
          <p className="font-mono text-[0.65rem] tabular-nums text-gold-300">
            {fmtEth(minWei)}–{fmtEth(maxWei)} Ξ
          </p>
        </div>
        <svg
          viewBox={`0 0 ${chartW} ${chartH}`}
          className="mt-2 h-20 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="Sale price over time in ETH"
        >
          {/* grid lines */}
          <line x1="0" y1={padY} x2={chartW} y2={padY} stroke="rgba(248,217,138,0.12)" strokeWidth="0.5" />
          <line
            x1="0"
            y1={chartH / 2}
            x2={chartW}
            y2={chartH / 2}
            stroke="rgba(248,217,138,0.12)"
            strokeWidth="0.5"
          />
          <line
            x1="0"
            y1={chartH - padY}
            x2={chartW}
            y2={chartH - padY}
            stroke="rgba(248,217,138,0.12)"
            strokeWidth="0.5"
          />
          <polyline
            points={points}
            fill="none"
            stroke="#f8d98a"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* dots */}
          {series24.map((r, i) => {
            const x = series24.length > 1 ? (i / (series24.length - 1)) * chartW : chartW / 2;
            const span = maxWei - minWei;
            const ratio = span > BigInt(0) ? Number(r.wei - minWei) / Number(span) : 0.5;
            const y = chartH - padY - ratio * (chartH - padY * 2);
            return <circle key={i} cx={x} cy={y} r="1.2" fill="#f8d98a" />;
          })}
        </svg>
        <div className="mt-1.5 flex justify-between gap-1 text-[0.55rem] text-foreground/50">
          <span className="min-w-0 truncate" title={fmtTime(first.t)}>
            {fmtEth(first.wei)} Ξ
            <span className="block text-foreground/35">{fmtTime(first.t)}</span>
          </span>
          {series24.length > 2 && (
            <span className="min-w-0 truncate text-center" title={fmtTime(mid.t)}>
              {fmtEth(mid.wei)} Ξ
              <span className="block text-foreground/35">{fmtTime(mid.t)}</span>
            </span>
          )}
          <span className="min-w-0 truncate text-right" title={fmtTime(last.t)}>
            {fmtEth(last.wei)} Ξ
            <span className="block text-foreground/35">{fmtTime(last.t)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
