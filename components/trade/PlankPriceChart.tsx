"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  AreaSeries,
  HistogramSeries,
} from "lightweight-charts";
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  AreaData,
  HistogramData,
  UTCTimestamp,
  MouseEventParams,
  Time,
} from "lightweight-charts";
import type { PlankCandle, PlankPoolStats, PriceRange } from "@/lib/plank-price-types";
import { PRICE_RANGES } from "@/lib/plank-price-types";

type Denomination = "ETH" | "USD";
const DENOMINATIONS: Denomination[] = ["ETH", "USD"];

type ChartMode = "candles" | "line";
const CHART_MODES: { id: ChartMode; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "line", label: "Line" },
];

const UP_COLOR = "#6ee7a2";
const DOWN_COLOR = "#fca5a5";

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
function toSubscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

/**
 * $PLANK trades at sub-cent, often sub-1e-9 magnitudes against both ETH and
 * USD — fixed-decimal formatting rounds those straight to "0.000...0". Below
 * 1e-4 this switches to subscript-zero notation (0.0₉2643), the same
 * convention real DEX UIs use for micro-cap tokens: the subscript is the
 * exact count of leading zeros after the decimal point, followed by four
 * real significant digits. Nothing here is rounded away or hidden.
 */
function formatTinyPrice(value: number, unit: "Ξ" | "$"): string {
  if (!Number.isFinite(value) || value === 0) {
    return unit === "$" ? "$0" : "0 Ξ";
  }
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1) {
    body = abs.toFixed(4);
  } else if (abs >= 0.0001) {
    body = abs.toFixed(8);
  } else {
    const exp = Math.floor(Math.log10(abs));
    const zeroCount = -exp - 1;
    const digits = abs.toExponential(3).split("e")[0].replace(".", "");
    body = `0.0${toSubscript(zeroCount)}${digits}`;
  }
  return unit === "$" ? `${sign}$${body}` : `${sign}${body} Ξ`;
}

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

