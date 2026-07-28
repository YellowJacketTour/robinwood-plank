"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineSeries, LineStyle } from "lightweight-charts";
import type { IChartApi, ISeriesApi, LineData, UTCTimestamp } from "lightweight-charts";
import { ethWeiToNumber } from "@/lib/eth-price";
import { useVaultLive } from "@/lib/market/useVaultLive";

type SaleEvent = { kind: string; priceWei: string | null; timestamp: string | null };
type VaultEvent = {
  kind: string;
  ethWei: string | null;
  sharesWei: string | null;
  timestamp: string | null;
};

function vaultEventToPoint(e: VaultEvent): LineData<UTCTimestamp> | null {
  if ((e.kind !== "buy" && e.kind !== "sell") || e.ethWei == null || e.sharesWei == null || e.timestamp == null) {
    return null;
  }
  return {
    time: Math.floor(new Date(e.timestamp).getTime() / 1000) as UTCTimestamp,
    // Both amounts are wei-scaled (18 decimals), so their ratio is already
    // the ETH-per-share price — no rescaling needed.
    value: Number(e.ethWei) / Number(e.sharesWei),
  };
}

type Range = "24H" | "7D" | "ALL";
const RANGES: Range[] = ["24H", "7D", "ALL"];
const RANGE_MS: Record<Range, number | null> = {
  "24H": 24 * 60 * 60 * 1000,
  "7D": 7 * 24 * 60 * 60 * 1000,
  ALL: null,
};

/**
 * The true full-lineage price history for RobinWood, charted like a
 * DEX/meme-coin pair. Merges every blockchain-timestamped trade from both
 * venues: settled fixed-price marketplace sales (/api/market/activity, all
 * of them via ?full=1, not just the most recent 40) and every vault AMM
 * trade (Bought/Sold — /api/market/vault/activity?full=1 for history, then
 * the shared live stream for anything new). The vault is where nearly all
 * price action actually happens now, so a sales-only chart would sit stuck
 * at an old price while real, lower vault sells were printing — the
 * originally reported bug. A share is the vault's per-NFT redemption unit,
 * so its ETH-per-share price is a like-for-like point on the same chart,
 * not a different asset. New trades arrive over the live stream (a
 * standing server push, not a manual refresh) the moment they're mined —
 * no synthetic candle aggregation, a line of real trades is more honest
 * than fabricated OHLC bars with mostly-empty candles.
 */
export default function NftPriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [salePoints, setSalePoints] = useState<LineData<UTCTimestamp>[] | null>(null);
  const [vaultHistoryPoints, setVaultHistoryPoints] = useState<LineData<UTCTimestamp>[]>([]);
  const [range, setRange] = useState<Range>("ALL");
  const [failed, setFailed] = useState(false);
  const { activity: vaultActivity } = useVaultLive();

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetch("/api/market/activity?full=1")
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
            }));
          setSalePoints(sales);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };

    load();
    // The full-history endpoint is server-cached for 120s, and new trades
    // arrive live via the SSE stream anyway — this is just a slow safety
    // net against a missed tick, not the primary update path.
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // One-time full vault trade history, merged with whatever the live
  // stream carries — the stream only holds the ~30 most recent vault
  // trades, which is fine for the ticker but was silently truncating this
  // chart's older history.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/vault/activity?full=1")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: { events?: VaultEvent[] }) => {
        if (cancelled) return;
        const pts = (data.events ?? []).map(vaultEventToPoint).filter((p): p is LineData<UTCTimestamp> => p != null);
        setVaultHistoryPoints(pts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const vaultLivePoints = useMemo<LineData<UTCTimestamp>[]>(() => {
    return vaultActivity.map(vaultEventToPoint).filter((p): p is LineData<UTCTimestamp> => p != null);
  }, [vaultActivity]);

  const points = useMemo<LineData<UTCTimestamp>[] | null>(() => {
    if (salePoints == null) return null;
    const merged = [...salePoints, ...vaultHistoryPoints, ...vaultLivePoints].sort((a, b) => a.time - b.time);
    // lightweight-charts requires strictly increasing timestamps; two trades
    // in the same second collapse to the later one.
    const deduped: typeof merged = [];
    for (const p of merged) {
      if (deduped.length > 0 && deduped[deduped.length - 1].time === p.time) {
        deduped[deduped.length - 1] = p;
      } else {
        deduped.push(p);
      }
    }
    return deduped;
  }, [salePoints, vaultHistoryPoints, vaultLivePoints]);

  useEffect(() => {
    if (!containerRef.current) return;

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
    // Mount once — this used to depend on [points] and tore down/rebuilt
    // the ENTIRE chart on every 20s poll and every live vault trade, which
    // is real, avoidable jank. Data updates go through series.setData() in
    // the effect below instead, which is what that effect already did; it
    // just never got the chance to run against a stable chart before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
