import {createBroadcastSessions} from './broadcast-session';
type Options=Parameters<typeof createBroadcastSessions>[0];
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
const id=(v:unknown):v is string=>text(v,128)&&/^[a-zA-Z0-9_-]+$/.test(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
/** Strictly project signaling data; no arbitrary nested payload or claimed sender. */
export function readBroadcastSignal(raw:unknown){
 if(!record(raw))return null;
 // GameplayPeer emits RTCSessionDescriptionInit / RTCIceCandidateInit wrappers.
 // Normalize legacy flat messages to the same browser-compatible envelope.
 if(keys(raw,['description'])&&record(raw.description)){
  const d=raw.description;
  if((d.type==='offer'||d.type==='answer')&&keys(d,['type','sdp'])&&text(d.sdp,32768)&&d.sdp.startsWith('v=0'))return {description:{type:d.type,sdp:d.sdp}};
  return null;
 }
 if(keys(raw,['candidate'])&&record(raw.candidate)){
  const c=raw.candidate;
  if(keys(c,['candidate','sdpMid','sdpMLineIndex','usernameFragment'])&&text(c.candidate,2048)&&(c.candidate===''||c.candidate.startsWith('candidate:'))&&
   (c.sdpMid==null||text(c.sdpMid,64))&&(c.sdpMLineIndex==null||(Number.isInteger(c.sdpMLineIndex)&&Number(c.sdpMLineIndex)>=0&&Number(c.sdpMLineIndex)<=255))&&
   (c.usernameFragment==null||text(c.usernameFragment,256)))return {candidate:{candidate:c.candidate,sdpMid:c.sdpMid??null,sdpMLineIndex:c.sdpMLineIndex??null,...(typeof c.usernameFragment==='string'?{usernameFragment:c.usernameFragment}:{})}};
  return null;
 }
 if((raw.type==='offer'||raw.type==='answer')&&keys(raw,['type','sdp'])&&text(raw.sdp,32768)&&raw.sdp.startsWith('v=0'))return {description:{type:raw.type,sdp:raw.sdp}};
 if(raw.type==='candidate'&&keys(raw,['type','candidate','sdpMid','sdpMLineIndex'])&&text(raw.candidate,2048)&&
  (raw.candidate===''||raw.candidate.startsWith('candidate:'))&&(raw.sdpMid===null||text(raw.sdpMid,64))&&
  (raw.sdpMLineIndex===null||(Number.isInteger(raw.sdpMLineIndex)&&Number(raw.sdpMLineIndex)>=0&&Number(raw.sdpMLineIndex)<=255)))
  return {candidate:{candidate:raw.candidate,sdpMid:raw.sdpMid,sdpMLineIndex:raw.sdpMLineIndex}};
 return null;
}
/** One adapter instance per gateway, one handle per server-assigned connection.
 * Transport must enforce byte limits before JSON parsing and backpressure on
 * send. No deployment endpoint or media relay is provided by this adapter.
 */
export function createBroadcastProtocol(options:Options&{send:(connectionId:string,message:object)=>void}){
 const sessions=createBroadcastSessions(options);
 return {revokeOwner:sessions.revokeOwner,sweep:sessions.sweep,
  connect(connectionId:string){
   if(!id(connectionId))throw Error('Invalid server connection ID');
   let busy=false,closed=false;
   const reply=(message:object)=>{if(!closed)options.send(connectionId,message);};
   return {
    close(){closed=true;sessions.close(connectionId);},
    async receive(raw:unknown){
     if(closed)return;
     if(busy){reply({type:'broadcast:error',code:'busy'});return;}
     if(!record(raw)||!Number.isSafeInteger(raw.requestId)||Number(raw.requestId)<1){reply({type:'broadcast:error',code:'invalid'});return;}
     const requestId=raw.requestId;busy=true;
     try{
      let result:unknown;
      if(raw.type==='start'&&keys(raw,['type','requestId','ownerId'])&&id(raw.ownerId))result=await sessions.start(connectionId,raw.ownerId);
      else if(raw.type==='subscribe'&&keys(raw,['type','requestId','publicationId'])&&id(raw.publicationId)){
       const subscription=await sessions.subscribe(connectionId,raw.publicationId);result=subscription;
       if(!closed)options.send(subscription.publisherConnectionId,{type:'broadcast:subscriber',publicationId:subscription.id,viewerConnectionId:subscription.viewerConnectionId,revision:subscription.revision});
      }
      else if(raw.type==='renew'&&keys(raw,['type','requestId','publicationId'])&&id(raw.publicationId))result={expiresAt:await sessions.renew(connectionId,raw.publicationId)};
      else if(raw.type==='signal'&&keys(raw,['type','requestId','publicationId','target','signal'])&&id(raw.publicationId)&&id(raw.target)){
       const signal=readBroadcastSignal(raw.signal);if(!signal)throw Error('Invalid signal');
       const route=await sessions.authorizeSignal(connectionId,raw.publicationId,raw.target);
       if(!closed)options.send(route.to,{type:'broadcast:signal',publicationId:raw.publicationId,from:route.from,signal});
       result={delivered:!closed};
      }else if(raw.type==='close'&&keys(raw,['type','requestId'])){sessions.close(connectionId);result={closed:true};}
      else throw Error('Invalid command');
      reply({type:'broadcast:result',requestId,result});
     }catch{reply({type:'broadcast:error',requestId,code:'rejected'});}
     finally{busy=false;if(closed)sessions.close(connectionId);}
    },
   };
  },
 };
}
