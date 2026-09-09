/** Local presentation telemetry only. Never use these observations as economic authority. */
export type NativeContact={type:'charmville:action-contact';sessionId:string;eventId:string;sequence:number;action:'till'|'plant'|'water'|'harvest'|'fertilize';plotIndex:number;dmap:number;screen:number;x:number;y:number;direction:number;authority:'local-observation'};
export function readNativeContact(raw:unknown):NativeContact|null{
 if(!raw||typeof raw!=='object')return null;const p=raw as Record<string,unknown>;
 const keys=['type','sessionId','eventId','sequence','action','plotIndex','dmap','screen','x','y','direction','authority'];
 if(Object.keys(p).some(key=>!keys.includes(key))||p.type!=='charmville:action-contact'||p.authority!=='local-observation'||typeof p.sessionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.sessionId)||!Number.isSafeInteger(p.sequence)||(p.sequence as number)<1||p.eventId!==`${p.sessionId}:${p.sequence}`||!['till','plant','water','harvest','fertilize'].includes(String(p.action)))return null;
 for(const [key,max]of [['plotIndex',2],['dmap',65535],['screen',65535],['direction',3]] as const)if(!Number.isInteger(p[key])||(p[key] as number)<0||(p[key] as number)>max)return null;
 if(!['x','y'].every(key=>typeof p[key]==='number'&&Number.isFinite(p[key])&&Math.abs(p[key] as number)<=65535))return null;
 return p as NativeContact;
}
export function createNativeContactObserver(){
 const sequences=new Map<string,number>();
 return (raw:unknown)=>{const contact=readNativeContact(raw);if(!contact)return null;const prior=sequences.get(contact.sessionId)??0;if(contact.sequence<=prior)return null;
 if(!sequences.has(contact.sessionId)&&sequences.size>=16)sequences.delete(sequences.keys().next().value!);
 sequences.set(contact.sessionId,contact.sequence);return {contact,gap:contact.sequence!==prior+1};};
}
