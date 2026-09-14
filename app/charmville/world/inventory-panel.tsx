"use client";
import Image from 'next/image';
import {useId,useRef,useState,type KeyboardEvent} from 'react';
import type {YardInventory} from '@/lib/charmville/inventory';
import {charmName,charmDescription,itemArt} from '@/lib/charmville/item-display';
import styles from './inventory-panel.module.css';

type Pocket='charms'|'seeds';
const pockets=[{id:'charms' as const,label:'Charms'},{id:'seeds' as const,label:'Seeds'}];
export default function InventoryPanel({inventory,busy,onSetup,onRefresh}:{inventory:YardInventory|null;busy:boolean;onSetup:()=>void;onRefresh:()=>void}){
 const uid=useId();
 const [pocket,setPocket]=useState<Pocket>('charms');
 const [selection,setSelection]=useState<Record<Pocket,string|null>>({charms:null,seeds:null});
 const root=useRef<HTMLElement>(null);
 const rows=inventory?(pocket==='seeds'?inventory.seeds:inventory.faces):[];
 const selected=rows.find(stack=>stack.face===selection[pocket])??rows[0]??null;
 const artwork=selected?itemArt(selected.face):undefined;
 const focusRow=(index:number)=>root.current?.querySelectorAll<HTMLButtonElement>('[data-bag-row]')[index]?.focus();
 const focusPocket=()=>root.current?.querySelector<HTMLButtonElement>(`[data-pocket="${pocket}"]`)?.focus();
 const focusRefresh=()=>{const refresh=root.current?.querySelector<HTMLButtonElement>('[data-bag-refresh]');if(refresh&&!refresh.disabled)refresh.focus();else focusPocket();};
 const switchPocket=(next:Pocket,focusItems=false)=>{
  setPocket(next);
  requestAnimationFrame(()=>{
   const target=focusItems?root.current?.querySelector<HTMLButtonElement>('[data-bag-row][aria-pressed="true"]'):null;
   (target??root.current?.querySelector<HTMLButtonElement>(`[data-pocket="${next}"]`))?.focus();
  });
 };
 const rowKeys=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  const key=event.key;
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(key))return;
  event.preventDefault();event.stopPropagation();
  if(key==='ArrowLeft'||key==='ArrowRight'){switchPocket(pocket==='charms'?'seeds':'charms',true);return;}
  if(key==='ArrowUp'&&index===0){focusPocket();return;}
  if(key==='ArrowDown'&&index===rows.length-1){focusRefresh();return;}
  const next=key==='Home'?0:key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(key==='ArrowDown'?1:-1)));
  focusRow(next);
 };
 return <section ref={root} data-market-shell className={styles.shell} aria-label="Saved inventory">
  <header className={styles.header}>
   <span className={styles.title}><Image src="/charmville/items/satchel.svg" alt="" width={32} height={32} unoptimized/>Satchel</span>
   {inventory&&<span className={styles.money}><span>Grain</span><strong>{inventory.grain}</strong></span>}
  </header>
  {inventory?<>
   <div className={styles.pockets} role="tablist" aria-label="Satchel pockets">
    {pockets.map(({id,label})=><button key={id} type="button" id={`${uid}-${id}`} role="tab" data-pocket={id} aria-selected={pocket===id} aria-controls={`${uid}-contents`} tabIndex={pocket===id?0:-1} onClick={()=>setPocket(id)} onKeyDown={event=>{
     if(event.altKey||event.ctrlKey||event.metaKey)return;
     if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();switchPocket(event.key==='Home'?'charms':event.key==='End'?'seeds':pocket==='charms'?'seeds':'charms');}
     else if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();if(rows.length)focusRow(Math.max(0,rows.findIndex(row=>row.face===selected?.face)));else focusRefresh();}
    }}><span aria-hidden="true">{id==='charms'?'◆':'❧'}</span>{label}</button>)}
   </div>
   <div className={styles.body} id={`${uid}-contents`} role="tabpanel" aria-labelledby={`${uid}-${pocket}`}>
    <aside className={styles.display} aria-label="Item artwork">
     <div className={styles.artStage}>
      <Image src="/charmville/items/satchel.svg" alt="" width={128} height={128} unoptimized className={styles.bag}/>
      {artwork&&<Image key={artwork} src={artwork} alt={charmName(selected!.face)} width={80} height={80} unoptimized className={styles.itemArt}/>}
     </div>
     <span className={styles.pocketName}>{pocket==='seeds'?'Planting pocket':'Charm pocket'}</span>
    </aside>
    <div className={styles.listFrame}>
     <div className={styles.listLabel}><span>{pocket==='seeds'?'Seeds & supplies':'Charms & harvests'}</span><span>{rows.length} {rows.length===1?'kind':'kinds'}</span></div>
     {rows.length?<ul className={styles.list}>{rows.map((stack,index)=><li key={stack.face}>
      <button type="button" data-bag-row aria-pressed={selected?.face===stack.face} tabIndex={selected?.face===stack.face?0:-1} className={styles.row} onFocus={()=>setSelection(old=>({...old,[pocket]:stack.face}))} onClick={()=>setSelection(old=>({...old,[pocket]:stack.face}))} onKeyDown={event=>rowKeys(event,index)}>
       <span aria-hidden="true" className={styles.cursor}>▶</span><span className={styles.itemName}>{charmName(stack.face)}</span><span className={styles.quantity}>×{stack.qty}</span>
      </button>
     </li>)}</ul>:<p className={styles.empty}>{pocket==='seeds'?'No seeds in this pocket yet.':'No charms yet. Gather a ripe crop to begin.'}</p>}
    </div>
   </div>
   <div className={styles.description} aria-label="Item details">
    <div><h3>{selected?`${charmName(selected.face)}${pocket==='seeds'?' seed':''}`:'A place for every find'}</h3><p>{selected?(pocket==='seeds'?'Plant in a prepared bed, then follow its prompt to care for it.':charmDescription(selected.face)):'Choose a pocket, then an item to inspect it.'}</p></div>
    {selected&&<span className={styles.owned}>{selected.qty}<small>owned</small></span>}
   </div>
  </>:<div className={styles.setup}><p>Set up your home to start collecting supplies and charms.</p><button type="button" className={styles.button} onClick={onSetup}>Open Party setup</button></div>}
  <footer className={styles.footer}><p><span>↑↓</span> Choose <span>←→</span> Pocket · Inspecting uses nothing</p><button type="button" className={styles.button} data-bag-refresh disabled={busy} onKeyDown={event=>{if(event.key==='ArrowUp'&&!event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();if(rows.length)focusRow(rows.length-1);else focusPocket();}}} onClick={onRefresh}>{busy?'Refreshing…':'Refresh'}</button></footer>
 </section>;
}
