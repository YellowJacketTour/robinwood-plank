"use client";

import { useState } from "react";

type Sale = { priceAmount?: string | null; priceUsd?: number | null; priceSymbol: string | null; transaction: string | null; from: string | null; to: string | null };
type Listing = { priceWei: string; maker?: string | null; tokenId: string };
type TierCounts = Record<string, number>;
type Lens = "overview" | "liquidity" | "rarity" | "provenance";

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

function SignalConstellation({ currencies, rarity, makers }: { currencies: Array<[string, number]>; rarity: Array<[string, number]>; makers: number }) {
  const nodes = [...currencies.slice(0, 3).map(([label, value]) => ({ label, value, currency: true })), ...rarity.slice(0, 5).map(([label, value]) => ({ label, value, currency: false }))];
  const max = Math.max(1, ...nodes.map((node) => node.value));
  return <svg viewBox="0 0 600 260" className="h-64 w-full" role="img" aria-label="Linked collection signal constellation"><defs><radialGradient id="core-glow"><stop offset="0" stopColor="#f4c95d" stopOpacity=".9"/><stop offset="1" stopColor="#b47cff" stopOpacity=".2"/></radialGradient><filter id="soft-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g opacity=".2">{Array.from({ length: 12 }, (_, index) => <circle key={index} cx={30 + (index * 83) % 540} cy={25 + (index * 47) % 210} r="1" fill="#fff"/>)}</g>{nodes.map((node, index) => { const angle = index / Math.max(1, nodes.length) * Math.PI * 2 - Math.PI / 2; const x = 300 + Math.cos(angle) * (index % 2 ? 185 : 135); const y = 130 + Math.sin(angle) * (index % 2 ? 90 : 105); const radius = 8 + Math.sqrt(node.value / max) * 18; const color = node.currency ? "#f4c95d" : "#b47cff"; return <g key={`${node.currency}-${node.label}`} className="cursor-help"><title>{node.label}: {node.value.toLocaleString()} observed</title><line x1="300" y1="130" x2={x} y2={y} stroke={color} strokeOpacity=".35"/><circle cx={x} cy={y} r={radius} fill={color} fillOpacity=".16" stroke={color}/><text x={x} y={y + 3} textAnchor="middle" fill="#f5eedc" fontSize="9">{node.label.slice(0, 12)}</text></g>; })}<circle cx="300" cy="130" r="48" fill="url(#core-glow)" filter="url(#soft-glow)"/><circle cx="300" cy="130" r="37" fill="#100c18"/><text x="300" y="126" textAnchor="middle" fill="#f4c95d" fontSize="17" fontWeight="800">{makers}</text><text x="300" y="143" textAnchor="middle" fill="#c9bed9" fontSize="9">MAKERS</text></svg>;
}

