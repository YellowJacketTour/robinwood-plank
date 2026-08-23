"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import { computeWashSuspicion, type WashCandidateSale } from "@/lib/market/wash-trade-signal";
import { computeDemandScore, type DemandScoreInput } from "@/lib/market/multichain/demand-score";
import { shortAddress } from "@/lib/trade";

const CollectionEvidenceSpace = dynamic(() => import("@/components/market/CollectionEvidenceSpace"), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl border border-line bg-background/55" /> });
// echarts touches canvas/DOM at import time -- client-only, same reasoning
// as CollectionEvidenceSpace's R3F Canvas above.
const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false, loading: () => <div className="h-40 w-full animate-pulse rounded-lg bg-background/55" /> });

type Sale = { timestamp?: string | null; tokenId?: string | null; tokenName?: string | null; imageUrl?: string | null; priceWei?: string | null; priceAmount?: string | null; priceUsd?: number | null; priceSymbol: string | null; transaction: string | null; from: string | null; to: string | null };
type Listing = { priceWei: string; maker?: string | null; tokenId: string };
type TierCounts = Record<string, number>;
type HistoryCoverage = { source: string; scope?: string; indexedEvents: number; timestampedEvents: number; oldestTimestamp: string | null; newestTimestamp: string | null; completeThroughGenesis: boolean; completeMarketHistory?: boolean; genesisBackfillBlock?: number | null; liveIndexedBlock?: number | null };

const FALLBACK_ACCENT = "#b47cff"; // this panel's existing fixed violet -- used whenever real extraction isn't possible (no art, load failure, CORS block)

/**
 * PROCEDURAL PER-COLLECTION ACCENT, real 2026-08-23 build: extracts the
 * collection's own dominant real artwork color via colorthief instead of
 * every collection sharing the same fixed violet. This is what makes
 * hundreds of thousands of tracked collections each feel bespoke without
 * a single hour of manual design work per collection -- the color IS the
 * collection's own real pixels, nothing invented. Falls back to the
 * existing violet on any failure (missing art, CORS-blocked host, decode
 * error) -- a failed extraction must never block or discolor the panel.
 */
function useProceduralAccent(artUrls: string[]): string {
  const [accent, setAccent] = useState(FALLBACK_ACCENT);
  const url = artUrls[0];
  useEffect(() => {
    if (!url) { setAccent(FALLBACK_ACCENT); return; }
    let alive = true;
    (async () => {
      try {
        const { getColor } = await import("colorthief");
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        await img.decode();
        if (!alive) return;
        const color = await getColor(img);
        if (!alive || !color) return;
        setAccent(color.hex());
      } catch {
        if (alive) setAccent(FALLBACK_ACCENT);
      }
    })();
    return () => { alive = false; };
  }, [url]);
  return accent;
}

