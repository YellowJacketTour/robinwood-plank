"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { swrJson } from "@/lib/market/swr-fetch";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import EthUsdValue from "@/components/market/EthUsdValue";

type SaleLike = {
  tokenId: string;
  priceWei: string | null;
  timestamp: string | null;
  txHash?: string;
};

type Props = {
  sales: SaleLike[];
  /** The recent activity request is still cold. Catalog history may resolve first. */
  loading?: boolean;
  /** The recent request failed without a usable cached snapshot. */
  unavailable?: boolean;
  /** Incremented by ActivityFeed after invalidating every activity SWR key. */
  reloadKey?: number;
};

type CatalogSale = {
  tokenId: string;
  priceWei: string;
  timestamp: string | null;
  txHash?: string;
};

type SalesAggregate = {
  saleCount: number;
  sales24h: number;
  pricedSales24h: number;
  unpricedSales24h: number;
  volume24hWei: string | null;
  totalVolumeWei: string | null;
};

type Range = "24H" | "7D" | "ALL";

const RANGES: Range[] = ["24H", "7D", "ALL"];
const RANGE_MS: Record<Exclude<Range, "ALL">, number> = {
  "24H": 24 * 60 * 60 * 1000,
  "7D": 7 * 24 * 60 * 60 * 1000,
};

function stat(label: string, value: string, pending = false, wei?: bigint | null) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
        {label}
      </dt>
      <dd
        className={`mt-0.5 font-display text-lg tabular-nums text-gold-300 ${
          pending ? "animate-pulse text-foreground/25" : ""
        }`}
      >
        {value}
        {wei != null && (
          <EthUsdValue
            wei={wei}
            className="block font-sans text-[0.62rem] text-foreground/50"
          />
        )}
      </dd>
    </div>
  );
}

/**
 * Priced-sale stats + ETH-over-time chart.
 * Merges activity-feed sales with the royalty-aware sales catalog so the
 * chart still has real Ξ points when the short activity window is sparse.
 */
