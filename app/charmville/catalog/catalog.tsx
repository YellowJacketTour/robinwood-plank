'use client';
/* Source PNGs and sprite-sheet coordinates are intentionally retained for reference. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from 'react';
import Link from 'next/link';
import styles from '../frontier/frontier.module.css';
type Item={id:string;source:string;sourceId:string;name:string;category:string;definition:string;line:number;revision:string;fields:Record<string,string>;art:{url:string;path:string;sha256:string}|null;directions?:{x:number;y:number;frame_width:number;frame_height:number;origin_x:number;origin_y:number}[];behavior?:{url:string};palette?:{symbol:string;path:string|null}|null};
function Artwork({item}:{item:Item}){
 if(!item.art)return <span>No mapped source icon</span>;
 const frame=item.directions?.[0];
 if(frame)return <div style={{width:96,height:96,display:'grid',placeItems:'center'}}><span role='img' aria-label={`${item.name} original item sprite`} style={{display:'block',width:frame.frame_width,height:frame.frame_height,backgroundImage:`url("${item.art.url}")`,backgroundPosition:`-${frame.x}px -${frame.y}px`,imageRendering:'pixelated',transform:'scale(3)'}}/></div>;
 return <img src={item.art.url} alt={`${item.name} original source PNG`} width={72} height={72} style={{objectFit:'contain',imageRendering:'pixelated'}} loading='lazy'/>;
}
export default function Catalog(){
 const [items,setItems]=useState<Item[]>([]),[query,setQuery]=useState(''),[source,setSource]=useState(''),[selected,setSelected]=useState<Item|null>(null),[error,setError]=useState(''),[limit,setLimit]=useState(72);
 useEffect(()=>{const controller=new AbortController();fetch('/charmville/reference-items/catalog.json',{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('Source catalog is unavailable');return r.json();}).then(data=>setItems(data.items)).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[]);
 const matching=items.filter(i=>(!source||i.source===source)&&`${i.name} ${i.sourceId} ${i.category} ${Object.values(i.fields).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
 return <main data-market-shell className={styles.root}>
  <header className={styles.header}><div><span className={styles.eyebrow}>CHARMVILLE / RECONSTRUCTION WORKSHOP</span><h1>The item archives</h1><p>Original artwork, identities and behavior references, kept together.</p></div><Link href='/charmville/frontier'>Return to Charmville ↗</Link></header>
  <p className={styles.notice}>Reference collection · These are source definitions, not items owned or usable by your character. Emerald previews show source PNG palettes; runtime palette variants are recorded separately.</p>
  {error&&<p role='alert'>{error}</p>}
  <section className={styles.library} aria-label='Source item catalog'><div className={styles.libraryHeading}><h2>{items.length} original definitions</h2><input aria-label='Search source items' placeholder='Bow, Poké Ball, berry, potion, battle function…' value={query} onChange={e=>{setQuery(e.target.value);setLimit(72);}}/></div>
   <select aria-label='Item source' value={source} onChange={e=>{setSource(e.target.value);setLimit(72);}}><option value=''>All source collections</option><option value='pokeemerald'>Pokémon Emerald</option><option value='solarus-zsdx'>Solarus / Mystery of Solarus DX</option></select><p>{matching.length} matching source definitions</p>
   {selected&&<article className={styles.detail} style={{maxHeight: "calc(100vh - 80px)", overflowY: "auto"}} aria-label='Selected item source'><button onClick={()=>setSelected(null)}>Close details ×</button><h2>{selected.name}</h2><Artwork item={selected}/><p>{selected.source} · {selected.sourceId}</p><p>Definition: {selected.definition}:{selected.line}</p><code>{selected.revision}</code><dl>{Object.entries(selected.fields).map(([key,value])=><div key={key}><dt><strong>{key}</strong></dt><dd style={{overflowWrap:'anywhere'}}>{value}</dd></div>)}</dl>{selected.palette&&<p>Runtime palette: {selected.palette.symbol} {selected.palette.path||''}</p>}{selected.directions&&<p>{selected.directions.length} source sprite variants/directions retained, with frame and anchor coordinates.</p>}{selected.behavior&&<a href={selected.behavior.url} target='_blank' rel='noreferrer'>Read original item behavior script ↗</a>}{selected.art&&<p>Artwork SHA-256: <code style={{overflowWrap:'anywhere'}}>{selected.art.sha256}</code></p>}</article>}
   <div className={styles.assetGrid}>{matching.slice(0,limit).map(item=><article key={item.id}><Artwork item={item}/><strong>{item.name}</strong><small>{item.source} · {item.category}</small><button onClick={()=>setSelected(item)}>Inspect original behavior</button></article>)}</div>{matching.length>limit&&<button onClick={()=>setLimit(n=>n+72)}>Show more items</button>}
  </section>
 </main>;
}
