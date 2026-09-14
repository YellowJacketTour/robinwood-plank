"use client";
import {useState} from 'react';
import {nearbyVisitTargets,travelLabel,visitHandle,type TravelPresence} from '@/lib/charmville/friend-travel';
const button='min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50';
export default function FriendsTravelPanel({handle,profileId,presence,busy,onTravel,onPlay}:{
 handle:string;profileId:string;presence:TravelPresence|null;busy:boolean;
 onTravel:(destination:{destination:'home';handle:string}|{destination:'public'})=>void;onPlay:()=>void;
}){
 const [visitor,setVisitor]=useState('');
 const [error,setError]=useState('');
 const nearby=nearbyVisitTargets(presence,profileId);
 const visiting=!!presence?.active&&!!presence.ownerHandle&&presence.ownerHandle!==handle;
 function visit(value:string){const target=visitHandle(value);if(!target){setError('Use a player handle: up to 40 letters, numbers or underscores.');return;}setError('');onTravel({destination:'home',handle:target});}
 return <section className="rounded-xl border border-line bg-panel p-4" aria-label="Co-op travel">
  <h2 className="font-display text-xl">Meet in the world</h2>
  <p className="mt-2 text-sm text-cream-muted">Visit homes and meet nearby players here. Posts and charm reactions are in Social.</p><p className="mt-2 text-cream-muted" role="status">{busy?'Checking your destination…':travelLabel(presence,handle)}</p>
  <div className="my-3 flex flex-wrap gap-2">
   {presence?.active&&<button type="button" className={button} disabled={busy} onClick={onPlay}>{visiting?'Explore this home':'Continue playing'}</button>}
   <button type="button" className={button} disabled={busy} onClick={()=>onTravel({destination:'home',handle})}>{visiting?'Return to my home':'Go home'}</button>
   <button type="button" className={button} disabled={busy} onClick={()=>onTravel({destination:'public'})}>Public meadow</button>
  </div>
  <form onSubmit={event=>{event.preventDefault();visit(visitor);}}>
   <label className="block text-sm" htmlFor="visit-handle">Visit a friend</label>
   <input id="visit-handle" value={visitor} maxLength={41} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} onChange={event=>{setVisitor(event.target.value);setError('');}} className="my-2 min-h-11 w-full rounded-lg border border-line bg-panel-soft px-3" placeholder="@friend" aria-describedby="visit-permissions"/>
   <button className={button} disabled={busy||!visitor.trim()}>Visit home</button>
  </form>
  {error&&<p role="alert">{error}</p>}
  <p id="visit-permissions" className="mt-3 text-sm text-cream-muted">Your friend must invite you first. Visiting permits exploring; tending needs a separate invitation. Harvesting, building and storage are not included.</p>
  <h3 className="mt-4 font-bold">Players here</h3>
  <p className="my-2 text-sm text-cream-muted">{presence?.active?'Nearby account presence refreshes every 30 seconds. A player appearing here is not an invitation to their home.':'Join a location to meet other signed-in players.'}</p>
  {presence?.active&&nearby.length===0&&<p className="my-2 text-sm text-cream-muted">No other players are here yet. Share your handle with a friend and save their invitation in My invitations.</p>}<ul className="space-y-2">{nearby.map(peer=><li key={peer.profileId} className="flex flex-wrap items-center justify-between gap-2"><span>@{peer.handle}</span><button type="button" className={button} disabled={busy} onClick={()=>{setVisitor(peer.handle);visit(peer.handle);}} aria-label={`Visit ${peer.handle}’s home`}>Visit home</button></li>)}</ul>
 </section>;
}
