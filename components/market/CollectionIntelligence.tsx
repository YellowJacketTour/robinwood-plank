"use client";

import { useEffect, useId, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import art from "./CollectionIntelArt.module.css";
import { askEvidence, evidenceCsvCell, saleCurrencies, saleObservations } from "@/lib/market/multichain/intel-evidence";
import { motion } from "motion/react";
import { computeWashSuspicion, screeningWalletKey, type WashCandidateSale } from "@/lib/market/wash-trade-signal";
import { computeDemandScore, type DemandScoreInput } from "@/lib/market/multichain/demand-score";
import { shortAddress } from "@/lib/trade";

const CollectionEvidenceSpace = dynamic(() => import("@/components/market/CollectionEvidenceSpace"), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl border border-line bg-background/55" /> });
// echarts touches canvas/DOM at import time -- client-only, same reasoning
// as CollectionEvidenceSpace's R3F Canvas above.
const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false, loading: () => <div className="h-40 w-full animate-pulse rounded-lg bg-background/55" /> });
// sigma.js/graphology touch canvas/window at import time -- same ssr:false reasoning.
const CollectionTradeGraph = dynamic(() => import("@/components/market/CollectionTradeGraph"), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl border border-line bg-background/55" /> });
const CollectionDossier = dynamic(() => import("@/components/market/CollectionDossier"), { ssr: false, loading: () => <div className="h-40 animate-pulse rounded-xl border border-line bg-background/55" /> });

type Sale = { timestamp?: string | null; tokenId?: string | null; tokenName?: string | null; imageUrl?: string | null; priceWei?: string | null; priceAmount?: string | null; priceUsd?: number | null; priceSymbol: string | null; transaction: string | null; from: string | null; to: string | null };
type Listing = { currencySymbol?: string; priceWei: string; maker?: string | null; tokenId: string; traits?: Array<{ traitType: string; value: string }> };
type IntelToken = { tokenId: string; name: string | null; imageUrl: string | null; traits?: Array<{ traitType: string; value: string }> };
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
  const [accent, setAccent] = useState<{ url: string; value: string } | null>(null);
  const url = artUrls[0];
  useEffect(() => {
    if (!url) return;
    let alive = true;
    (async () => {
      try {
        const { getColor } = await import("colorthief");
        const img = new window.Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        await img.decode();
        if (!alive) return;
        const color = await getColor(img);
        if (!alive || !color) return;
        setAccent({ url, value: color.hex() });
      } catch {
        if (alive) setAccent({ url, value: FALLBACK_ACCENT });
      }
    })();
    return () => { alive = false; };
  }, [url]);
  return accent && accent.url === url ? accent.value : FALLBACK_ACCENT;
}

/**
 * Real, color-coded hydration freshness readout -- fixes a real gap
 * flagged live 2026-08-24 ("intel tabs hydration properly thought
 * through... stale collection data"): this panel previously had zero
 * signal for whether the numbers on screen were hydrated a moment ago or
 * days ago, so real staleness (a slow/backed-up sync lane for a given
 * chain) was invisible instead of surfaced. Uses `projectedAt` (when this
 * app's own projection job last wrote the row) as the primary signal --
 * it's the honest "how old is what you're looking at" answer regardless
 * of how old the underlying vendor observation was. Green under 1h,
 * amber under 24h, red beyond that or unknown -- never fabricated as
 * "live" when there's no real timestamp to back it.
 */