function pct(value: number): string { return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`; }
function Bar({ value, label }: { value: number; label: string }) {
  return <div><div className="mb-1 flex justify-between gap-2 text-[0.65rem]"><span>{label}</span><span>{pct(value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-gradient-to-r from-gold-500 to-purple-400" style={{ width: pct(value) }} /></div></div>;
}

const CHART_COLORS = ["#f4c95d", "#b47cff", "#48d7a4", "#58a6ff", "#ff718b", "#d7d0c7"];

/**
 * Real ECharts donut, replacing the old flat CSS conic-gradient version --
 * same real rows in, same real total, just a proper animated chart with an
 * exact-value tooltip on hover instead of a static wedge. Empty (total===0)
 * renders an honest dormant ring, never a fabricated "full" circle.
 */
function Donut({ rows, label, accent }: { rows: Array<[string, number]>; label: string; accent: string }) {
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  const top = rows.slice(0, 6);
  const option = useMemo(() => ({
    color: [accent, ...CHART_COLORS.filter((c) => c !== accent)],
    tooltip: { trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}: ${p.value.toLocaleString()} (${p.percent}%)`, backgroundColor: "#141019", borderColor: "#2a2333", textStyle: { color: "#e8e2f5", fontSize: 11 } },
    series: [{
      type: "pie",
      radius: ["58%", "88%"],
      avoidLabelOverlap: false,
      label: { show: false },
      emphasis: { scaleSize: 6 },
      data: total ? top.map(([name, value]) => ({ name, value })) : [{ name: "No data", value: 1, itemStyle: { color: "rgba(255,255,255,.06)" } }],
      animationDuration: 600,
    }],
  }), [top, total, accent]);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="relative size-28 shrink-0">
        <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge lazyUpdate />
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="text-lg font-black tabular-nums text-gold-300">{total.toLocaleString()}</span>
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-[0.58rem] font-black uppercase tracking-wider text-foreground/45">{label}</p>
        {top.map(([name, value], index) => (
          <div key={name} className="flex items-center gap-1.5 text-[0.65rem]">
            <span className="size-2 rounded-full" style={{ background: index === 0 ? accent : CHART_COLORS[index % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="tabular-nums text-foreground/55">{total ? pct((value / total) * 100) : "0%"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Real ECharts radial gauge for the small set of metrics that are actually
 * bounded scores (0-100 demand score, 0-100% wash suspicion) -- per the
 * research brief's own HUD-vs-readout distinction, only metrics with a
 * real, meaningful bounded range get a gauge; unbounded exact figures
 * (HHI, Gini, raw counts) stay as plain high-contrast text below, since a
 * gauge on an unbounded number would visually lie about where "full" is.
 */
function Gauge({ value, max, label, accent, formatted }: { value: number; max: number; label: string; accent: string; formatted: string }) {
  const option = useMemo(() => ({
    series: [{
      type: "gauge",
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max,
      progress: { show: true, width: 10, itemStyle: { color: accent } },
      axisLine: { lineStyle: { width: 10, color: [[1, "rgba(255,255,255,.08)"]] } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      anchor: { show: false },
      detail: { show: false },
      data: [{ value }],
      animationDuration: 700,
    }],
  }), [value, max, accent]);
  return (
    <div className="rounded-lg border border-line bg-background/65 p-3 backdrop-blur-sm">
      <p className="text-[0.58rem] font-black uppercase text-foreground/40">{label}</p>
      <div className="relative h-16 w-full">
        <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge lazyUpdate />
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-1">
          <span className="break-words font-display text-base text-gold-300">{formatted}</span>
        </div>
      </div>
    </div>
  );
}

function DepthCurve({ listings }: { listings: Listing[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const rows = useMemo(() => listings
    .filter((row) => { try { return BigInt(row.priceWei) > 0n; } catch { return false; } })
    .sort((a, b) => { const left = BigInt(a.priceWei), right = BigInt(b.priceWei); return left < right ? -1 : left > right ? 1 : 0; }), [listings]);
  if (rows.length < 2) return <div className="grid min-h-40 place-items-center text-xs text-foreground/40">At least two verified live asks are needed for an ask ladder.</div>;
  const numeric = rows.map((row) => Number(row.priceWei));
  const floor = numeric[0];
  const cap = numeric[Math.min(numeric.length - 1, Math.floor(numeric.length * .95))];
  const x = (index: number) => 5 + (index / Math.max(1, rows.length - 1)) * 90;
  const y = (price: number) => 92 - Math.min(price / cap, 1) * 78;
  const points = numeric.map((price, index) => `${x(index)},${y(price)}`).join(" ");
  const activeIndex = hovered ?? 0;
  const active = rows[activeIndex];
  const premium = floor ? (numeric[activeIndex] / floor - 1) * 100 : 0;
  const nearest = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect();
    const chartX = ((clientX - rect.left) / rect.width * 100 - 5) / 90;
    return Math.max(0, Math.min(rows.length - 1, Math.round(chartX * (rows.length - 1))));
  };
  return <div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-44 w-full touch-none overflow-visible" role="application" aria-label="Inspectable live ask ladder" onPointerMove={(event) => setHovered(nearest(event.clientX, event.currentTarget))} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setHovered(nearest(event.clientX, event.currentTarget)); }} onPointerLeave={() => setHovered(null)}>
      <defs><linearGradient id="depth-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b47cff" stopOpacity=".6"/><stop offset="1" stopColor="#b47cff" stopOpacity="0"/></linearGradient></defs>
      <polygon points={`5,100 ${points} 95,100`} fill="url(#depth-fill)"/><polyline points={points} fill="none" stroke="#f4c95d" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/><line x1="5" y1="92" x2="95" y2="92" stroke="rgba(255,255,255,.18)" strokeWidth=".5" vectorEffect="non-scaling-stroke"/>
      <line x1={x(activeIndex)} x2={x(activeIndex)} y1="8" y2="94" stroke="#fff" strokeDasharray="2 2" opacity=".45" vectorEffect="non-scaling-stroke"/><circle cx={x(activeIndex)} cy={y(numeric[activeIndex])} r="2.2" fill="#fff" stroke="#f4c95d" strokeWidth="1" vectorEffect="non-scaling-stroke"/>
    </svg>
    <div className="flex justify-between text-[0.58rem] text-foreground/40"><span>Floor ask</span><span>95th-percentile display ceiling</span></div>
    <div className="mt-2 grid gap-2 rounded-md border border-line bg-panel/75 p-2 text-[0.65rem] sm:grid-cols-2 lg:grid-cols-4">
      <div><span className="block uppercase text-foreground/40">Token</span><strong className="break-all">#{active.tokenId}</strong></div><div><span className="block uppercase text-foreground/40">Exact stored ask</span><strong className="break-all">{active.priceWei} atomic units</strong></div><div><span className="block uppercase text-foreground/40">Depth / premium</span><strong>{activeIndex + 1} asks · {premium.toFixed(1)}%</strong></div><div><span className="block uppercase text-foreground/40">Maker</span><strong className="break-all">{active.maker || "Unavailable"}</strong></div>
    </div>
  </div>;
}

function gini(values: number[]): number {
  const sorted = values.filter((value) => value >= 0).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (!sorted.length || !total) return 0;
  return sorted.reduce((sum, value, index) => sum + (2 * (index + 1) - sorted.length - 1) * value, 0) / (sorted.length * total);
}

function EvidenceTimeline({ sales, range, onRange }: { sales: Sale[]; range: [number, number] | null; onRange: (range: [number, number] | null) => void }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const points = useMemo(() => sales.map((sale, sourceIndex) => ({ sale, sourceIndex, time: sale.timestamp ? Date.parse(sale.timestamp) : NaN, usd: sale.priceUsd ?? NaN })).filter((point) => Number.isFinite(point.time) && Number.isFinite(point.usd)).sort((a, b) => a.time - b.time), [sales]);
  if (!points.length) return <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-line bg-background/55 p-6 text-center text-xs text-foreground/45">No timestamped, USD-valued sale observations are available in this loaded evidence window.</div>;
  const minTime = points[0].time, maxTime = points.at(-1)!.time;
  const minUsd = Math.min(...points.map((point) => point.usd)), maxUsd = Math.max(...points.map((point) => point.usd));
  const x = (time: number) => 36 + (maxTime === minTime ? .5 : (time - minTime) / (maxTime - minTime)) * 528;
  const y = (usd: number) => 218 - (maxUsd === minUsd ? .5 : (usd - minUsd) / (maxUsd - minUsd)) * 174;
  const nearest = (clientX: number, element: SVGSVGElement) => { const rect = element.getBoundingClientRect(); const viewX = (clientX - rect.left) / rect.width * 600; return points.reduce((best, point, index) => Math.abs(x(point.time) - viewX) < Math.abs(x(points[best].time) - viewX) ? index : best, 0); };
  const active = hovered == null ? null : points[hovered];
  const selection = range ? points.filter((point) => point.time >= range[0] && point.time <= range[1]) : points;
  return <article className="relative overflow-hidden rounded-xl border border-purple-400/35 bg-background/70 p-3 backdrop-blur-md"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[0.58rem] font-black uppercase tracking-[0.18em] text-purple-300">Evidence chronology</p><h4 className="font-display text-lg text-gold-300">Every observed sale, in time</h4><p className="text-[0.65rem] text-foreground/45">Move for exact values. Drag to select an interval; every metric below recomputes from it.</p></div>{range && <button type="button" onClick={() => onRange(null)} className="min-h-9 rounded-md border border-line px-3 text-xs font-bold">Reset interval</button>}</div><svg viewBox="0 0 600 250" className="mt-2 h-64 w-full touch-none select-none" role="application" aria-label="Interactive exact sale history" onPointerLeave={() => { if (dragStart == null) setHovered(null); }} onPointerDown={(event) => { const index = nearest(event.clientX, event.currentTarget); event.currentTarget.setPointerCapture(event.pointerId); setDragStart(index); setHovered(index); }} onPointerMove={(event) => { const index = nearest(event.clientX, event.currentTarget); setHovered(index); if (dragStart != null) onRange([Math.min(points[dragStart].time, points[index].time), Math.max(points[dragStart].time, points[index].time)]); }} onPointerUp={() => setDragStart(null)}><defs><linearGradient id="time-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b47cff" stopOpacity=".45"/><stop offset="1" stopColor="#b47cff" stopOpacity="0"/></linearGradient></defs>{[0,1,2,3].map((row) => <line key={row} x1="36" x2="564" y1={44 + row * 58} y2={44 + row * 58} stroke="rgba(255,255,255,.08)"/>)}{range && <rect x={x(range[0])} y="28" width={Math.max(2, x(range[1]) - x(range[0]))} height="202" fill="#b47cff" opacity=".12"/>}<polyline points={points.map((point) => `${x(point.time)},${y(point.usd)}`).join(" ")} fill="none" stroke="#f4c95d" strokeWidth="2"/>{points.map((point, index) => <circle key={`${point.sale.transaction}-${index}`} cx={x(point.time)} cy={y(point.usd)} r={hovered === index ? 7 : 4} fill={hovered === index ? "#fff" : "#b47cff"} stroke="#f4c95d" strokeWidth="1.5"><title>{new Date(point.time).toLocaleString()} · ${point.usd.toLocaleString()} · {point.sale.priceAmount} {point.sale.priceSymbol}</title></circle>)}{active && <><line x1={x(active.time)} x2={x(active.time)} y1="28" y2="230" stroke="#fff" strokeDasharray="3 3" opacity=".45"/><circle cx={x(active.time)} cy={y(active.usd)} r="12" fill="none" stroke="#fff" opacity=".35"/></>}</svg><div className="grid gap-2 border-t border-line pt-2 sm:grid-cols-[1fr_auto]"><div className="min-w-0">{active ? <><p className="font-display text-base text-gold-300">${active.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })} · {active.sale.priceAmount} {active.sale.priceSymbol}</p><p className="truncate text-[0.65rem] text-foreground/55">{new Date(active.time).toLocaleString()} · {active.sale.tokenName || (active.sale.tokenId ? `#${active.sale.tokenId}` : "collection sale")} · {active.sale.transaction || "transaction unavailable"}</p></> : <p className="text-xs text-foreground/45">Inspect a point to reveal its complete observed identity.</p>}</div><p className="text-right text-[0.65rem] text-foreground/45">{selection.length} / {points.length} timestamped sales selected</p></div></article>;
}

export default function CollectionIntelligence(props: {
  name: string; chain: string; supply: number | null; holders: number | null;
  indexed: number; rarityCovered: number; rarityTiers: TierCounts; listings: Listing[]; sales: Sale[]; artUrls: string[]; historyCoverage?: HistoryCoverage | null;
  /** Real 24h/7d/30d volume+sales windows from marketStats state (EVM-only today, honestly null on Solana/Bitcoin/Robinhood -- see MultichainCollectionView.tsx's own marketStats comment). Feeds the demand-score momentum term only; every other term degrades gracefully when this is null. */
  marketStats?: { volume24hWei: string | null; sales24h: number | null; volume7dWei: string | null; sales7d: number | null; volume30dWei: string | null; sales30d: number | null } | null;
  /** Real listed count from the tracked-collection snapshot, when available -- falls back to listings.length below. */
  listedCount?: number | null;
}) {
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);
  const [landscape, setLandscape] = useState<"space" | "timeline">("space");
  const accent = useProceduralAccent(props.artUrls);
  const scopedSales = timeRange ? props.sales.filter((sale) => { const time = sale.timestamp ? Date.parse(sale.timestamp) : NaN; return Number.isFinite(time) && time >= timeRange[0] && time <= timeRange[1]; }) : props.sales;
  const listedPct = props.supply ? props.listings.length / props.supply * 100 : 0;
  const holderPct = props.supply && props.holders ? props.holders / props.supply * 100 : 0;
  const rarityPct = props.indexed ? props.rarityCovered / props.indexed * 100 : 0;
  const makers = new Map<string, number>();
  for (const row of props.listings) if (row.maker) makers.set(row.maker.toLowerCase(), (makers.get(row.maker.toLowerCase()) ?? 0) + 1);
  const makerHhi = props.listings.length ? [...makers.values()].reduce((sum, count) => sum + (count / props.listings.length) ** 2, 0) * 10_000 : 0;
  const priced = scopedSales.filter((sale) => sale.priceUsd != null);
  const usdVolume = priced.reduce((sum, sale) => sum + sale.priceUsd!, 0);
  const currencies = [...new Set(scopedSales.map((sale) => sale.priceSymbol).filter(Boolean))];
  const provenancePct = scopedSales.length ? scopedSales.filter((sale) => sale.transaction).length / scopedSales.length * 100 : 0;
  // Real wash-trade suspicion (lib/market/wash-trade-signal.ts) -- upgrades
  // the old bare exact-self-transfer count with the same chain-agnostic
  // reciprocal-pair round-trip heuristic trending.ts and demand-score.ts
  // already use, over exactly the scoped (possibly time-selected) sales
  // this panel is already showing everywhere else.
  const washCandidates: WashCandidateSale[] = scopedSales
    .filter((sale) => sale.priceWei != null)
    .map((sale) => ({ txHash: sale.transaction ?? `${sale.tokenId ?? ""}-${sale.timestamp ?? ""}`, from: sale.from, to: sale.to, priceWei: sale.priceWei!, timestamp: sale.timestamp ?? null }));
  const washResult = useMemo(() => computeWashSuspicion(washCandidates), [washCandidates]);
  const listingPrices = props.listings.map((listing) => Number(listing.priceWei)).filter((value) => Number.isFinite(value) && value > 0);
  const floor = listingPrices.length ? Math.min(...listingPrices) : 0;
  const depth10 = floor ? listingPrices.filter((value) => value <= floor * 1.1).length : 0;
  const makerCounts = [...makers.entries()].sort((a, b) => b[1] - a[1]);
  const makerGini = gini(makerCounts.map(([, count]) => count));
  const currencyRows = [...new Map(scopedSales.map((sale) => [sale.priceSymbol || "Unknown", 0])).keys()].map((symbol) => [symbol, scopedSales.filter((sale) => (sale.priceSymbol || "Unknown") === symbol).length] as [string, number]);
  const rarityRows = Object.entries(props.rarityTiers).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  // Real, explainable demand score (lib/market/multichain/demand-score.ts) --
  // same formula GlobalMarketHub-adjacent surfaces use, surfaced here so
  // Intel's momentum reading is wash-discounted using THIS collection's own
  // real per-sale buyer/seller evidence rather than a background job's
  // possibly-stale ratio.
  const demandInput: DemandScoreInput = {
    volume24hWei: props.marketStats?.volume24hWei ?? null,
    volume7dWei: props.marketStats?.volume7dWei ?? null,
    volume30dWei: props.marketStats?.volume30dWei ?? null,
    sales24h: props.marketStats?.sales24h ?? null,
    sales7d: props.marketStats?.sales7d ?? null,
    sales30d: props.marketStats?.sales30d ?? null,
    listedCount: props.listedCount ?? props.listings.length,
    totalSupply: props.supply,
    holderCount: props.holders,
    rankedTokenCount: props.rarityCovered,
    projectedTokenCount: props.indexed,
    washSuspicionRatio: washResult.suspicionRatio,
  };
  const demandScore = computeDemandScore(demandInput);
  const exportRows = props.sales.map((sale) => ({ collection: props.name, chain: props.chain, transaction: sale.transaction, from: sale.from, to: sale.to, currency: sale.priceSymbol, amount: sale.priceAmount, usd: sale.priceUsd }));
  const download = (kind: "json" | "csv") => {
    const body = kind === "json" ? JSON.stringify(exportRows, null, 2) : ["collection,chain,transaction,from,to,currency,amount,usd", ...exportRows.map((row) => [row.collection, row.chain, row.transaction, row.from, row.to, row.currency, row.amount, row.usd].map((value) => JSON.stringify(value ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${props.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-intelligence.${kind}`; anchor.click(); URL.revokeObjectURL(url);
  };
  // Only the two real BOUNDED scores (0-100) get a gauge -- see Gauge's own
  // header for why unbounded figures (HHI, Gini, raw counts) stay as plain
  // high-contrast readout cards below instead.
  const gauges: Array<{ label: string; value: number; max: number; formatted: string }> = [
    { label: "Demand score", value: demandScore.gradable ? demandScore.score : 0, max: 100, formatted: demandScore.gradable ? `${demandScore.score} / 100` : "Insufficient data" },
    { label: "Wash-trade suspicion", value: washResult.totalTradeCount ? washResult.suspicionRatio * 100 : 0, max: 100, formatted: washResult.totalTradeCount ? `${(washResult.suspicionRatio * 100).toFixed(1)}% of volume` : "No priced trades to score" },
  ];
  const cards = [
    ["USD volume (loaded)", usdVolume ? `$${usdVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Unpriced"],
    ["Payment currencies", currencies.join(" · ") || "No priced sales"],
    ["Listing-maker concentration", makerHhi ? `${makerHhi.toFixed(0)} HHI` : "Insufficient data"],
    ["Wash-trade detail", washResult.totalTradeCount ? `${washResult.suspiciousTradeCount} / ${washResult.totalTradeCount} trades · ${washResult.selfTransferCount} self-transfer + ${washResult.reciprocalPairCount} reciprocal-pair` : "No priced trades to score"],
    ["Floor depth (+10%)", `${depth10.toLocaleString()} asks`],
    ["Maker inequality", makerCounts.length ? `${(makerGini * 100).toFixed(1)} Gini` : "Insufficient data"],
    ["Indexed universe", props.indexed.toLocaleString()],
    ["Observed transactions", scopedSales.length.toLocaleString()],
  ];
  return <motion.section
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.35 }}
    style={{ "--collection-accent": accent } as React.CSSProperties}
    className="relative isolate space-y-3 overflow-hidden rounded-xl border border-line bg-panel p-3"
    aria-label="Collection intelligence"
  >
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>{props.artUrls.slice(0, 4).map((url, index) => <div key={`${url}-${index}`} className="absolute aspect-square w-[38%] max-w-80 rounded-full bg-cover bg-center opacity-[0.04] blur-[2px] saturate-150" style={{ backgroundImage: `linear-gradient(135deg, transparent, rgba(9,6,15,.88)), url(${JSON.stringify(url)})`, right: `${(index % 2) * 42 - 8}%`, top: `${Math.floor(index / 2) * 48 - 12}%`, transform: `rotate(${index % 2 ? 9 : -8}deg) scale(1.15)` }}/>)}</div>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[0.62rem] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>Collection intelligence</p><h3 className="font-display text-lg text-gold-300">Market structure & provenance</h3><p className="text-xs text-foreground/45">Computed only from indexed evidence · loaded-window metrics are labeled, never extrapolated.</p></div><div className="flex gap-1"><button type="button" onClick={() => download("csv")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export CSV</button><button type="button" onClick={() => download("json")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export JSON</button></div></div>
      {props.historyCoverage && <div className="grid gap-2 rounded-lg border border-amber-400/35 bg-amber-500/5 p-2 text-[0.65rem] sm:grid-cols-3" role="status"><div><span className="block font-black uppercase tracking-wider text-foreground/45">Protocol coverage</span><strong>{props.historyCoverage.completeThroughGenesis ? `${props.historyCoverage.scope ?? "source"} chain scan complete` : `${props.historyCoverage.scope ?? "source"} backfill in progress`}</strong><span className="block text-amber-200/75">Total multi-venue market history is not yet complete.</span></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Evidence ledger</span><strong>{props.sales.length.toLocaleString()} loaded / {props.historyCoverage.indexedEvents.toLocaleString()} indexed</strong></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Observed span</span><strong>{props.historyCoverage.oldestTimestamp ? new Date(props.historyCoverage.oldestTimestamp).toLocaleDateString() : "Timestamp repair pending"} to {props.historyCoverage.newestTimestamp ? new Date(props.historyCoverage.newestTimestamp).toLocaleDateString() : "now"}</strong></div></div>}
      <div className="flex gap-1" role="tablist" aria-label="Intelligence landscape"><button type="button" role="tab" aria-selected={landscape === "space"} onClick={() => setLandscape("space")} className={`min-h-10 rounded-md border px-3 text-xs font-bold ${landscape === "space" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line"}`}>Spatial evidence</button><button type="button" role="tab" aria-selected={landscape === "timeline"} onClick={() => setLandscape("timeline")} className={`min-h-10 rounded-md border px-3 text-xs font-bold ${landscape === "timeline" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line"}`}>Exact chronology</button></div>
      {landscape === "space" ? <CollectionEvidenceSpace sales={props.sales}/> : <EvidenceTimeline sales={props.sales} range={timeRange} onRange={setTimeRange}/>}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {gauges.map((g) => <Gauge key={g.label} label={g.label} value={g.value} max={g.max} formatted={g.formatted} accent={accent} />)}
        {cards.map(([label, value]) => <motion.div key={label} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25 }} title={`${label}: ${value}`} className="group rounded-lg border border-line bg-background/65 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:bg-[color-mix(in_srgb,var(--collection-accent)_12%,transparent)]" style={{ borderColor: undefined }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = accent)} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}><p className="text-[0.58rem] font-black uppercase text-foreground/40">{label}</p><p className="mt-1 break-words font-display text-base text-gold-300">{value}</p></motion.div>)}
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
        <article className="rounded-lg border bg-background/55 p-3 backdrop-blur-sm" style={{ borderColor: `color-mix(in srgb, ${accent} 35%, transparent)` }}><div className="mb-2"><p className="text-[0.58rem] font-black uppercase tracking-wider" style={{ color: accent }}>Executable liquidity</p><h4 className="font-display text-base text-gold-300">Ask ladder & floor premium</h4><p className="text-[0.62rem] text-foreground/40">Move or drag across every loaded live ask to inspect its exact token, maker, native price, cumulative depth, and premium to floor. The 95th percentile only bounds the drawing; values remain exact.</p></div><DepthCurve listings={props.listings}/></article>
        <article className="grid gap-4 rounded-lg border border-gold-400/35 bg-background/55 p-3 backdrop-blur-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"><Donut rows={currencyRows} label="Selected sale currency mix" accent={accent} /><Donut rows={rarityRows} label="Indexed rarity composition" accent={accent} /><Donut rows={makerCounts.slice(0, 8).map(([addr, count]) => [shortAddress(addr), count] as [string, number])} label={`Live-ask maker share${makerHhi ? ` · ${makerHhi.toFixed(0)} HHI` : ""}`} accent={accent} /></article>
      </div>
    <div className="grid gap-3 rounded-lg border border-line bg-background/35 p-3 md:grid-cols-2"><Bar label="Supply currently listed" value={listedPct}/><Bar label="Unique-holder coverage" value={holderPct}/><Bar label="Rarity coverage" value={rarityPct}/><Bar label="Transaction provenance" value={provenancePct}/></div>
    <div className="grid gap-2 text-[0.62rem] leading-relaxed text-foreground/45 md:grid-cols-3"><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Liquidity:</strong> depth near floor measures executable choice, while maker HHI/Gini expose whether many cards are controlled by a small set of wallets.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Provenance:</strong> transaction coverage reports how much observed activity links back to a verifiable chain transaction.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Limits:</strong> rarity is metadata-dependent; manipulation flags are screening signals, not accusations or investment advice.</p></div>
  </motion.section>;
}
