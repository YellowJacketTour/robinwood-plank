"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CandlestickSeries } from "lightweight-charts";
import type { IChartApi, ISeriesApi, CandlestickData, UTCTimestamp } from "lightweight-charts";
import type { PlankCandle, PriceRange } from "@/lib/plank-price-types";
import { PRICE_RANGES } from "@/lib/plank-price-types";

type Denomination = "ETH" | "USD";
const DENOMINATIONS: Denomination[] = ["ETH", "USD"];

/**
 * $PLANK trades at sub-cent, often sub-1e-9 magnitudes against both ETH and
 * USD — fixed-decimal formatting rounds those straight to "0.000...0". Use
 * exponential notation below a threshold so the real precision stays honest.
 */
function formatTinyPrice(value: number, unit: "Ξ" | "$"): string {
  if (!Number.isFinite(value) || value === 0) {
    return unit === "$" ? "$0" : "0 Ξ";
  }
  const abs = Math.abs(value);
  const body =
    abs < 0.0001 ? value.toExponential(3) : abs < 1 ? value.toFixed(8) : value.toFixed(4);
  return unit === "$" ? `$${body}` : `${body} Ξ`;
}

type ApiResponse = {
  range: PriceRange;
  pool: string;
  fetchedAt: number;
  stale: boolean;
  candles: PlankCandle[];
};

function toBar(candle: PlankCandle, denom: Denomination): CandlestickData<UTCTimestamp> {
  return denom === "ETH"
    ? {
        time: candle.time as UTCTimestamp,
        open: candle.openEth,
        high: candle.highEth,
        low: candle.lowEth,
        close: candle.closeEth,
      }
    : {
        time: candle.time as UTCTimestamp,
        open: candle.openUsd,
        high: candle.highUsd,
        low: candle.lowUsd,
        close: candle.closeUsd,
      };
}

/**
 * $PLANK/WETH price chart for /trade — real OHLCV from the live Uniswap v3
 * pool (via our server-side GeckoTerminal proxy, lib/plank-price.ts), never
 * the Marketplank NFT vault. Buy vs Redeem stay separate concerns; this
 * chart only ever renders what the real pool traded.
 */
export default function PlankPriceChart({ active = true }: { active?: boolean } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [range, setRange] = useState<PriceRange>("24H");
  const [denom, setDenom] = useState<Denomination>("ETH");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetch(`/api/trade/price-history?range=${range}`)
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
    const intervalMs = range === "24H" ? 60_000 : range === "7D" ? 5 * 60_000 : 10 * 60_000;
    const id = active ? setInterval(load, intervalMs) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [range, active]);

  const bars = useMemo<CandlestickData<UTCTimestamp>[]>(() => {
    if (!data?.candles?.length) return [];
    return data.candles.map((c) => toBar(c, denom));
  }, [data, denom]);

  const latest = data?.candles?.length ? data.candles[data.candles.length - 1] : null;
  const first = data?.candles?.length ? data.candles[0] : null;
  const changePct =
    latest && first && first.closeUsd > 0
      ? ((latest.closeUsd - first.closeUsd) / first.closeUsd) * 100
      : null;

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(230, 210, 170, 0.6)",
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: "rgba(239, 196, 99, 0.055)" },
        horzLines: { color: "rgba(239, 196, 99, 0.055)" },
      },
      rightPriceScale: { borderColor: "rgba(239, 196, 99, 0.15)" },
      timeScale: { borderColor: "rgba(239, 196, 99, 0.15)", timeVisible: true },
      crosshair: {
        vertLine: { labelBackgroundColor: "#8a6a1f" },
        horzLine: { labelBackgroundColor: "#8a6a1f" },
      },
      height: 280,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#6ee7a2",
      downColor: "#fca5a5",
      borderVisible: false,
      wickUpColor: "#6ee7a2",
      wickDownColor: "#fca5a5",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Mount once; data updates go through setData() below against a stable
    // chart instance (same rationale as NftPriceChart's own mount effect).
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    seriesRef.current.applyOptions({
      priceFormat:
        denom === "ETH"
          ? { type: "custom", formatter: (p: number) => formatTinyPrice(p, "Ξ"), minMove: 1e-15 }
          : { type: "custom", formatter: (p: number) => formatTinyPrice(p, "$"), minMove: 1e-13 },
    });
    if (bars.length === 0) return;
    seriesRef.current.setData(bars);
    chartRef.current.timeScale().fitContent();
  }, [bars, denom]);

  const isEmpty = data != null && data.candles.length === 0;
  const isLoading = data == null && !error;

  return (
    <div className="w-full min-w-0 space-y-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-cream">
            $PLANK / ETH
          </p>
          <p className="truncate text-[0.62rem] text-cream-muted">
            Live Uniswap v3 pool price{data?.stale ? " · showing last known data" : ""}
          </p>
        </div>
        {changePct != null && (
          <span
            className={`shrink-0 text-[0.68rem] font-bold ${
              changePct >= 0 ? "text-[#6ee7a2]" : "text-[#fca5a5]"
            }`}
          >
            {changePct >= 0 ? "+" : ""}
            {changePct.toFixed(2)}%
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-[9px] bg-wood-950 p-1">
          {DENOMINATIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDenom(d)}
              className={`rounded-md px-2 py-1 text-[0.6rem] font-black transition ${
                denom === d ? "bg-gold-500 text-wood-950" : "text-[#a99c84] hover:text-gold-300"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-[9px] bg-wood-950 p-1">
          {PRICE_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-1 text-[0.6rem] font-black transition ${
                range === r ? "bg-gold-500 text-wood-950" : "text-[#a99c84] hover:text-gold-300"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* The container stays mounted unconditionally — the chart-init effect
          below only runs once, so if this div came and went with loading
          state the chart would never attach once real data arrived. Loading
          / empty / error states render as an overlay on top instead. */}
      <div className="relative">
        <div
          ref={containerRef}
          className="w-full min-h-[280px] overflow-hidden rounded-lg border border-line bg-wood-950"
        />
        {error && data == null ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-wood-950/95 px-3 text-center text-xs text-cream-muted">
            Could not load $PLANK price history.
          </div>
        ) : isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-wood-950/95 px-3 text-center text-xs text-cream-muted">
            Loading price history…
          </div>
        ) : isEmpty ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-wood-950/95 px-3 text-center text-xs text-cream-muted">
            No priced trades on the PLANK/WETH pool yet for this range.
          </div>
        ) : null}
      </div>

      {/* break-all (not truncate/nowrap) so a long pool address can never
          force a min-content width onto ancestors — a nowrap+ellipsis
          paragraph's min-content is its FULL un-truncated width, which
          overflows any shrink-to-fit ancestor (e.g. an mx-auto flex child)
          long before overflow-hidden ever gets a chance to clip it. */}
      <p className="break-all text-[0.6rem] text-cream-muted/70">
        Pool {data?.pool ?? "0x3CE05Efe2e7C9c136f12a1Be695f75F807B6c69E"} · Uniswap v3, Robinhood Chain
      </p>
    </div>
  );
}