export default function ActivityStats({
  sales,
  loading = false,
  unavailable = false,
  reloadKey = 0,
}: Props) {
  const [catalogState, setCatalogState] = useState<{
    requestKey: number;
    sales: CatalogSale[];
    failed: boolean;
  }>({ requestKey: -1, sales: [], failed: false });
  const [range, setRange] = useState<Range>("7D");
  const [aggregate, setAggregate] = useState<SalesAggregate | null>(null);
  const [referenceNow, setReferenceNow] = useState(0);
  const catalogLoading = catalogState.requestKey !== reloadKey;
  const catalogFailed =
    catalogState.requestKey === reloadKey && catalogState.failed;
  const catalogSales = catalogState.sales;

  useEffect(() => {
    let cancelled = false;

    // This aggregate request is intentionally retried with the catalog. It
    // warms the shared key used by CollectionStats/EventCountdown without
    // inventing aggregate values in this component.
    void swrJson<SalesAggregate>("/api/market/sales-stats", {
      ttlMs: 60_000,
      swrMs: 300_000,
      session: true,
    })
      .then((data) => {
        if (!cancelled) setAggregate(data);
      })
      .catch(() => {});

    swrJson<{ sales?: CatalogSale[] }>("/api/market/sales-history", {
      ttlMs: 60_000,
      swrMs: 300_000,
      session: true,
    })
      .then((data) => {
        if (!cancelled) {
          setCatalogState({
            requestKey: reloadKey,
            sales: Array.isArray(data.sales) ? data.sales : [],
            failed: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogState((previous) => ({
            requestKey: reloadKey,
            sales: previous.sales,
            failed: true,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReferenceNow(Date.now()));
    const stop = startVisibleInterval(() => setReferenceNow(Date.now()), 60_000);
    return () => {
      window.cancelAnimationFrame(frame);
      stop();
    };
  }, []);

  const priced = useMemo(() => {
    const map = new Map<
      string,
      {
        tokenId: string;
        priceWei: string;
        timestamp: string | null;
        wei: bigint;
        t: number;
      }
    >();
    const add = (
      tokenId: string,
      priceWei: string,
      timestamp: string | null,
      txHash?: string
    ) => {
      try {
        const wei = BigInt(priceWei);
        if (wei <= BigInt(0)) return;
        const t = timestamp ? new Date(timestamp).getTime() : 0;
        const key = txHash
          ? `${txHash.toLowerCase()}:${tokenId}`
          : `${tokenId}:${priceWei}:${timestamp || ""}`;
        const previous = map.get(key);
        if (!previous || (t && !previous.t)) {
          map.set(key, { tokenId, priceWei, timestamp, wei, t });
        }
      } catch {
        /* Skip malformed catalog rows rather than charting a fabricated zero. */
      }
    };

    for (const sale of sales) {
      if (sale.priceWei) {
        add(sale.tokenId, sale.priceWei, sale.timestamp, sale.txHash);
      }
    }
    for (const sale of catalogSales) {
      if (sale.priceWei) {
        add(
          sale.tokenId,
          sale.priceWei,
          sale.timestamp,
          sale.txHash
        );
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.t && b.t) return a.t - b.t;
      if (a.t) return -1;
      if (b.t) return 1;
      return 0;
    });
  }, [sales, catalogSales]);

  const dayAgo = referenceNow - RANGE_MS["24H"];
  const last24h = priced.filter((sale) => sale.t >= dayAgo);
  const sumWei = (rows: typeof priced) =>
    rows.reduce((total, sale) => total + sale.wei, BigInt(0));
  const pricedTotalVolumeWei = sumWei(priced);
  const pricedVolume24hWei = sumWei(last24h);
  const safeAggregateWei = (value: string | null | undefined, fallback: bigint) => {
    try {
      return value != null ? BigInt(value) : fallback;
    } catch {
      return fallback;
    }
  };
  const totalVolumeWei = safeAggregateWei(aggregate?.totalVolumeWei, pricedTotalVolumeWei);
  const volume24hWei = safeAggregateWei(aggregate?.volume24hWei, pricedVolume24hWei);
  const averageWei =
    priced.length > 0 ? pricedTotalVolumeWei / BigInt(priced.length) : null;
  const sales24h = aggregate?.sales24h ?? last24h.length;
  const totalSales = aggregate?.saleCount ?? priced.length;
  const has24hVolume = aggregate ? aggregate.volume24hWei != null : priced.length > 0;
  const hasTotalVolume = aggregate ? aggregate.totalVolumeWei != null : priced.length > 0;

  const series = useMemo(() => {
    if (range === "ALL") return priced;
    const cutoff = referenceNow - RANGE_MS[range];
    return priced.filter((sale) => sale.t >= cutoff);
  }, [priced, range, referenceNow]);

  const waitingForData =
    priced.length === 0 && (loading || catalogLoading) && !catalogFailed;
  const historyUnavailable =
    priced.length === 0 && unavailable && catalogFailed && !catalogLoading;

  const chartW = 100;
  const chartH = 44;
  const padY = 4;
  const maxWei =
    series.length > 0
      ? series.reduce((maximum, sale) => (sale.wei > maximum ? sale.wei : maximum), BigInt(1))
      : BigInt(1);
  const minWei =
    series.length > 0
      ? series.reduce((minimum, sale) => (sale.wei < minimum ? sale.wei : minimum), maxWei)
      : BigInt(0);
  const points = series
    .map((sale, index) => {
      const x = series.length > 1 ? (index / (series.length - 1)) * chartW : chartW / 2;
      const span = maxWei - minWei;
      const ratio =
        span > BigInt(0) ? Number(sale.wei - minWei) / Number(span) : 0.5;
      const y = chartH - padY - ratio * (chartH - padY * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const first = series[0];
  const middle = series[Math.floor(series.length / 2)];
  const last = series[series.length - 1];
  const fmtEth = (wei: bigint) => formatTokenAmount(wei.toString(), 18, 4);
  const fmtTime = (time: number) =>
    time
      ? new Date(time).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stat(
          "24h volume",
          waitingForData
            ? "•••"
            : has24hVolume
              ? `${formatTokenAmount(volume24hWei.toString(), 18, 4)} Ξ`
              : "—",
          waitingForData,
          has24hVolume ? volume24hWei : null
        )}
        {stat(
          "24h sales",
          waitingForData ? "•••" : historyUnavailable ? "—" : String(sales24h),
          waitingForData
        )}
        {stat(
          "Total volume",
          waitingForData
            ? "•••"
            : hasTotalVolume
              ? `${formatTokenAmount(totalVolumeWei.toString(), 18, 3)} Ξ`
              : "—",
          waitingForData,
          hasTotalVolume ? totalVolumeWei : null
        )}
        {stat(
          "Total sales",
          waitingForData ? "•••" : historyUnavailable ? "—" : String(totalSales),
          waitingForData
        )}
        {stat(
          "Priced sales",
          waitingForData ? "•••" : historyUnavailable ? "—" : String(priced.length),
          waitingForData
        )}
        {stat(
          "Avg price",
          waitingForData
            ? "•••"
            : averageWei !== null
              ? `${formatTokenAmount(averageWei.toString(), 18, 4)} Ξ`
              : "—",
          waitingForData,
          averageWei
        )}
      </dl>

      <div className="rounded-xl border border-line bg-panel p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-foreground">
              Sales price
            </p>
            <p className="text-[0.58rem] text-foreground/40">
              Verified priced sales over time
            </p>
          </div>
          <div className="flex gap-1 rounded-[9px] bg-wood-950 p-1" aria-label="Sales chart range">
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRange(option)}
                aria-pressed={range === option}
                className={`min-h-8 rounded-md px-2 text-[0.6rem] font-black transition ${
                  range === option
                    ? "bg-gold-500 text-wood-950"
                    : "text-[#a99c84] hover:text-gold-300"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {waitingForData ? (
          <div
            className="mt-3 h-36 animate-pulse rounded-md bg-gold-500/10"
            aria-label="Loading sales price chart"
            role="status"
          />
        ) : historyUnavailable ? (
          <p className="py-14 text-center text-xs text-red-300">
            Sales history unavailable. Retry the activity feed.
          </p>
        ) : series.length === 0 ? (
          <p className="py-14 text-center text-xs text-foreground/45">
            No verified priced sales in this range.
          </p>
        ) : (
          <>
            <div className="mt-2 flex justify-end">
              <p className="font-mono text-[0.65rem] tabular-nums text-gold-300">
                {fmtEth(minWei)}–{fmtEth(maxWei)} Ξ
              </p>
            </div>
            <svg
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="mt-1 h-28 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${range} verified sale price chart in ETH`}
            >
              <line
                x1="0"
                y1={padY}
                x2={chartW}
                y2={padY}
                stroke="rgba(248,217,138,0.12)"
                strokeWidth="0.5"
              />
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
              {series.map((sale, index) => {
                const x =
                  series.length > 1 ? (index / (series.length - 1)) * chartW : chartW / 2;
                const span = maxWei - minWei;
                const ratio =
                  span > BigInt(0)
                    ? Number(sale.wei - minWei) / Number(span)
                    : 0.5;
                const y = chartH - padY - ratio * (chartH - padY * 2);
                return (
                  <circle
                    key={`${sale.tokenId}:${sale.timestamp ?? index}`}
                    cx={x}
                    cy={y}
                    r="1.2"
                    fill="#f8d98a"
                  />
                );
              })}
            </svg>
            <div className="mt-1.5 flex justify-between gap-1 text-[0.55rem] text-foreground/50">
              <span className="min-w-0 truncate" title={fmtTime(first.t)}>
                {fmtEth(first.wei)} Ξ
                <span className="block text-foreground/35">{fmtTime(first.t)}</span>
              </span>
              {series.length > 2 && (
                <span
                  className="min-w-0 truncate text-center"
                  title={fmtTime(middle.t)}
                >
                  {fmtEth(middle.wei)} Ξ
                  <span className="block text-foreground/35">
                    {fmtTime(middle.t)}
                  </span>
                </span>
              )}
              <span className="min-w-0 truncate text-right" title={fmtTime(last.t)}>
                {fmtEth(last.wei)} Ξ
                <span className="block text-foreground/35">{fmtTime(last.t)}</span>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
