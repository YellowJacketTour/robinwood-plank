"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";

const CollectionEvidenceSpace = dynamic(() => import("@/components/market/CollectionEvidenceSpace"), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl border border-line bg-background/55" /> });

type Sale = { timestamp?: string | null; tokenId?: string | null; tokenName?: string | null; imageUrl?: string | null; priceAmount?: string | null; priceUsd?: number | null; priceSymbol: string | null; transaction: string | null; from: string | null; to: string | null };
type Listing = { priceWei: string; maker?: string | null; tokenId: string };
type TierCounts = Record<string, number>;
type HistoryCoverage = { source: string; scope?: string; indexedEvents: number; timestampedEvents: number; oldestTimestamp: string | null; newestTimestamp: string | null; completeThroughGenesis: boolean; completeMarketHistory?: boolean; genesisBackfillBlock?: number | null; liveIndexedBlock?: number | null };

function pct(value: number): string { return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`; }
function Bar({ value, label }: { value: number; label: string }) {
  return <div><div className="mb-1 flex justify-between gap-2 text-[0.65rem]"><span>{label}</span><span>{pct(value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-gradient-to-r from-gold-500 to-purple-400" style={{ width: pct(value) }} /></div></div>;
}

const CHART_COLORS = ["#f4c95d", "#b47cff", "#48d7a4", "#58a6ff", "#ff718b", "#d7d0c7"];
function Donut({ rows, label }: { rows: Array<[string, number]>; label: string }) {
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  let cursor = 0;
  const gradient = rows.map(([, value], index) => {
    const start = total ? cursor / total * 100 : 0; cursor += value;
    const end = total ? cursor / total * 100 : 0;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${end}%`;
  }).join(", ");
  return <div className="flex min-w-0 items-center gap-3"><div className="grid size-28 shrink-0 place-items-center rounded-full" style={{ background: total ? `conic-gradient(${gradient})` : "rgba(255,255,255,.06)" }}><div className="grid size-16 place-items-center rounded-full bg-panel text-center"><span className="text-lg font-black tabular-nums text-gold-300">{total.toLocaleString()}</span></div></div><div className="min-w-0 space-y-1"><p className="text-[0.58rem] font-black uppercase tracking-wider text-foreground/45">{label}</p>{rows.slice(0, 6).map(([name, value], index) => <div key={name} className="flex items-center gap-1.5 text-[0.65rem]"><span className="size-2 rounded-full" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }}/><span className="min-w-0 flex-1 truncate">{name}</span><span className="tabular-nums text-foreground/55">{total ? pct(value / total * 100) : "0%"}</span></div>)}</div></div>;
}

