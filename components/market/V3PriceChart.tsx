"use client";

/**
 * Share-price chart for the Price tab — the NFTX-style big price + change + area
 * chart, drawn from the vault's on-chain reserve history (getV3PriceSeries).
 * Manages its own range + fetch, lazily. Honest when there isn't enough history.
 */

import { useEffect, useMemo, useState } from "react";
import { getV3PriceSeries, formatUnits, type PricePoint } from "@/lib/market/vault-v3";

const RANGES: { id: string; label: string; blocks: number }[] = [
  { id: "1h", label: "1H", blocks: 1_800 },
  { id: "1d", label: "1D", blocks: 43_200 },
  { id: "1w", label: "1W", blocks: 302_400 },
  { id: "1m", label: "1M", blocks: 1_300_000 },
  { id: "all", label: "ALL", blocks: 100_000_000 },
];

const W = 720;
const H = 200;
const PAD = 8;

export default function V3PriceChart({ vaultAddress, currentPrice }: { vaultAddress?: string | null; currentPrice: bigint }) {
  const [rangeId, setRangeId] = useState("all");
  const [series, setSeries] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const blocks = RANGES.find((r) => r.id === rangeId)?.blocks ?? 100_000_000;
    getV3PriceSeries(vaultAddress, 30, blocks)
      .then((s) => { if (!cancelled) setSeries(s); })
      .catch(() => { if (!cancelled) setSeries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vaultAddress, rangeId]);

  const { areaPath, linePath, changePct, up } = useMemo(() => {
    const pts = series ?? [];
    if (pts.length < 2) return { areaPath: "", linePath: "", changePct: 0, up: true };
    const prices = pts.map((p) => p.price);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (hi === lo) { hi = lo * 1.0005 || 1; lo = lo * 0.9995; } // flat line → tiny band
    const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
    const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
    const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
    const change = (prices[prices.length - 1] - prices[0]) / prices[0];
    return { areaPath: area, linePath: line, changePct: change * 100, up: change >= 0 };
  }, [series]);

  const enough = (series?.length ?? 0) >= 2;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-black tabular-nums text-cream">{formatUnits(currentPrice, 5)}</span>
            <span className="text-sm font-bold text-cream-muted">Ξ / share</span>
          </div>
          {enough && (
            <span className={`text-[0.72rem] font-bold tabular-nums ${up ? "text-emerald-400" : "text-rose-400"}`}>
              {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}% <span className="text-cream/40">this range</span>
            </span>
          )}
        </div>
        <div className="flex gap-1 rounded-lg border border-line bg-wood-950 p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRangeId(r.id)}
              aria-pressed={rangeId === r.id}
              className={`min-h-8 rounded px-2.5 text-[0.66rem] font-black tabular-nums ${rangeId === r.id ? "bg-gold-500 text-[#261105]" : "text-cream-muted hover:text-cream"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 h-48 w-full">
        {loading && !series ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-line bg-wood-950 text-[0.75rem] text-cream-muted">Loading price history…</div>
        ) : enough ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full rounded-lg border border-line bg-wood-950">
            <defs>
              <linearGradient id="v3price" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={up ? "rgb(52 211 153)" : "rgb(251 113 133)"} stopOpacity="0.35" />
                <stop offset="100%" stopColor={up ? "rgb(52 211 153)" : "rgb(251 113 133)"} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#v3price)" />
            <path d={linePath} fill="none" stroke={up ? "rgb(52 211 153)" : "rgb(251 113 133)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-line bg-wood-950 px-4 text-center text-[0.75rem] text-cream-muted">
            Not enough trades yet to plot a price line — the chart fills in as the vault sees buys and sells.
          </div>
        )}
      </div>
    </div>
  );
}
