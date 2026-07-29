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

/** Same instant-hydrate-from-last-visit pattern as
 * lib/market/useVaultLive.ts's snapshot — a refresh shows the last chart
 * immediately instead of an empty "loading" state, and it's replaced the
 * moment the real fetch resolves either way. */
function loadCachedPoints(key: string): LineData<UTCTimestamp>[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`plank-chart-cache:${key}`);
    return raw ? (JSON.parse(raw) as LineData<UTCTimestamp>[]) : null;
  } catch {
    return null;
  }
}

function saveCachedPoints(key: string, points: LineData<UTCTimestamp>[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`plank-chart-cache:${key}`, JSON.stringify(points));
  } catch {
    // storage full/unavailable — chart still works, just no instant-hydrate
  }
}

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
  const [salePoints, setSalePoints] = useState<LineData<UTCTimestamp>[] | null>(() =>
    loadCachedPoints("sale-points")
  );
  const [vaultHistoryPoints, setVaultHistoryPoints] = useState<LineData<UTCTimestamp>[]>(
    () => loadCachedPoints("vault-history-points") ?? []
  );
  const [vaultHistoryLoaded, setVaultHistoryLoaded] = useState(
    () => (loadCachedPoints("vault-history-points")?.length ?? 0) > 0
  );
  const [range, setRange] = useState<Range>("ALL");
  const [failed, setFailed] = useState(false);
  const { activity: vaultActivity } = useVaultLive();

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      // Prefer the short feed if full lineage is empty/cached-empty — chart
      // should still paint from any priced sales or vault AMM trades.
      Promise.all([
        fetch("/api/market/activity?full=1").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/market/activity").then((r) => (r.ok ? r.json() : null)),
      ])
        .then(([full, short]) => {
          if (cancelled) return;
          const events = [
            ...((full?.events as SaleEvent[] | undefined) ?? []),
            ...((short?.events as SaleEvent[] | undefined) ?? []),
          ];
          const sales = events
            .filter((e): e is { kind: string; priceWei: string; timestamp: string } =>
              e.kind === "sale" && e.priceWei != null && e.timestamp != null
            )
            .map((e) => ({
              time: Math.floor(new Date(e.timestamp).getTime() / 1000) as UTCTimestamp,
              value: ethWeiToNumber(e.priceWei),
            }));
          setSalePoints(sales);
          if (sales.length > 0) saveCachedPoints("sale-points", sales);
          setFailed(false);
        })
        .catch(() => {
          // Don't hard-fail the whole chart — vault AMM points still count.
          if (!cancelled) setSalePoints((prev) => prev ?? []);
        });
    };

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Vault AMM history is the main price series post-launch (ETH per share).
  // Prefer short feed first (fast) then full lineage; never leave chart
  // empty while full=1 is still hanging.
  useEffect(() => {
    let cancelled = false;
    const apply = (events: VaultEvent[]) => {
      const pts = events
        .map(vaultEventToPoint)
        .filter((p): p is LineData<UTCTimestamp> => p != null);
      if (pts.length === 0) return;
      setVaultHistoryPoints((prev) => {
        if (pts.length < prev.length) return prev;
        saveCachedPoints("vault-history-points", pts);
        return pts;
      });
    };

    const loadVault = () => {
      // Short first — paints quickly from the same feed as the trade ticker.
      fetch("/api/market/vault/activity")
        .then((r) => (r.ok ? r.json() : null))
        .then((short) => {
          if (cancelled) return;
          apply((short?.events as VaultEvent[] | undefined) ?? []);
          setVaultHistoryLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setVaultHistoryLoaded(true);
        });

      fetch("/api/market/vault/activity?full=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((full) => {
          if (cancelled) return;
          apply((full?.events as VaultEvent[] | undefined) ?? []);
          setVaultHistoryLoaded(true);
        })
        .catch(() => {});
    };

    loadVault();
    const interval = setInterval(loadVault, 45_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const vaultLivePoints = useMemo<LineData<UTCTimestamp>[]>(() => {
    return vaultActivity.map(vaultEventToPoint).filter((p): p is LineData<UTCTimestamp> => p != null);
  }, [vaultActivity]);

  const points = useMemo<LineData<UTCTimestamp>[] | null>(() => {
    // Wait for vault history attempt OR live/history points before painting
    // empty — empty sales alone used to flash "no trades" while vault still loaded.
    if (
      !vaultHistoryLoaded &&
      vaultHistoryPoints.length === 0 &&
      vaultLivePoints.length === 0 &&
      salePoints == null
    ) {
      return null;
    }
    if (
      !vaultHistoryLoaded &&
      vaultHistoryPoints.length === 0 &&
      vaultLivePoints.length === 0 &&
      (salePoints == null || salePoints.length === 0)
    ) {
      return null;
    }
    const sales = salePoints ?? [];
    const merged = [...sales, ...vaultHistoryPoints, ...vaultLivePoints].sort(
      (a, b) => a.time - b.time
    );
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
  }, [salePoints, vaultHistoryPoints, vaultLivePoints, vaultHistoryLoaded]);

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

  if (failed && (points == null || points.length === 0)) {
    return <p className="py-4 text-center text-xs text-red-300">Could not load price history.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Price history (vault + sales)
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
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-3 py-10 text-center text-xs text-foreground/45">
          No priced vault trades or sales yet — chart fills in as they print.
        </p>
      ) : points == null ? (
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-3 py-10 text-center text-xs text-foreground/45">
          Loading price history…
        </p>
      ) : (
        <div ref={containerRef} className="w-full min-h-[260px] overflow-hidden rounded-lg border border-gold-500/15 bg-wood-950/90" />
      )}
    </div>
  );
}