export default function CollectionIntelligence(props: {
  name: string; chain: string; supply: number | null; holders: number | null;
  indexed: number; rarityCovered: number; rarityTiers: TierCounts; listings: Listing[]; sales: Sale[]; artUrls: string[];
}) {
  const [lens, setLens] = useState<Lens>("overview");
  const listedPct = props.supply ? props.listings.length / props.supply * 100 : 0;
  const holderPct = props.supply && props.holders ? props.holders / props.supply * 100 : 0;
  const rarityPct = props.indexed ? props.rarityCovered / props.indexed * 100 : 0;
  const makers = new Map<string, number>();
  for (const row of props.listings) if (row.maker) makers.set(row.maker.toLowerCase(), (makers.get(row.maker.toLowerCase()) ?? 0) + 1);
  const makerHhi = props.listings.length ? [...makers.values()].reduce((sum, count) => sum + (count / props.listings.length) ** 2, 0) * 10_000 : 0;
  const priced = props.sales.filter((sale) => sale.priceUsd != null);
  const usdVolume = priced.reduce((sum, sale) => sum + sale.priceUsd!, 0);
  const currencies = [...new Set(props.sales.map((sale) => sale.priceSymbol).filter(Boolean))];
  const provenancePct = props.sales.length ? props.sales.filter((sale) => sale.transaction).length / props.sales.length * 100 : 0;
  const selfTrades = props.sales.filter((sale) => sale.from && sale.to && sale.from.toLowerCase() === sale.to.toLowerCase()).length;
  const listingPrices = props.listings.map((listing) => Number(listing.priceWei)).filter((value) => Number.isFinite(value) && value > 0);
  const floor = listingPrices.length ? Math.min(...listingPrices) : 0;
  const depth10 = floor ? listingPrices.filter((value) => value <= floor * 1.1).length : 0;
  const makerCounts = [...makers.entries()].sort((a, b) => b[1] - a[1]);
  const makerGini = gini(makerCounts.map(([, count]) => count));
  const currencyRows = [...new Map(props.sales.map((sale) => [sale.priceSymbol || "Unknown", 0])).keys()].map((symbol) => [symbol, props.sales.filter((sale) => (sale.priceSymbol || "Unknown") === symbol).length] as [string, number]);
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
    ["Observed transactions", props.sales.length.toLocaleString()],
  ];
  return <section className="relative isolate space-y-3 overflow-hidden rounded-xl border border-line bg-panel p-3" aria-label="Collection intelligence">
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>{props.artUrls.slice(0, 4).map((url, index) => <div key={`${url}-${index}`} className="absolute aspect-square w-[38%] max-w-80 rounded-full bg-cover bg-center opacity-[0.04] blur-[2px] saturate-150" style={{ backgroundImage: `linear-gradient(135deg, transparent, rgba(9,6,15,.88)), url(${JSON.stringify(url)})`, right: `${(index % 2) * 42 - 8}%`, top: `${Math.floor(index / 2) * 48 - 12}%`, transform: `rotate(${index % 2 ? 9 : -8}deg) scale(1.15)` }}/>)}</div>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[0.62rem] font-black uppercase tracking-[0.18em] text-purple-300">Collection intelligence</p><h3 className="font-display text-lg text-gold-300">Market structure & provenance</h3><p className="text-xs text-foreground/45">Computed only from indexed evidence · loaded-window metrics are labeled, never extrapolated.</p></div><div className="flex gap-1"><button type="button" onClick={() => download("csv")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export CSV</button><button type="button" onClick={() => download("json")} className="min-h-9 rounded-md border border-line px-2 py-1 text-xs font-bold">Export JSON</button></div></div>
      <nav className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-background/55 p-1" aria-label="Intelligence lenses">{(["overview", "liquidity", "rarity", "provenance"] as Lens[]).map((item) => <button key={item} type="button" onClick={() => setLens(item)} aria-pressed={lens === item} className={`min-h-9 flex-1 whitespace-nowrap rounded-md px-3 text-[0.65rem] font-black uppercase tracking-wide transition ${lens === item ? "bg-purple-500/25 text-purple-200 shadow-[inset_0_0_18px_rgba(180,124,255,.12)]" : "text-foreground/45 hover:text-gold-300"}`}>{item}</button>)}</nav>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value]) => <div key={label} title={`${label}: ${value}`} className="group rounded-lg border border-line bg-background/65 p-3 backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-purple-400/60 hover:bg-purple-500/10"><p className="text-[0.58rem] font-black uppercase text-foreground/40">{label}</p><p className="mt-1 break-words font-display text-base text-gold-300">{value}</p></div>)}</div>
      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
        <article className={`rounded-lg border bg-background/55 p-3 backdrop-blur-sm transition-all ${lens === "overview" || lens === "liquidity" ? "border-purple-400/45 shadow-[0_0_30px_rgba(180,124,255,.08)]" : "border-line opacity-45"}`}><div className="mb-2"><p className="text-[0.58rem] font-black uppercase tracking-wider text-purple-300">Liquidity topology</p><h4 className="font-display text-base text-gold-300">Cumulative order-book depth</h4><p className="text-[0.62rem] text-foreground/40">Each horizontal step adds a live ask; the vertical axis is relative price, clipped at the 95th percentile.</p></div><DepthCurve prices={listingPrices}/></article>
        <article className={`grid gap-4 rounded-lg border bg-background/55 p-3 backdrop-blur-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 ${lens === "overview" || lens === "rarity" ? "border-gold-400/35" : "border-line opacity-45"}`}><Donut rows={currencyRows} label="Sale currency mix"/><Donut rows={rarityRows} label="Rarity composition"/></article>
      </div>
      <article className={`relative overflow-hidden rounded-lg border bg-[radial-gradient(circle_at_center,rgba(180,124,255,.12),transparent_62%)] p-2 backdrop-blur-sm transition-all ${lens === "overview" || lens === "provenance" ? "border-purple-400/45" : "border-line opacity-45"}`}><div className="absolute left-3 top-3"><p className="text-[0.58rem] font-black uppercase tracking-wider text-purple-300">Relationship field</p><p className="text-[0.62rem] text-foreground/40">Hover nodes to inspect loaded evidence.</p></div><SignalConstellation currencies={currencyRows} rarity={rarityRows} makers={makers.size}/></article>
    <div className="grid gap-3 rounded-lg border border-line bg-background/35 p-3 md:grid-cols-2"><Bar label="Supply currently listed" value={listedPct}/><Bar label="Unique-holder coverage" value={holderPct}/><Bar label="Rarity coverage" value={rarityPct}/><Bar label="Transaction provenance" value={provenancePct}/></div>
    <div className="grid gap-2 text-[0.62rem] leading-relaxed text-foreground/45 md:grid-cols-3"><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Liquidity:</strong> depth near floor measures executable choice, while maker HHI/Gini expose whether many cards are controlled by a small set of wallets.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Provenance:</strong> transaction coverage reports how much observed activity links back to a verifiable chain transaction.</p><p className="rounded-md border border-line p-2"><strong className="text-foreground/70">Limits:</strong> rarity is metadata-dependent; manipulation flags are screening signals, not accusations or investment advice.</p></div>
  </section>;
}