function useFreshnessBadge(freshness: { sourceObservedAt: string | null; projectedAt: string | null } | null): { label: string; color: string; title: string } {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(id); };
  }, []);
  const ts = freshness?.projectedAt ? Date.parse(freshness.projectedAt) : NaN;
  if (!Number.isFinite(ts)) return { label: "Freshness unknown", color: "#8b8398", title: "No hydration timestamp is available for this collection yet." };
  if (!now) return { label: "Checking freshness", color: "#8b8398", title: "Reading the local clock." };
  const ageMs = Math.max(0, now - ts);
  const ageMin = ageMs / 60_000;
  const label = ageMin < 1 ? "Just now" : ageMin < 60 ? `${Math.round(ageMin)}m ago` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago` : `${Math.round(ageMin / 1440)}d ago`;
  const color = ageMin < 60 ? "#48d7a4" : ageMin < 1440 ? "#f4c95d" : "#ff718b";
  const observed = freshness?.sourceObservedAt ? new Date(freshness.sourceObservedAt).toLocaleString() : "unknown";
  return { label, color, title: `Catalog last hydrated ${new Date(ts).toLocaleString()} · underlying data observed ${observed}` };
}

type OnchainCollectionFacts = { royaltySupported: boolean; royaltyReceiver: string | null; royaltyBps: number | null; dynamicMetadataSupported: boolean | null };

/**
 * Real, live on-chain fact sheet -- the actual point of wiring the new
 * on-chain-read modules into Intel: royalty split (ERC-2981) and
 * dynamic-metadata support (ERC-4906), both a single cheap `eth_call`
 * each, safe to fetch on a page view (unlike Transfer-log history scans,
 * which stay a background-job concern). Deliberately fetched once per
 * collection view, not polled -- these are contract-level facts that
 * essentially never change mid-session.
 */
function useOnchainCollectionFacts(chainSlug: string | null, contractAddress: string | null) {
  const key = `${chainSlug}:${contractAddress}`;
  const applicable = Boolean(chainSlug && contractAddress && /^0x[0-9a-fA-F]{40}$/.test(contractAddress));
  const [result, setResult] = useState<{ key: string; facts: OnchainCollectionFacts | null } | null>(null);
  useEffect(() => {
    if (!applicable) return;
    let alive = true;
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), 10_000);
    (async () => {
      try {
        const res = await fetch(`/api/onchain/collection-facts?chainSlug=${encodeURIComponent(chainSlug!)}&contractAddress=${contractAddress}`, { signal: control.signal });
        if (!res.ok) throw new Error("Collection facts unavailable");
        const body = (await res.json()) as OnchainCollectionFacts;
        if (alive) setResult({ key, facts: body });
      } catch { if (alive) setResult({ key, facts: null }); }
      finally { clearTimeout(timeout); }
    })();
    return () => { alive = false; clearTimeout(timeout); control.abort(); };
  }, [chainSlug, contractAddress, key, applicable]);
  return { facts: result?.key === key ? result.facts : null,
    status: !applicable ? "Not applicable" : result?.key === key ? "Unavailable from this read" : "Reading…" };
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

function DepthCurve({ listings, currency = "native" }: { listings: Listing[]; currency?: string }) {
  const gradientId = useId();
  const [selected, setSelected] = useState(0);
  const { rows, cumulativeDepth } = useMemo(() => askEvidence(listings), [listings]);
  if (!rows.length) return <p className={`${art.meta} py-8`}>No asks loaded yet.</p>;
  const prices=rows.map((row)=>Number(row.priceWei)/1e18);
  const low=Math.log1p(prices[0]), high=Math.log1p(prices.at(-1)!);
  const x=(price:number)=>high===low?250:Math.round((Math.log1p(price)-low)/(high-low)*500000)/1000;
  const y=(quantity:number)=>Math.round((120-quantity/rows.length*112)*1000)/1000;
  const activeIndex=Math.min(selected,rows.length-1), active=rows[activeIndex];
  const path=`M ${x(prices[0])} 120 `+rows.map((row,index)=>`H ${x(prices[index])} V ${y(index+1)}`).join(" ");
  const premium=Number((BigInt(active.priceWei)-BigInt(rows[0].priceWei))*10000n/BigInt(rows[0].priceWei))/100;
  const amount=(value:number)=>value.toLocaleString(undefined,{maximumSignificantDigits:5});
  const nearest=(clientX:number,element:SVGSVGElement)=>{const rect=element.getBoundingClientRect();const px=(clientX-rect.left)/rect.width*500;return prices.reduce((best,price,index)=>Math.abs(x(price)-px)<Math.abs(x(prices[best])-px)?index:best,0);};
  return <div>
    <p className={art.meta}>Cumulative unique pieces at or below each ask price</p>
    <div className="mt-2 grid grid-cols-[28px_1fr] gap-2"><div className="flex h-20 flex-col justify-between text-xs text-purple-200"><span>{rows.length}</span><span>{Math.round(rows.length*2/3)}</span><span>{Math.round(rows.length/3)}</span><span>0</span></div><div>
      <svg viewBox="0 0 500 124" preserveAspectRatio="none" className="h-20 w-full touch-none overflow-visible" role="img" aria-label={`Cumulative loaded asks by price in ${currency}`} onPointerMove={(event)=>setSelected(nearest(event.clientX,event.currentTarget))} onPointerDown={(event)=>setSelected(nearest(event.clientX,event.currentTarget))}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#bd94ef" stopOpacity=".55"/><stop offset="1" stopColor="#bd94ef" stopOpacity=".02"/></linearGradient></defs>
        {[0,.5,1].map((fraction)=><line key={fraction} x1="0" x2="500" y1={120-fraction*112} y2={120-fraction*112} stroke="#bd94ef" opacity=".18"/>)}
        <path d={`${path} V 120 Z`} fill={`url(#${gradientId})`}/><path d={path} fill="none" stroke="#d6b1ff" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
        <line x1={x(prices[activeIndex])} x2={x(prices[activeIndex])} y1="8" y2="120" stroke="#f4c95d" opacity=".6" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
        <circle cx={x(prices[activeIndex])} cy={y(cumulativeDepth[activeIndex])} r="3" fill="#f4c95d"/>
      </svg>
      <div className="flex justify-between text-xs text-purple-200"><span>{amount(prices[0])}</span><span>{amount(Math.expm1((low+high)/2))}</span><span>{amount(prices.at(-1)!)}</span></div>
    </div></div>
    <p className={`${art.meta} mt-1`}>Price · {currency} · log(1 + price)</p>
    <select className={`${art.control} mt-2 w-full`} aria-label="Inspect loaded ask" value={activeIndex} onChange={(event)=>setSelected(Number(event.target.value))}>{rows.map((row,index)=><option key={row.tokenId} value={index}>#{row.tokenId} · {amount(prices[index])} {currency} · {cumulativeDepth[index]} pieces at or below</option>)}</select>
    <p className={`${art.meta} mt-2`} title={`${active.priceWei} normalized atomic units; maker ${active.maker ?? "unreported"}`}>{premium.toFixed(1)}% above floor · Maker {active.maker ? shortAddress(active.maker) : "unreported"}</p>
  </div>;
}

function gini(values: number[]): number {
  const sorted = values.filter((value) => value >= 0).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (!sorted.length || !total) return 0;
  return sorted.reduce((sum, value, index) => sum + (2 * (index + 1) - sorted.length - 1) * value, 0) / (sorted.length * total);
}

function EvidenceTimeline({ sales, range, onRange }: { sales: Sale[]; range: [number, number] | null; onRange: (range: [number, number] | null) => void }) {
  const [requested, setRequested] = useState("");
  const [hovered, setHovered] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => { const initial=setTimeout(()=>setNow(Date.now()),0); const timer=setInterval(()=>setNow(Date.now()),60_000); return()=>{clearTimeout(initial);clearInterval(timer);}; },[]);
  const currencies = saleCurrencies(sales);
  const currency = currencies.includes(requested) ? requested : currencies[0] ?? "Native";
  const points = saleObservations(sales, currency, now);
  const minTime=points[0]?.time ?? 0, maxTime=points.at(-1)?.time ?? 0;
  const maxPrice=Math.max(1e-12,...points.map((point)=>point.value));
  const x=(time:number)=>60+(maxTime === minTime ? .5 : (time-minTime)/(maxTime-minTime))*680;
  const y=(value:number)=>190-Math.log1p(value)/Math.log1p(maxPrice)*155;
  const nearest=(clientX:number,element:SVGSVGElement)=>{const rect=element.getBoundingClientRect();const position=(clientX-rect.left)/rect.width*800;return points.reduce((best,point,index)=>Math.abs(x(point.time)-position)<Math.abs(x(points[best].time)-position)?index:best,0);};
  const active=points[hovered ?? points.length-1];
  return <article className={art.glass}>
    <div className={art.toolbar}><div><h4 className="font-display">Sale chronology</h4><p className={art.meta}>Drag to select an interval for loaded-sale diagnostics. Catalog figures retain their snapshot scope.</p></div><div className="flex gap-2"><select className={art.control} aria-label="Chronology currency" value={currency} onChange={(event)=>{setRequested(event.target.value);setHovered(null);}}>{(currencies.length?currencies:[currency]).map((symbol)=><option key={symbol}>{symbol}</option>)}</select>{range&&<button className={art.control} onClick={()=>onRange(null)}>Reset interval</button>}</div></div>
    {points.length ? <><svg viewBox="0 0 800 230" className="h-64 w-full touch-none" aria-label={`Sale chronology in ${currency}`} onPointerDown={(event)=>{const index=nearest(event.clientX,event.currentTarget);event.currentTarget.setPointerCapture(event.pointerId);setDragStart(index);setHovered(index);}} onPointerMove={(event)=>{const index=nearest(event.clientX,event.currentTarget);setHovered(index);if(dragStart!=null&&points[dragStart])onRange([Math.min(points[dragStart].time,points[index].time),Math.max(points[dragStart].time,points[index].time)]);}} onPointerUp={()=>setDragStart(null)} onPointerCancel={()=>setDragStart(null)}>
      {[0,.25,.5,.75,1].map((fraction)=><g key={fraction}><line x1="60" x2="740" y1={190-fraction*155} y2={190-fraction*155} stroke="#bd94ef" opacity=".2"/><text x="52" y={194-fraction*155} textAnchor="end" fill="#c8b8dc" fontSize="10">{Math.expm1(fraction*Math.log1p(maxPrice)).toLocaleString(undefined,{maximumSignificantDigits:3})}</text></g>)}
      {range&&<rect x={x(Math.max(minTime,range[0]))} y="30" width={Math.max(0,x(Math.min(maxTime,range[1]))-x(Math.max(minTime,range[0])))} height="160" fill="#bd94ef" opacity=".15"/>}
      {points.map((point,index)=><circle key={`${point.sale.transaction}-${point.sourceIndex}`} cx={x(point.time)} cy={y(point.value)} r={active===point?6:3.5} fill={active===point?"#f4c95d":"#bd94ef"} onClick={()=>setHovered(index)}><title>{point.exact} {currency} · {point.sale.timestamp}</title></circle>)}
      {[0,.5,1].map((fraction)=><text key={fraction} x={60+680*fraction} y="212" textAnchor="middle" fill="#c8b8dc" fontSize="10">{new Date(minTime+fraction*(maxTime-minTime)).toISOString().slice(5,16).replace("T"," ")}</text>)}
    </svg><div className={art.footer}><p className={art.meta}>{active?.exact} {currency} · NFT #{active?.sale.tokenId ?? "unknown"} · {active?.sale.timestamp} · UTC / logarithmic price scale</p><select className={`${art.control} mt-2 w-full`} aria-label="Inspect chronology sale" value={hovered ?? points.length-1} onChange={(event)=>setHovered(Number(event.target.value))}>{points.map((point,index)=><option key={index} value={index}>#{point.sale.tokenId ?? "unknown"} · {point.exact} {currency} · {point.sale.timestamp}</option>)}</select></div></> : <p className={`${art.meta} p-8`}>No timestamped sales loaded for this currency. Native prices remain available without a USD conversion when recorded.</p>}
  </article>;
}

export default function CollectionIntelligence(props: {
  name: string; chain: string; currencySymbol?: string; tokens?: IntelToken[]; supply: number | null; holders: number | null;
  profileLinks?: Array<{ label: string; href: string; source: string; observedAt: string | null }>;
  indexed: number; rarityCovered: number; rarityTiers: TierCounts; listings: Listing[]; sales: Sale[]; artUrls: string[]; historyCoverage?: HistoryCoverage | null;
  /** Real 24h/7d/30d volume+sales windows from marketStats state (EVM-only today, honestly null on Solana/Bitcoin/Robinhood -- see MultichainCollectionView.tsx's own marketStats comment). Feeds the demand-score momentum term only; every other term degrades gracefully when this is null. */
  marketStats?: { volume24hWei: string | null; sales24h: number | null; volume7dWei: string | null; sales7d: number | null; volume30dWei: string | null; sales30d: number | null } | null;
  /** Real listed count from the tracked-collection snapshot, when available -- falls back to listings.length below. */
  listedCount?: number | null;
  /**
   * Real hydration timestamps from the same canonical projection the
   * catalog grid reads (plank_collection_token_projections), threaded
   * through 2026-08-24 after being silently dropped by the client's
   * TokenPage type -- see MultichainCollectionView.tsx's own catalogMeta
   * comment. `sourceObservedAt` is when the underlying vendor/on-chain
   * data was actually observed; `projectedAt` is when this app's own
   * projection job last wrote it. Null means genuinely unknown (a
   * collection with no projection row yet), never fabricated as "now".
   */
  catalogFreshness?: { sourceObservedAt: string | null; projectedAt: string | null } | null;
  /** Real chain slug + contract address, EVM only -- feeds the cheap, single-eth_call on-chain fact sheet (royalty split, dynamic-metadata support) below. Omit/null on non-EVM collections; the card degrades to "not applicable" honestly rather than erroring. */
  chainSlug?: string | null;
  contractAddress?: string | null;
}) {
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);
  const [landscape, setLandscape] = useState<"space" | "timeline" | "network" | "dossier">("space");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [traitKey, setTraitKey] = useState<string | null>(null);
  const accent = useProceduralAccent(props.artUrls);
  const freshness = useFreshnessBadge(props.catalogFreshness ?? null);
  const onchainRead = useOnchainCollectionFacts(props.chainSlug ?? null, props.contractAddress ?? null);
  const onchainFacts = onchainRead.facts;
  const scopedSales = timeRange ? props.sales.filter((sale) => { const time = sale.timestamp ? Date.parse(sale.timestamp) : NaN; return Number.isFinite(time) && time >= timeRange[0] && time <= timeRange[1]; }) : props.sales;
  const [requestedAskCurrency, setAskCurrency] = useState("");
  const listingCurrencies = [...new Set(props.listings.map((listing) => (listing.currencySymbol ?? props.currencySymbol ?? "native").toUpperCase()))];
  const askCurrency = listingCurrencies.includes(requestedAskCurrency) ? requestedAskCurrency : listingCurrencies.includes(props.currencySymbol ?? "") ? props.currencySymbol! : listingCurrencies[0] ?? props.currencySymbol ?? "native";
  const tokenById = useMemo(() => new Map((props.tokens ?? []).map((token) => [token.tokenId, token])), [props.tokens]);
  const evidenceSales = useMemo(() => props.sales.map((sale) => {
    const token = sale.tokenId ? tokenById.get(sale.tokenId) : undefined;
    return { ...sale, imageUrl: sale.imageUrl ?? token?.imageUrl, tokenName: sale.tokenName ?? token?.name, traits: token?.traits };
  }), [props.sales, tokenById]);
  const asks = useMemo(() => askEvidence(props.listings.map((listing) => ({ ...listing, traits: listing.traits?.length ? listing.traits : tokenById.get(listing.tokenId)?.traits })), { currency: askCurrency, defaultCurrency: props.currencySymbol ?? "native" }), [props.listings, tokenById, askCurrency, props.currencySymbol]);
  const askByToken = new Map(asks.rows.map((row) => [row.tokenId, row]));
  const activeTrait = asks.traitPremiums.find((trait) => JSON.stringify([trait.traitType, trait.value]) === traitKey);
  const traitExamples = (props.tokens ?? []).filter((token) => !activeTrait || token.traits?.some((trait) => trait.traitType === activeTrait.traitType && trait.value === activeTrait.value)).slice(0, 8);
  const listedPct = props.supply ? (props.listedCount ?? asks.rows.length) / props.supply * 100 : 0;
  const holderPct = props.supply && props.holders ? props.holders / props.supply * 100 : 0;
  const rarityPct = props.indexed ? props.rarityCovered / props.indexed * 100 : 0;
  const makers = new Map<string, number>();
  for (const row of asks.makers) makers.set(row.maker, row.count);
  const makerHhi = asks.rows.length ? asks.makers.reduce((sum, row) => sum + row.share ** 2, 0) * 10_000 : 0;
  const priced = scopedSales.filter((sale) => sale.priceUsd != null && Number.isFinite(sale.priceUsd) && sale.priceUsd >= 0);
  const usdVolume = priced.reduce((sum, sale) => sum + sale.priceUsd!, 0);
  const currencies = [...new Set(scopedSales.map((sale) => sale.priceSymbol).filter(Boolean))];
  const provenancePct = scopedSales.length ? scopedSales.filter((sale) => sale.transaction).length / scopedSales.length * 100 : 0;
  // Real wash-trade suspicion (lib/market/wash-trade-signal.ts) -- upgrades
  // the old bare exact-self-transfer count with the same chain-agnostic
  // reciprocal-pair round-trip heuristic trending.ts and demand-score.ts
  // already use, over exactly the scoped (possibly time-selected) sales
  // this panel is already showing everywhere else.
  // Equal weights produce a TRADE-count screening ratio. Native amounts
  // from different currencies are never added into a pooled volume.
  const washCandidates: WashCandidateSale[] = scopedSales
    .filter((sale) => sale.priceWei != null && /^\d+$/.test(sale.priceWei) && BigInt(sale.priceWei) > 0n)
    .map((sale) => ({ txHash: sale.transaction ?? `${sale.tokenId ?? ""}-${sale.timestamp ?? ""}`, from: sale.from, to: sale.to, priceWei: "1", timestamp: sale.timestamp ?? null }));
  const washResult = useMemo(() => computeWashSuspicion(washCandidates), [washCandidates]);
  const depth10 = asks.depth10;
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
    // Loaded evidence may not cover the aggregate window; do not discount
    // collection-wide momentum with a different sample's screening ratio.
    washSuspicionRatio: null,
  };
  const demandScore = computeDemandScore(demandInput);
  const exportRows = scopedSales.map((sale) => ({ collection: props.name, chain: props.chain, tokenId: sale.tokenId, timestamp: sale.timestamp, transaction: sale.transaction, from: sale.from, to: sale.to, currency: sale.priceSymbol, amount: sale.priceAmount, normalizedAtomicAmount: sale.priceWei, usd: sale.priceUsd }));
  const download = (kind: "json" | "csv") => {
    const body = kind === "json" ? JSON.stringify(exportRows, null, 2) : ["collection,chain,tokenId,timestamp,transaction,from,to,currency,amount,normalizedAtomicAmount,usd", ...exportRows.map((row) => Object.values(row).map(evidenceCsvCell).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${props.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-intelligence.${kind}`; anchor.click(); URL.revokeObjectURL(url);
  };
  // Only the two real BOUNDED scores (0-100) get a gauge -- see Gauge's own
  // header for why unbounded figures (HHI, Gini, raw counts) stay as plain
  // high-contrast readout cards below instead.
  const gauges: Array<{ label: string; value: number; max: number; formatted: string }> = [
    { label: "Demand score", value: demandScore.gradable ? demandScore.score : 0, max: 100, formatted: demandScore.gradable ? `${demandScore.score} / 100` : "Insufficient data" },
    { label: "Loaded trade screening", value: washResult.totalTradeCount ? washResult.suspicionRatio * 100 : 0, max: 100, formatted: washResult.totalTradeCount ? `${(washResult.suspicionRatio * 100).toFixed(1)}% of loaded trades` : "No priced trades to score" },
  ];
  const cards = [
    ["USD volume (loaded)", priced.length ? `$${usdVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Unpriced"],
    ["Payment currencies", currencies.join(" · ") || "No priced sales"],
    ["Listing-maker concentration", makerHhi ? `${makerHhi.toFixed(0)} HHI` : "Insufficient data"],
    ["Wash-trade detail", washResult.totalTradeCount ? `${washResult.suspiciousTradeCount} / ${washResult.totalTradeCount} trades · ${washResult.selfTransferCount} self-transfer + ${washResult.reciprocalPairCount} reciprocal-pair` : "No priced trades to score"],
    ["Loaded floor depth (+10%)", depth10 == null ? "No asks loaded" : `${depth10.toLocaleString()} unique pieces`],
    ["Maker inequality", makerCounts.length ? `${(makerGini * 100).toFixed(1)} Gini` : "Insufficient data"],
    ["Indexed universe", props.indexed.toLocaleString()],
    ["Observed transactions", scopedSales.length.toLocaleString()],
    ["On-chain royalty (ERC-2981)", onchainFacts
      ? onchainFacts.royaltySupported && onchainFacts.royaltyBps != null
        ? `${(onchainFacts.royaltyBps / 100).toFixed(2)}% → ${shortAddress(onchainFacts.royaltyReceiver ?? "")}`
        : "Not implemented on-chain"
      : onchainRead.status],
    ["Dynamic metadata (ERC-4906)", onchainFacts
      ? onchainFacts.dynamicMetadataSupported == null ? "Unknown" : onchainFacts.dynamicMetadataSupported ? "Supported — art/traits can update post-mint" : "Not signaled"
      : onchainRead.status],
  ];
  return <motion.section
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.35 }}
    style={{ "--collection-accent": accent } as React.CSSProperties}
    className={`relative isolate space-y-3 ${art.shell}`}
    data-market-shell
    aria-label="Collection intelligence"
  >
    <header className={art.hero}>
      <Image className={art.surface} src="/market/intelligence/optical-glass.webp" alt="" fill loading="eager" sizes="(max-width: 1440px) 100vw, 1440px"/>
      {props.artUrls[0] && <img className={art.art} src={props.artUrls[0]} alt={`${props.name} collection artwork`}/>}
      <div className="min-w-0 flex-1"><p className={art.kicker}>Collection intelligence · {props.chain}</p><h2 className={`${art.title} font-display`}>{props.name}</h2><p className={art.meta}>{props.supply?.toLocaleString() ?? "Supply unmeasured"} pieces · Explore the evidence behind every observation</p><div className="mt-2 flex flex-wrap gap-3 text-xs">{props.profileLinks?.map((link)=><a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" title={`Source: ${link.source}${link.observedAt ? ` · observed ${link.observedAt}` : ""}`} className="text-purple-200 underline decoration-purple-300/40 underline-offset-4">{link.label} ↗</a>)}</div></div>
    <div className={art.readouts} aria-label="Collection at a glance">
      <div><span>Lowest loaded ask</span><strong>{asks.floorWei ? (Number(asks.floorWei) / 1e18).toLocaleString(undefined, { maximumSignificantDigits: 6 }) : "Unreported"} {asks.floorWei ? askCurrency : ""}</strong><small>Across {asks.rows.length.toLocaleString()} unique loaded pieces</small></div>
      <div><span>Within 10% of floor</span><strong>{depth10?.toLocaleString() ?? "Unreported"}<em> pieces</em></strong><small>Duplicate venue listings counted once</small></div>
      <div><span>Unique holders</span><strong>{props.holders?.toLocaleString() ?? "Unreported"}</strong><small>Collection snapshot</small></div>
      <div><span>Catalog evidence</span><strong>{props.indexed.toLocaleString()}<em> indexed</em></strong><small>{props.rarityCovered.toLocaleString()} ranked pieces loaded</small></div>
    </div>
    </header>
    <div className={art.body}>

    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>{props.artUrls.slice(0, 4).map((url, index) => <div key={`${url}-${index}`} className="absolute aspect-square w-[38%] max-w-80 rounded-full bg-cover bg-center opacity-[0.04] blur-[2px] saturate-150" style={{ backgroundImage: `linear-gradient(135deg, transparent, rgba(9,6,15,.88)), url(${JSON.stringify(url)})`, right: `${(index % 2) * 42 - 8}%`, top: `${Math.floor(index / 2) * 48 - 12}%`, transform: `rotate(${index % 2 ? 9 : -8}deg) scale(1.15)` }}/>)}</div>
      {props.historyCoverage && <div className="grid gap-2 rounded-lg border border-amber-400/35 bg-amber-500/5 p-2 text-[0.65rem] sm:grid-cols-3" role="status"><div><span className="block font-black uppercase tracking-wider text-foreground/45">Protocol coverage</span><strong>{props.historyCoverage.completeThroughGenesis ? `${props.historyCoverage.scope ?? "source"} chain scan complete` : `${props.historyCoverage.scope ?? "source"} backfill in progress`}</strong><span className="block text-amber-200/75">{props.historyCoverage.completeMarketHistory ? "Source reports complete market history for this scope." : "Total multi-venue market history is not yet complete."}</span></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Evidence ledger</span><strong>{props.sales.length.toLocaleString()} loaded / {props.historyCoverage.indexedEvents.toLocaleString()} indexed</strong></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Observed span</span><strong>{props.historyCoverage.oldestTimestamp ? new Date(props.historyCoverage.oldestTimestamp).toLocaleDateString() : "Timestamp repair pending"} to {props.historyCoverage.newestTimestamp ? new Date(props.historyCoverage.newestTimestamp).toLocaleDateString() : "now"}</strong></div></div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Intelligence landscape">
          {([["space", "Spatial evidence"], ["timeline", "Exact chronology"], ["network", "Trade network"], ["dossier", "Dossier"]] as const).map(([mode,label]) => <button key={mode} type="button" role="tab" aria-selected={landscape===mode} onClick={()=>setLandscape(mode)} className={`min-h-10 rounded-md border px-3 text-xs font-bold ${landscape===mode ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line"}`}>{label}</button>)}
        </div>
        <div className="flex items-center gap-2"><span title={freshness.title} className={art.meta} style={{color:freshness.color}}>{freshness.label}</span><button type="button" onClick={()=>download("csv")} className={art.control}>Export CSV</button><button type="button" onClick={()=>download("json")} className={art.control}>Export JSON</button></div>
      </div>
      {landscape === "space" && <CollectionEvidenceSpace sales={evidenceSales} artUrls={props.artUrls}/>}
      {landscape === "timeline" && <EvidenceTimeline sales={props.sales} range={timeRange} onRange={setTimeRange}/>}
      {landscape === "network" && <CollectionTradeGraph sales={scopedSales}/>}
      {landscape === "dossier" && (
        <CollectionDossier
          facts={{
            name: props.name,
            chain: props.chain,
            supply: props.supply,
            holders: props.holders,
            listedCount: props.listedCount ?? props.listings.length,
            demandScore: demandScore.gradable ? demandScore.score : null,
            demandGradable: demandScore.gradable,
            washRatio: washResult.totalTradeCount ? washResult.suspicionRatio : null,
            washTradeCount: washResult.suspiciousTradeCount,
            totalTradeCount: washResult.totalTradeCount,
            makerHhi,
            makerGini: makerCounts.length ? makerGini : null,
            usdVolume,
            observedTransactions: scopedSales.length,
            walletCount: new Set(scopedSales.flatMap((s) => [screeningWalletKey(s.from), screeningWalletKey(s.to)]).filter(Boolean)).size,
          }}
        />
      )}
      <div className={art.researchRow}>
        <article className={`${art.glass} ${art.inspector}`}><p className={art.kicker}>Loaded listings · {askCurrency}</p><div className="mb-3 flex items-center justify-between gap-2"><h4 className="font-display text-lg">Ask ladder</h4>{listingCurrencies.length > 1 && <select className={art.control} aria-label="Ask currency" value={askCurrency} onChange={(event) => setAskCurrency(event.target.value)}>{listingCurrencies.map((currency) => <option key={currency}>{currency}</option>)}</select>}</div><DepthCurve listings={asks.rows} currency={askCurrency}/></article>
        <article className={`${art.glass} ${art.inspector}`}><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={art.kicker}>Metadata × asking prices</p><h4 className="font-display text-lg">Trait explorer</h4></div><select className={art.control} aria-label="Explore listed trait" value={activeTrait ? traitKey! : ""} onChange={(event) => setTraitKey(event.target.value || null)}><option value="">All loaded pieces</option>{asks.traitPremiums.map((trait) => <option key={JSON.stringify([trait.traitType, trait.value])} value={JSON.stringify([trait.traitType, trait.value])}>{trait.traitType}: {trait.value} · {trait.listed} listed</option>)}</select></div>
          <p className={`${art.meta} mt-3`}>{activeTrait ? `${activeTrait.listed} unique loaded asks · median ${(Number(activeTrait.medianWei)/1e18).toLocaleString(undefined,{maximumSignificantDigits:5})} ${askCurrency} · ${activeTrait.premiumPct?.toFixed(1)}% above loaded floor` : `${asks.traitPremiums.length} trait values with asking-price evidence`}</p>
          <div className={art.examples}>{traitExamples.map((token) => <figure key={token.tokenId} aria-label={`${token.name ?? `NFT #${token.tokenId}`}${activeTrait ? ` · ${activeTrait.traitType}: ${activeTrait.value}` : ""}`}>{token.imageUrl ? <img src={token.imageUrl} alt={token.name ?? `NFT #${token.tokenId}`} loading="lazy"/> : <div className={art.missingArt}>Image unavailable</div>}<figcaption><span title={token.name ?? `NFT #${token.tokenId}`}>#{token.tokenId}</span><span>{askByToken.has(token.tokenId) ? `${(Number(askByToken.get(token.tokenId)!.priceWei)/1e18).toLocaleString(undefined,{maximumSignificantDigits:4})} ${askCurrency}` : "No loaded ask"}</span></figcaption></figure>)}</div>
          <p className={art.meta}>{traitExamples.length ? "Examples from loaded metadata. Asking premiums are not realized sale premiums." : "No matching token metadata loaded yet. Trait evidence appears as catalog records arrive."}</p>
        </article>
      </div>
      <details className={art.details} onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}><summary>Market diagnostics <span>Demand, liquidity, ownership and provenance</span></summary>{diagnosticsOpen && <>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {gauges.map((g) => <Gauge key={g.label} label={g.label} value={g.value} max={g.max} formatted={g.formatted} accent={accent} />)}
        {cards.map(([label, value]) => <motion.div key={label} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25 }} title={`${label}: ${value}`} className="group rounded-lg border border-line bg-background/65 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:bg-[color-mix(in_srgb,var(--collection-accent)_12%,transparent)]" style={{ borderColor: undefined }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = accent)} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}><p className="text-[0.58rem] font-black uppercase text-foreground/40">{label}</p><p className="mt-1 break-words font-display text-base text-gold-300">{value}</p></motion.div>)}
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
        <article className="rounded-lg border bg-background/55 p-3 backdrop-blur-sm" style={{ borderColor: `color-mix(in srgb, ${accent} 35%, transparent)` }}><div className="mb-2"><p className="text-[0.58rem] font-black uppercase tracking-wider" style={{ color: accent }}>Executable liquidity</p><h4 className="font-display text-base text-gold-300">Ask ladder & floor premium</h4><p className="text-[0.62rem] text-foreground/40">Move or drag across every loaded live ask to inspect its exact token, maker, native price, cumulative depth, and premium to floor. The price axis uses log(1 + price); inspection retains the original amount.</p></div><DepthCurve listings={asks.rows} currency={askCurrency}/></article>
        <article className="grid gap-4 rounded-lg border border-gold-400/35 bg-background/55 p-3 backdrop-blur-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"><Donut rows={currencyRows} label="Selected sale currency mix" accent={accent} /><Donut rows={rarityRows} label="Indexed rarity composition" accent={accent} /><Donut rows={makerCounts.slice(0, 8).map(([addr, count]) => [shortAddress(addr), count] as [string, number])} label={`Live-ask maker share${makerHhi ? ` · ${makerHhi.toFixed(0)} HHI` : ""}`} accent={accent} /></article>
      </div>
    <div className="grid gap-3 rounded-lg border border-line bg-background/35 p-3 md:grid-cols-2"><Bar label="Supply currently listed" value={listedPct}/><Bar label="Holders / supply ratio" value={holderPct}/><Bar label="Loaded ranked pieces / indexed catalog" value={rarityPct}/><Bar label="Loaded sales with transaction identity" value={provenancePct}/></div>
    <div className="grid gap-2 text-[0.62rem] leading-relaxed text-foreground/45 md:grid-cols-3"><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Liquidity:</strong> depth near floor measures executable choice, while maker HHI/Gini expose whether many cards are controlled by a small set of wallets.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Provenance:</strong> transaction coverage reports how much observed activity links back to a verifiable chain transaction.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Limits:</strong> rarity is metadata-dependent; manipulation flags are screening signals, not accusations or investment advice.</p></div>
      </>}</details>
    </div>
  </motion.section>;
}
