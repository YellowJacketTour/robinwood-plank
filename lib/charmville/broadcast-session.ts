import {canSpectate,type SpectatorMode} from './spectator-policy';

export type BroadcastAuthority={profileId:string;ownerId:string;revision:string;mode:SpectatorMode;allowedIds:readonly string[]};
type Viewer={connectionId:string;profileId:string;expiresAt:number};
type Publication={id:string;ownerId:string;connectionId:string;revision:string;expiresAt:number;viewers:Map<string,Viewer>};
/** Server-only signaling lifecycle. This does not transport media or authenticate
 * tokens itself. resolve MUST obtain current identity/policy from the server,
 * never from message ownerId/viewerId claims. IDs identify sessions, not bearer
 * grants. Every signal is reauthorized; disconnect notifications must also stop
 * the actual relay/SFU subscription. Peer-to-peer media cannot be revoked here.
 */
export function createBroadcastSessions(options:{
 resolve:(connectionId:string,ownerId:string)=>Promise<BroadcastAuthority>;
 id:()=>string;now:()=>number;disconnect:(connectionId:string,publicationId:string)=>void;
 maxPublications?:number;maxViewers?:number;leaseMs?:number;
}){
 const maxPublications=options.maxPublications??32,maxViewers=options.maxViewers??64,lease=options.leaseMs??15000;
 if(!Number.isInteger(maxPublications)||maxPublications<1||maxPublications>1024||!Number.isInteger(maxViewers)||maxViewers<1||maxViewers>1024||!Number.isInteger(lease)||lease<1000||lease>60000)throw Error('Invalid broadcast limits');
 const publications=new Map<string,Publication>();
 const notify=(connection:string,id:string)=>{try{options.disconnect(connection,id);}catch{/* Cleanup cannot be interrupted by a disconnected transport. */}};
 const remove=(p:Publication)=>{publications.delete(p.id);notify(p.connectionId,p.id);for(const v of p.viewers.values())notify(v.connectionId,p.id);p.viewers.clear();};
 function sweep(){const now=options.now();for(const p of publications.values()){if(p.expiresAt<=now){remove(p);continue;}for(const [id,v] of p.viewers)if(v.expiresAt<=now){p.viewers.delete(id);notify(id,p.id);}}}
 async function authority(connectionId:string,ownerId:string){
  const a=await options.resolve(connectionId,ownerId);
  if(!connectionId||!a.profileId||a.ownerId!==ownerId||!/^\d{1,18}$/.test(a.revision))throw Error('Broadcast authentication required');
  return a;
 }
 const current=(id:string)=>{sweep();const p=publications.get(id);if(!p)throw Error('Broadcast offline');return p;};
 const check=(p:Publication,a:BroadcastAuthority)=>{
  if(p.revision!==a.revision){remove(p);throw Error('Broadcast policy changed');}
  if(!canSpectate({ownerId:p.ownerId,viewerId:a.profileId,mode:a.mode,allowedIds:a.allowedIds}))throw Error('Broadcast restricted');
 };
 return {
  sweep,
  async start(connectionId:string,ownerId:string){
   const a=await authority(connectionId,ownerId);sweep();
   if(a.profileId!==ownerId)throw Error('Only the owner can publish');
   if([...publications.values()].some(p=>p.ownerId===ownerId))throw Error('Already broadcasting');
   if(publications.size>=maxPublications)throw Error('Broadcast capacity reached');
   const id=options.id();if(!id||publications.has(id))throw Error('Invalid publication ID');
   const p:Publication={id,ownerId,connectionId,revision:a.revision,expiresAt:options.now()+lease,viewers:new Map()};
   publications.set(id,p);return {id,revision:p.revision,expiresAt:p.expiresAt};
  },
  async subscribe(connectionId:string,id:string){
   const before=current(id),a=await authority(connectionId,before.ownerId),p=current(id);check(p,a);
   if(connectionId===p.connectionId)throw Error('Publisher cannot subscribe to itself');
   if(!p.viewers.has(connectionId)&&p.viewers.size>=maxViewers)throw Error('Viewer capacity reached');
   const expiresAt=Math.min(p.expiresAt,options.now()+lease);
   p.viewers.set(connectionId,{connectionId,profileId:a.profileId,expiresAt});return {id,revision:p.revision,expiresAt,publisherConnectionId:p.connectionId,viewerConnectionId:connectionId};
  },
  async authorizeSignal(connectionId:string,id:string,targetConnectionId:string){
   const before=current(id),a=await authority(connectionId,before.ownerId),p=current(id);check(p,a);
   if(connectionId===p.connectionId&&a.profileId===p.ownerId){
    const target=p.viewers.get(targetConnectionId);if(!target)throw Error('Unknown subscriber');
    const targetAuthority=await authority(targetConnectionId,p.ownerId);
    const live=current(id);check(live,targetAuthority);
    if(live!==p||live.viewers.get(targetConnectionId)!==target||target.profileId!==targetAuthority.profileId)throw Error('Subscriber changed');
    return {from:connectionId,to:targetConnectionId};
   }
   const viewer=p.viewers.get(connectionId);
   if(!viewer||viewer.profileId!==a.profileId||targetConnectionId!==p.connectionId)throw Error('Unknown subscriber');
   return {from:connectionId,to:p.connectionId};
  },
  async renew(connectionId:string,id:string){
   const before=current(id),a=await authority(connectionId,before.ownerId),p=current(id);check(p,a);
   if(connectionId!==p.connectionId||a.profileId!==p.ownerId)throw Error('Only the publisher can renew');
   p.expiresAt=options.now()+lease;return p.expiresAt;
  },
  /** Call after the policy transaction commits, including for idle viewers. */
  revokeOwner(ownerId:string){for(const p of publications.values())if(p.ownerId===ownerId)remove(p);},
  close(connectionId:string){for(const p of publications.values()){if(p.connectionId===connectionId)remove(p);else if(p.viewers.delete(connectionId))notify(connectionId,p.id);}},
 };
}