type ApiResponse = {
  range: PriceRange;
  pool: string;
  fetchedAt: number;
  stale: boolean;
  candles: PlankCandle[];
  stats: PlankPoolStats | null;
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

function toLinePoint(candle: PlankCandle, denom: Denomination): AreaData<UTCTimestamp> {
  return {
    time: candle.time as UTCTimestamp,
    value: denom === "ETH" ? candle.closeEth : candle.closeUsd,
  };
}

function toVolumeBar(candle: PlankCandle): HistogramData<UTCTimestamp> {
  return {
    time: candle.time as UTCTimestamp,
    value: candle.volumeUsd,
    color: candle.closeUsd >= candle.openUsd ? "rgba(110, 231, 162, 0.5)" : "rgba(252, 165, 165, 0.5)",
  };
}

function formatTooltipTime(unixSeconds: number, range: PriceRange): string {
  const date = new Date(unixSeconds * 1000);
  if (range === "24H") {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Tooltip = { x: number; y: number; candle: PlankCandle };

/**
 * $PLANK/WETH price chart for /trade — real OHLCV from the live Uniswap v3
 * pool (via our server-side GeckoTerminal proxy, lib/plank-price.ts), never
 * the Marketplank NFT vault. Buy vs Redeem stay separate concerns; this
 * chart only ever renders what the real pool traded.
 */
export default function PlankPriceChart({ active = true }: { active?: boolean } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const areaSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [range, setRange] = useState<PriceRange>("24H");
  const [denom, setDenom] = useState<Denomination>("ETH");
  const [mode, setMode] = useState<ChartMode>("candles");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState(false);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const [containerWidth, setContainerWidth] = useState(300);

  // Ref so the crosshair handler (subscribed once, at mount) always reads
  // the latest candle lookup without needing to re-subscribe.
  const candleByTimeRef = useRef<Map<number, PlankCandle>>(new Map());
  useEffect(() => {
    const map = new Map<number, PlankCandle>();
    for (const c of data?.candles ?? []) map.set(c.time, c);
    candleByTimeRef.current = map;
  }, [data]);

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

  const linePoints = useMemo<AreaData<UTCTimestamp>[]>(() => {
    if (!data?.candles?.length) return [];
    return data.candles.map((c) => toLinePoint(c, denom));
  }, [data, denom]);

  const volumeBars = useMemo<HistogramData<UTCTimestamp>[]>(() => {
    if (!data?.candles?.length) return [];
    return data.candles.map(toVolumeBar);
  }, [data]);

  const stats = data?.stats ?? null;
  const latest = data?.candles?.length ? data.candles[data.candles.length - 1] : null;
  const first = data?.candles?.length ? data.candles[0] : null;
  const rangeChangePct =
    latest && first && first.closeUsd > 0
      ? ((latest.closeUsd - first.closeUsd) / first.closeUsd) * 100
      : null;
  // Prefer the pool's real 24h change (independent of the selected range);
  // fall back to the in-range change only if stats haven't loaded yet.
  const headlineChangePct = stats?.priceChangePct.h24 ?? rangeChangePct;

  const currentPrice =
    denom === "ETH"
      ? stats?.priceEth ?? latest?.closeEth ?? null
      : stats?.priceUsd ?? latest?.closeUsd ?? null;

  // Chart init — mounts once. Data flows in through setData() below against
  // a stable chart/series instance, same rationale as NftPriceChart.
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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: "#efc463",
      topColor: "rgba(239, 196, 99, 0.25)",
      bottomColor: "rgba(239, 196, 99, 0)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      visible: false,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "plank-volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    areaSeriesRef.current = areaSeries;
    volumeSeriesRef.current = volumeSeries;

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      if (!param.point || param.time == null) {
        setTooltip(null);
        return;
      }
      const t = typeof param.time === "number" ? param.time : Number(param.time);
      const candle = candleByTimeRef.current.get(t);
      if (!candle) {
        setTooltip(null);
        return;
      }
      setTooltip({ x: param.point.x, y: param.point.y, candle });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth;
        chart.applyOptions({ width });
        setContainerWidth(width);
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      areaSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Toggle which price series is visible without tearing the chart down.
  useEffect(() => {
    candleSeriesRef.current?.applyOptions({ visible: mode === "candles" });
    areaSeriesRef.current?.applyOptions({ visible: mode === "line" });
  }, [mode]);

  useEffect(() => {
    const priceFormat =
      denom === "ETH"
        ? { type: "custom" as const, formatter: (p: number) => formatTinyPrice(p, "Ξ"), minMove: 1e-15 }
        : { type: "custom" as const, formatter: (p: number) => formatTinyPrice(p, "$"), minMove: 1e-13 };
    candleSeriesRef.current?.applyOptions({ priceFormat });
    areaSeriesRef.current?.applyOptions({ priceFormat });

    if (bars.length > 0) candleSeriesRef.current?.setData(bars);
    if (linePoints.length > 0) areaSeriesRef.current?.setData(linePoints);
    if (volumeBars.length > 0) volumeSeriesRef.current?.setData(volumeBars);
    if (bars.length > 0 || linePoints.length > 0) chartRef.current?.timeScale().fitContent();
  }, [bars, linePoints, volumeBars, denom]);

  const isEmpty = data != null && data.candles.length === 0;
  const isLoading = data == null && !error;

  const tooltipCandle = tooltip?.candle ?? null;
  const tooltipStyle = tooltip
    ? {
        left: Math.min(Math.max(tooltip.x + 12, 4), containerWidth - 176),
        top: Math.min(Math.max(tooltip.y + 12, 4), 220),
      }
    : null;

  return (
    <div className="w-full min-w-0 space-y-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-cream">
            $PLANK / ETH
          </p>
          <p className="truncate text-[0.62rem] text-cream-muted">
            Live Uniswap v3 pool price
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {currentPrice != null && (
            <span className="text-[0.78rem] font-black text-gold-300">
              {formatTinyPrice(currentPrice, denom === "ETH" ? "Ξ" : "$")}
            </span>
          )}
          {headlineChangePct != null && (
            <span
              className={`text-[0.66rem] font-bold ${
                headlineChangePct >= 0 ? "text-[#6ee7a2]" : "text-[#fca5a5]"
              }`}
            >
              {headlineChangePct >= 0 ? "+" : ""}
              {headlineChangePct.toFixed(2)}% · 24H
            </span>
          )}
        </div>
      </div>

      {data?.stale && (
        <p className="w-fit rounded-md bg-[#8a6a1f]/25 px-2 py-1 text-[0.6rem] font-bold text-gold-300">
          Showing last known data — live feed is temporarily unavailable
        </p>
      )}

      {/* Stat strip — real GeckoTerminal pool stats, cached server-side.
          Tiles render with "—" rather than disappearing when a field is
          momentarily unavailable, so the layout never jumps on refresh. */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <StatTile label="24H Volume" value={formatCompactUsd(stats?.volumeUsd24h)} />
        <StatTile label="Liquidity" value={formatCompactUsd(stats?.liquidityUsd)} />
        <StatTile label="FDV" value={formatCompactUsd(stats?.fdvUsd)} />
        <StatTile
          label="Buys / Sells (24H)"
          value={
            stats?.transactions24h
              ? `${stats.transactions24h.buys} / ${stats.transactions24h.sells}`
              : "—"
          }
        />
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
        <div className="flex gap-1 rounded-[9px] bg-wood-950 p-1">
          {CHART_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`rounded-md px-2 py-1 text-[0.6rem] font-black transition ${
                mode === m.id ? "bg-gold-500 text-wood-950" : "text-[#a99c84] hover:text-gold-300"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* The container stays mounted unconditionally — the chart-init effect
          above only runs once, so if this div came and went with loading
          state the chart would never attach once real data arrived. Loading
          / empty / error states render as an overlay on top instead. */}
      <div className="relative">
        <div
          ref={containerRef}
          className="w-full min-h-[280px] overflow-hidden rounded-lg border border-line bg-wood-950"
        />

        {tooltipCandle && tooltipStyle && !isLoading && !isEmpty && (
          <div
            className="pointer-events-none absolute z-10 w-44 space-y-0.5 rounded-md border border-line bg-wood-950/95 p-2 text-[0.62rem] text-cream-muted shadow-lg"
            style={tooltipStyle}
          >
            <p className="font-black text-cream">{formatTooltipTime(tooltipCandle.time, range)}</p>
            <p>
              O {formatTinyPrice(denom === "ETH" ? tooltipCandle.openEth : tooltipCandle.openUsd, denom === "ETH" ? "Ξ" : "$")}
            </p>
            <p>
              H {formatTinyPrice(denom === "ETH" ? tooltipCandle.highEth : tooltipCandle.highUsd, denom === "ETH" ? "Ξ" : "$")}
            </p>
            <p>
              L {formatTinyPrice(denom === "ETH" ? tooltipCandle.lowEth : tooltipCandle.lowUsd, denom === "ETH" ? "Ξ" : "$")}
            </p>
            <p>
              C {formatTinyPrice(denom === "ETH" ? tooltipCandle.closeEth : tooltipCandle.closeUsd, denom === "ETH" ? "Ξ" : "$")}
            </p>
            <p className="text-cream-muted/70">Vol {formatCompactUsd(tooltipCandle.volumeUsd)}</p>
          </div>
        )}

        {error && data == null ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-wood-950/95 px-3 text-center text-xs text-cream-muted">
            Could not load $PLANK price history.
          </div>
        ) : isLoading ? (
          <div className="absolute inset-0 flex items-end gap-1 overflow-hidden rounded-lg bg-wood-950 p-3">
            {Array.from({ length: 28 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 animate-pulse rounded-sm bg-wood-900"
                style={{ height: `${22 + ((i * 37) % 55)}%`, animationDelay: `${(i % 6) * 80}ms` }}
              />
            ))}
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
        {stats?.poolCreatedAt && range === "ALL"
          ? ` · Pool live since ${new Date(stats.poolCreatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })} — ALL grows daily as more history trades`
          : ""}
      </p>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
      <p className="truncate text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
        {label}
      </p>
      <p className="truncate text-[0.72rem] font-black text-cream">{value}</p>
    </div>
  );
}
