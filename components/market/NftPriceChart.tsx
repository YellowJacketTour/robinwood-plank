"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, LineSeries, LineStyle } from "lightweight-charts";
import type { IChartApi, ISeriesApi, LineData, UTCTimestamp } from "lightweight-charts";
import { ethWeiToNumber } from "@/lib/eth-price";

type SaleEvent = { kind: string; priceWei: string | null; timestamp: string | null };

type Range = "24H" | "7D" | "ALL";
const RANGES: Range[] = ["24H", "7D", "ALL"];
const RANGE_MS: Record<Range, number | null> = {
  "24H": 24 * 60 * 60 * 1000,
  "7D": 7 * 24 * 60 * 60 * 1000,
  ALL: null,
};

/**
 * Real settled-sale price history for the collection, charted like a
 * DEX/meme-coin pair. Every point is an actual on-chain sale from
 * /api/market/activity (same feed ActivityStats already reads) — there is
 * no synthetic candle aggregation since sale volume here is still low
 * enough that a line-of-real-trades is more honest than fabricated OHLC
 * bars with mostly-empty candles.
 */
export default function NftPriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [points, setPoints] = useState<LineData<UTCTimestamp>[] | null>(null);
  const [range, setRange] = useState<Range>("ALL");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetch("/api/market/activity")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
        .then((data: { events?: SaleEvent[] }) => {
          if (cancelled) return;
          const sales = (data.events ?? [])
            .filter((e): e is { kind: string; priceWei: string; timestamp: string } =>
              e.kind === "sale" && e.priceWei != null && e.timestamp != null
            )
            .map((e) => ({
              time: Math.floor(new Date(e.timestamp).getTime() / 1000) as UTCTimestamp,
              value: ethWeiToNumber(e.priceWei),
            }))
            .sort((a, b) => a.time - b.time);
          // lightweight-charts requires strictly increasing timestamps; two
          // sales in the same second collapse to the later one.
          const deduped: typeof sales = [];
          for (const p of sales) {
            if (deduped.length > 0 && deduped[deduped.length - 1].time === p.time) {
              deduped[deduped.length - 1] = p;
            } else {
              deduped.push(p);
            }
          }
          setPoints(deduped);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };

    load();
    // The activity API is server-cached for 60s (app/api/market/activity),
    // so polling faster than that would just re-fetch the same response.
    const interval = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || points == null) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(230, 210, 170, 0.6)",
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: "rgba(212, 175, 90, 0.08)" },
        horzLines: { color: "rgba(212, 175, 90, 0.08)" },
      },
      rightPriceScale: { borderColor: "rgba(212, 175, 90, 0.15)" },
      timeScale: { borderColor: "rgba(212, 175, 90, 0.15)", timeVisible: true },
      crosshair: { vertLine: { labelBackgroundColor: "#8a6a1f" }, horzLine: { labelBackgroundColor: "#8a6a1f" } },
      height: 260,
    });
    const series = chart.addSeries(LineSeries, {
      color: "#f4c95d",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (p: number) => `${p.toFixed(4)} Ξ`, minMove: 0.0001 },
      priceLineVisible: false,
      lastValueVisible: true,
      lineStyle: LineStyle.Solid,
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
  }, [points]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || points == null) return;
    const cutoff = RANGE_MS[range] != null ? Date.now() - RANGE_MS[range]! : null;
    const filtered = cutoff != null ? points.filter((p) => Number(p.time) * 1000 >= cutoff) : points;
    seriesRef.current.setData(filtered.length > 0 ? filtered : points.slice(-1));
    chartRef.current.timeScale().fitContent();
  }, [range, points]);

  if (failed) {
    return <p className="py-4 text-center text-xs text-red-300">Could not load sale history.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          RobinWood sale price
        </p>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-1 text-[0.6rem] font-bold transition ${
                range === r
                  ? "bg-gold-500/25 text-gold-200"
                  : "text-foreground/40 hover:bg-black/20 hover:text-foreground/60"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {points != null && points.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-10 text-center text-xs text-foreground/45">
          No settled sales yet — chart fills in as trades happen.
        </p>
      ) : (
        <div ref={containerRef} className="w-full overflow-hidden rounded-lg border border-gold-500/15 bg-black/10" />
      )}
    </div>
  );
}