function DepthCurve({ prices }: { prices: number[] }) {
  const sorted = [...prices].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length < 2) return <div className="grid min-h-40 place-items-center text-xs text-foreground/40">More priced listings are needed for a depth curve.</div>;
  const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))];
  const points = sorted.map((price, index) => `${(index / (sorted.length - 1)) * 100},${92 - Math.min(price / cap, 1) * 78}`).join(" ");
  return <div><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full overflow-visible" role="img" aria-label="Cumulative listing depth by relative price"><defs><linearGradient id="depth-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b47cff" stopOpacity=".6"/><stop offset="1" stopColor="#b47cff" stopOpacity="0"/></linearGradient></defs><polygon points={`0,100 ${points} 100,100`} fill="url(#depth-fill)"/><polyline points={points} fill="none" stroke="#f4c95d" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/><line x1="0" y1="92" x2="100" y2="92" stroke="rgba(255,255,255,.18)" strokeWidth=".5" vectorEffect="non-scaling-stroke"/></svg><div className="flex justify-between text-[0.58rem] text-foreground/40"><span>Floor</span><span>95th percentile ask</span></div></div>;
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
}) {
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);
  const [landscape, setLandscape] = useState<"space" | "timeline">("space");
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
  const selfTrades = scopedSales.filter((sale) => sale.from && sale.to && sale.from.toLowerCase() === sale.to.toLowerCase()).length;
  const listingPrices = props.listings.map((listing) => Number(listing.priceWei)).filter((value) => Number.isFinite(value) && value > 0);
  const floor = listingPrices.length ? Math.min(...listingPrices) : 0;
  const depth10 = floor ? listingPrices.filter((value) => value <= floor * 1.1).length : 0;
  const makerCounts = [...makers.entries()].sort((a, b) => b[1] - a[1]);
  const makerGini = gini(makerCounts.map(([, count]) => count));
  const currencyRows = [...new Map(scopedSales.map((sale) => [sale.priceSymbol || "Unknown", 0])).keys()].map((symbol) => [symbol, scopedSales.filter((sale) => (sale.priceSymbol || "Unknown") === symbol).length] as [string, number]);
  const rarityRows = Object.entries(props.rarityTiers).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const exportRows = props.sales.map((sale) => ({ collection: props.name, chain: props.chain, transaction: sale.transaction, from: sale.from, to: sale.to, currency: sale.priceSymbol, amount: sale.priceAmount, usd: sale.priceUsd }));
  const download = (kind: "json" | "csv") => {
    const body = kind === "json" ? JSON.stringify(exportRows, null, 2) : ["collection,chain,transaction,from,to,currency,amount,usd", ...exportRows.map((row) => [row.collection, row.chain, row.transaction, row.from, row.to, row.currency, row.amount, row.usd].map((value) => JSON.stringify(value ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${props.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-intelligence.${kind}`; anchor.click(); URL.revokeObjectURL(url);
  };
  const cards = [
    ["USD volume (loaded)", usdVolume ? `$${usdVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Unpriced"],
    ["Payment currencies", currencies.join(" · ") || "No priced sales"],
    ["Listing-maker concentration", makerHhi ? `${makerHhi.toFixed(0)} HHI` : "Insufficient data"],
    ["Self-transfer sales", `${selfTrades} flagged`],
    ["Floor depth (+10%)", `${depth10.toLocaleString()} asks`],
    ["Maker inequality", makerCounts.length ? `${(makerGini * 100).toFixed(1)} Gini` : "Insufficient data"],
    ["Indexed universe", props.indexed.toLocaleString()],
    ["Observed transactions", scopedSales.length.toLocaleString()],
  ];
  return <section className="relative isolate space-y-3 overflow-hidden rounded-xl border border-line bg-panel p-3" aria-label="Collection intelligence">
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>{props.artUrls.slice(0, 4).map((url, index) => <div key={`${url}-${index}`} className="absolute aspect-square w-[38%] max-w-80 rounded-full bg-cover bg-center opacity-[0.04] blur-[2px] saturate-150" style={{ backgroundImage: `linear-gradient(135deg, transparent, rgba(9,6,15,.88)), url(${JSON.stringify(url)})`, right: `${(index % 2) * 42 - 8}%`, top: `${Math.floor(index / 2) * 48 - 12}%`, transform: `rotate(${index % 2 ? 9 : -8}deg) scale(1.15)` }}/>)}</div>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[0.62rem] font-black uppercase tracking-[0.18em] text-purple-300">Collection intelligence</p><h3 className="font-display text-lg text-gold-300">Market structure & provenance</h3><p className="text-xs text-foreground/45">Computed only from indexed evidence · loaded-window metrics are labeled, never extrapolated.</p></div><div className="flex gap-1"><button type="button" onClick={() => download("csv")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export CSV</button><button type="button" onClick={() => download("json")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export JSON</button></div></div>
      {props.historyCoverage && <div className="grid gap-2 rounded-lg border border-amber-400/35 bg-amber-500/5 p-2 text-[0.65rem] sm:grid-cols-3" role="status"><div><span className="block font-black uppercase tracking-wider text-foreground/45">Protocol coverage</span><strong>{props.historyCoverage.completeThroughGenesis ? `${props.historyCoverage.scope ?? "source"} chain scan complete` : `${props.historyCoverage.scope ?? "source"} backfill in progress`}</strong><span className="block text-amber-200/75">Total multi-venue market history is not yet complete.</span></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Evidence ledger</span><strong>{props.sales.length.toLocaleString()} loaded / {props.historyCoverage.indexedEvents.toLocaleString()} indexed</strong></div><div><span className="block font-black uppercase tracking-wider text-foreground/45">Observed span</span><strong>{props.historyCoverage.oldestTimestamp ? new Date(props.historyCoverage.oldestTimestamp).toLocaleDateString() : "Timestamp repair pending"} to {props.historyCoverage.newestTimestamp ? new Date(props.historyCoverage.newestTimestamp).toLocaleDateString() : "now"}</strong></div></div>}
      <div className="flex gap-1" role="tablist" aria-label="Intelligence landscape"><button type="button" role="tab" aria-selected={landscape === "space"} onClick={() => setLandscape("space")} className={`min-h-10 rounded-md border px-3 text-xs font-bold ${landscape === "space" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line"}`}>Spatial evidence</button><button type="button" role="tab" aria-selected={landscape === "timeline"} onClick={() => setLandscape("timeline")} className={`min-h-10 rounded-md border px-3 text-xs font-bold ${landscape === "timeline" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line"}`}>Exact chronology</button></div>
      {landscape === "space" ? <CollectionEvidenceSpace sales={props.sales}/> : <EvidenceTimeline sales={props.sales} range={timeRange} onRange={setTimeRange}/>} 
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value]) => <div key={label} title={`${label}: ${value}`} className="group rounded-lg border border-line bg-background/65 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-purple-400/60 hover:bg-purple-500/10"><p className="text-[0.58rem] font-black uppercase text-foreground/40">{label}</p><p className="mt-1 break-words font-display text-base text-gold-300">{value}</p></div>)}</div>
      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
        <article className="rounded-lg border border-purple-400/35 bg-background/55 p-3 backdrop-blur-sm"><div className="mb-2"><p className="text-[0.58rem] font-black uppercase tracking-wider text-purple-300">Liquidity topology</p><h4 className="font-display text-base text-gold-300">Current cumulative order-book depth</h4><p className="text-[0.62rem] text-foreground/40">This is a current ask distribution—not a time series. Each horizontal step adds a live ask; price is clipped at the 95th percentile.</p></div><DepthCurve prices={listingPrices}/></article>
        <article className="grid gap-4 rounded-lg border border-gold-400/35 bg-background/55 p-3 backdrop-blur-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"><Donut rows={currencyRows} label="Selected sale currency mix"/><Donut rows={rarityRows} label="Indexed rarity composition"/></article>
      </div>
    <div className="grid gap-3 rounded-lg border border-line bg-background/35 p-3 md:grid-cols-2"><Bar label="Supply currently listed" value={listedPct}/><Bar label="Unique-holder coverage" value={holderPct}/><Bar label="Rarity coverage" value={rarityPct}/><Bar label="Transaction provenance" value={provenancePct}/></div>
    <div className="grid gap-2 text-[0.62rem] leading-relaxed text-foreground/45 md:grid-cols-3"><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Liquidity:</strong> depth near floor measures executable choice, while maker HHI/Gini expose whether many cards are controlled by a small set of wallets.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Provenance:</strong> transaction coverage reports how much observed activity links back to a verifiable chain transaction.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Limits:</strong> rarity is metadata-dependent; manipulation flags are screening signals, not accusations or investment advice.</p></div>
  </section>;
}
