"use client";
import {useCallback} from 'react';
import Porch from '@/integrations/plankspace-app/app/charmville/porch';

export default function GardenPanel({handle,onChanged}:{handle:string;onChanged:()=>void}) {
 const sync=useCallback(()=>onChanged(),[onChanged]);
 return <section aria-label="Saved home garden" className="min-w-0">
  <h2 className="mb-2 font-display text-xl text-gold-300">Your saved garden</h2>
  <p className="mb-3 text-sm text-cream-muted">Plant and harvest here to update your account inventory. These home controls are separate from movement in the adventure camera.</p>
  <Porch handle={handle} posts={[]} onStamps={sync}/>
 </section>;
}
