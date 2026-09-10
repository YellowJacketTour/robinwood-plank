"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saleCurrencies, saleObservations, type IntelSale } from "@/lib/market/multichain/intel-evidence";
import styles from "./CollectionIntelArt.module.css";

type EvidenceSale = IntelSale & { traits?: Array<{traitType:string;value:string}>; tokenName?: string | null; imageUrl?: string | null; from?: string | null; to?: string | null };
type Point = { sale: EvidenceSale; time: number; value: number; exact: string; sourceIndex: number };
const identity = (sale: EvidenceSale) => JSON.stringify([sale.transaction, sale.tokenId, sale.timestamp, sale.priceAmount, sale.priceWei]);
const utc = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Time unavailable";
const compactIdentity = (value?: string | null) => !value ? "Unreported" : value.length > 22 ? `${value.slice(0,8)}…${value.slice(-6)}` : value;

function EvidenceCloud({ points, active, onActive, currency }: { points: Point[]; active: string | null; onActive: (key: string) => void; currency: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(220, entry.contentRect.width)));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const minTime = Math.min(...points.map((point) => point.time));
  const maxTime = Math.max(...points.map((point) => point.time));
  const maxPrice = Math.max(...points.map((point) => point.value));
  const left = 54, right = width - 22, top = 28, bottom = 178;
  const x = (time: number) => left + (maxTime === minTime ? .5 : (time-minTime)/(maxTime-minTime)) * (right-left);
  const y = (value: number) => bottom - Math.log1p(value)/Math.log1p(maxPrice)*(bottom-top);
  const selected = points.find((point) => identity(point.sale) === active);
  const selectedX = selected ? x(selected.time) : 0;
  const selectedY = selected ? y(selected.value) : 0;
  return <div ref={root} className="h-full w-full"><svg width="100%" height="210" viewBox={`0 0 ${width} 210`} role="img" aria-label={`Loaded sales by UTC time and log one plus price in ${currency}`}>
    {[0,.25,.5,.75,1].map((fraction) => <g key={fraction}>
      <line x1={left} x2={right} y1={bottom-fraction*(bottom-top)} y2={bottom-fraction*(bottom-top)} stroke="#bd94ef" opacity={fraction===0?.4:.16}/>
      <text x={left-9} y={bottom-fraction*(bottom-top)+4} fill="#d3c6e1" fontSize="12" textAnchor="end">{Math.expm1(fraction*Math.log1p(maxPrice)).toLocaleString(undefined,{maximumSignificantDigits:3})}</text>
    </g>)}
    <text x={left} y="16" fill="#d3c6e1" fontSize="12">{currency} · log(1 + price)</text>
    {[0,.5,1].map((fraction) => <text key={fraction} x={left+fraction*(right-left)} y="200" fill="#d3c6e1" fontSize="10" textAnchor={fraction===0?"start":fraction===1?"end":"middle"}>{new Date(minTime+fraction*(maxTime-minTime)).toISOString().slice(5,16).replace("T"," ")}</text>)}
    {points.map((point) => <g key={`${identity(point.sale)}-${point.sourceIndex}`} onClick={() => onActive(identity(point.sale))} style={{cursor:"pointer"}}>
      <circle cx={x(point.time)} cy={y(point.value)} r="8" fill="transparent"/>
      <circle cx={x(point.time)} cy={y(point.value)} r="4" fill="#bd94ef" opacity=".18" pointerEvents="none"/>
      <circle cx={x(point.time)} cy={y(point.value)} r="2.3" fill="#dec5ff" pointerEvents="none"/>
      <title>{`#${point.sale.tokenId ?? "unknown"} · ${point.exact} ${currency} · ${utc(point.sale.timestamp)}`}</title>
    </g>)}
    {selected && <g pointerEvents="none">
      <path d={`M ${left} ${selectedY} H ${selectedX} V ${bottom}`} fill="none" stroke="#f4c95d" opacity=".6"/>
      <circle cx={selectedX} cy={selectedY} r="8" fill="#f4c95d" opacity=".18"/>
      <circle cx={selectedX} cy={selectedY} r="4" fill="#f4c95d"/>
      <text x={selectedX > width/2 ? selectedX-12 : selectedX+12} y={selectedY > 48 ? selectedY-12 : selectedY+20} textAnchor={selectedX > width/2 ? "end" : "start"} fill="#ffe5a1" stroke="#08070e" strokeWidth="4" paintOrder="stroke" fontSize="12">{selected.value.toLocaleString(undefined,{maximumSignificantDigits:6})} {currency}</text>
    </g>}
  </svg></div>;
}

