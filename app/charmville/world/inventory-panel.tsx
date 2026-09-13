"use client";
import Image from 'next/image';
import {useState} from 'react';
import type {YardInventory} from '@/lib/charmville/inventory';
import {charmName,charmDescription,itemArt} from '@/lib/charmville/item-display';

const button='min-h-11 rounded-lg border border-line-strong bg-forest-800 px-3 py-2 text-cream hover:bg-forest-700 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50';
export default function InventoryPanel({inventory,busy,onSetup,onRefresh}:{inventory:YardInventory|null;busy:boolean;onSetup:()=>void;onRefresh:()=>void}){
 const [selection,setSelection]=useState<{face:string;seed:boolean}|null>(null);
 const selected=selection&&inventory?(selection.seed?inventory.seeds:inventory.faces).find(stack=>stack.face===selection.face):null;
 const artwork=selected?itemArt(selected.face):undefined;
 return <section data-market-shell className="rounded-xl border-2 border-line-strong bg-forest-900 p-3 text-cream sm:p-4" aria-label="Saved inventory">
  {inventory?<>
   <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3"><h3 className="font-display text-lg text-gold-300">Your Satchel</h3><p className="font-mono text-sm text-gold-300">{inventory.grain} Grain</p></header>
   <div className="grid gap-4 pt-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div>{[{label:'Seeds & planting supplies',stacks:inventory.seeds,seed:true},{label:'Charms & harvests',stacks:inventory.faces,seed:false}].map(pocket=><section key={pocket.label} className="mb-3" aria-label={pocket.label}>
     <h4 className="mb-2 text-xs font-bold text-cream-muted">{pocket.label}</h4>
     {pocket.stacks.length?<ul className="grid gap-2">{pocket.stacks.map(stack=>{
      const image=itemArt(stack.face),active=selection?.face===stack.face&&selection.seed===pocket.seed;
      return <li key={stack.face}><button type="button" className={`${button} flex w-full items-center gap-3 text-left ${active?'outline-2 outline-gold-300':''}`} aria-pressed={active} onClick={()=>setSelection({face:stack.face,seed:pocket.seed})}>
       {image&&<Image src={image} alt="" width={32} height={32} unoptimized className="shrink-0 [image-rendering:pixelated]"/>}
       <span className="min-w-0 flex-1">{charmName(stack.face)}{pocket.seed?' seed':''}</span><span className="shrink-0 font-mono">× {stack.qty}</span>
      </button></li>;
     })}</ul>:<p className="text-sm text-cream-muted">{pocket.seed?'No seeds in this pocket.':'No charms yet. Your gathered harvests appear here.'}</p>}
    </section>)}</div>
    <aside className="self-start rounded-lg border border-line bg-forest-800 p-3" aria-label="Item details">
     {selected?<>
      {artwork&&<Image src={artwork} alt="" width={80} height={80} unoptimized className="mx-auto mb-3 [image-rendering:pixelated]"/>}
      <h4 className="font-display text-base text-gold-300">{charmName(selected.face)}{selection?.seed?' seed':''}</h4>
      <p className="mt-2 text-sm">{selection?.seed?'Plant this seed in a supported prepared bed. Follow the bed’s prompt to care for it.':charmDescription(selected.face)}</p>
      <p className="mt-3 text-sm text-cream-muted">{selected.qty} {selection?.seed?'seeds':'items'} in your account</p>
      <p className="mt-2 text-xs text-cream-muted">Inspecting an item does not use it.</p>
     </>:<><h4 className="font-display text-base text-gold-300">A place for every find</h4><p className="mt-2 text-sm text-cream-muted">Choose a seed or charm to see its artwork and description.</p></>}
    </aside>
   </div>
  </>:<div><p className="mb-3 text-cream-muted">Set up your home to start collecting supplies and charms.</p><button type="button" className={button} onClick={onSetup}>Open Party setup</button></div>}
  <button type="button" className={`${button} mt-3`} disabled={busy} onClick={onRefresh}>{busy?'Refreshing…':'Refresh account'}</button>
 </section>;
}
