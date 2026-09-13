import {nativeCaptureProjection} from '@/lib/charmville/native-encounter-projection';
/** View-scoped receipt deduplication. Snapshots establish history before playing live events. */
export function createCaptureStream(){
 let context:string|null=null,highest=0n;const seen=new Set<string>();
 const remember=(id:string)=>{seen.add(id);if(seen.size>256)seen.delete(seen.values().next().value!);};
 return {
  reset(){context=null;highest=0n;seen.clear();},
  receipt(raw:unknown){const event=nativeCaptureProjection(raw);if(!event||seen.has(event.eventId))return null;remember(event.eventId);return event;},
  snapshot(raw:unknown){
   const s=raw as {inRange?:boolean;profileId?:unknown;encounter?:{id?:unknown};captureEvents?:unknown[]}|null;
   if(!s||s.inRange===false||typeof s.profileId!=='string'||typeof s.encounter?.id!=='string'){context=null;highest=0n;seen.clear();return [];}
   const key=s.profileId+':'+s.encounter.id;
   const events=(Array.isArray(s.captureEvents)?s.captureEvents:[]).map(raw=>{const event=nativeCaptureProjection(raw),sequence=(raw as {sequence?:unknown})?.sequence;return event&&typeof sequence==='string'&&/^\d{1,18}$/.test(sequence)?{event,sequence:BigInt(sequence)}:null;}).filter((entry):entry is NonNullable<typeof entry>=>entry!==null).sort((a,b)=>a.sequence<b.sequence?-1:1);
   if(context!==key){context=key;highest=events.at(-1)?.sequence??0n;for(const entry of events)remember(entry.event.eventId);return [];}
   const fresh=[];for(const entry of events){if(entry.sequence<=highest)continue;highest=entry.sequence;if(seen.has(entry.event.eventId))continue;remember(entry.event.eventId);fresh.push(entry.event);}return fresh;
  }
 };
}