export default function CollectionEvidenceSpace({ sales, artUrls = [] }: { sales: EvidenceSale[]; artUrls?: string[] }) {
  const [requestedCurrency, setCurrency] = useState("");
  const [hours, setHours] = useState(168);
  const [active, setActive] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => { const initial = setTimeout(() => setNow(Date.now()),0); const timer=setInterval(()=>setNow(Date.now()),15_000); return()=>{clearTimeout(initial);clearInterval(timer);}; },[]);
  const currencies = useMemo(() => saleCurrencies(sales), [sales]);
  const currency = currencies.includes(requestedCurrency) ? requestedCurrency : currencies[0] ?? "Native";
  const points = useMemo(() => saleObservations(sales,currency,now,hours*3_600_000),[sales,currency,now,hours]);
  const selected = points.find((p) => identity(p.sale) === active) ?? points[points.length-1];
  const selectedArt = selected?.sale.imageUrl;
  return <div className={styles.observatory}>
    <article className={styles.glass} aria-label="Interactive market evidence">
      <div className={styles.toolbar}><div><h4 className="font-display">Sales observatory</h4><p className={styles.meta}>Time × sale price · Native evidence, with USD when recorded</p></div><div className="flex gap-2"><select className={styles.control} aria-label="Observatory interval" value={hours} onChange={(e)=>setHours(Number(e.target.value))}>{[24,168,720].map((h)=><option key={h} value={h}>{h===24?"24h":`${h/24}d`}</option>)}</select><select className={styles.control} aria-label="Observatory currency" value={currency} onChange={(e)=>setCurrency(e.target.value)}>{(currencies.length?currencies:[currency]).map((c)=><option key={c}>{c}</option>)}</select></div></div>
      <div className={styles.canvas}>
        {points.length ? <EvidenceCloud points={points} active={selected?identity(selected.sale):null} onActive={setActive} currency={currency}/> : <div className="grid h-full place-items-center px-8 text-center"><p className={styles.meta}>{now?"No timestamped sales loaded for this currency and interval. The observatory appears when evidence arrives.":"Preparing the observatory…"}</p></div>}
      </div>
      <div className={styles.footer}><p className={styles.meta}>{points.length} loaded sales · Horizontal: time · Vertical: log(1 + price) in {currency} · Select a point or use the list to inspect.</p>{points.length>0&&<select className={`${styles.control} mt-2 w-full`} aria-label="Inspect observed sale" value={selected?identity(selected.sale):""} onChange={(e)=>setActive(e.target.value)}>{points.map((p)=><option key={`${identity(p.sale)}-${p.sourceIndex}`} value={identity(p.sale)}>#{p.sale.tokenId??"unknown"} · {p.exact} {currency} · {utc(p.sale.timestamp)}</option>)}</select>}</div>
    </article>
    <aside className={`${styles.glass} ${styles.inspector} ${styles.saleInspector}`} aria-label="Selected sale evidence">
      <div><p className={styles.kicker}>{selected?"Selected sale":"Collection artwork"}</p>{(selectedArt||artUrls[0])&&<img className={styles.selectedArt} src={selectedArt||artUrls[0]} alt={selectedArt?selected?.sale.tokenName||`NFT ${selected?.sale.tokenId}`:"Collection image, not the selected token"}/>}{selected && <div className={styles.selectedTraits}><p className={styles.kicker}>Loaded traits</p><p className={styles.meta}>{selected.sale.traits?.length ? selected.sale.traits.map((trait) => `${trait.traitType}: ${trait.value}`).join(" · ") : "Traits have not arrived for this piece."}</p></div>}</div>
      <div>{selected ? <><h4 className="font-display text-lg">{selected.sale.tokenName||`NFT #${selected.sale.tokenId??"unknown"}`}</h4><p className={styles.amount}>{Number(selected.exact).toLocaleString(undefined,{maximumSignificantDigits:7})} {currency}</p><p className={styles.record}>{utc(selected.sale.timestamp)}</p>{!selectedArt&&<p className={styles.meta}>Collection image shown; token image unavailable.</p>}<dl className="mt-4 space-y-3"><div><dt className={styles.kicker}>Seller</dt><dd className={styles.record}><abbr title={selected.sale.from||undefined} aria-label={selected.sale.from||"Unreported"}>{compactIdentity(selected.sale.from)}</abbr></dd></div><div><dt className={styles.kicker}>Buyer</dt><dd className={styles.record}><abbr title={selected.sale.to||undefined} aria-label={selected.sale.to||"Unreported"}>{compactIdentity(selected.sale.to)}</abbr></dd></div><div><dt className={styles.kicker}>Transaction</dt><dd className={styles.record}><abbr title={selected.sale.transaction||undefined} aria-label={selected.sale.transaction||"Unreported"}>{compactIdentity(selected.sale.transaction)}</abbr></dd></div><div><dt className={styles.kicker}>Exact amount</dt><dd className={styles.record}>{selected.exact} {currency}</dd></div></dl></> : <p className={styles.meta}>Recorded transactions will populate this inspector. No prices or histories are simulated.</p>}</div>

    </aside>
  </div>;
}
