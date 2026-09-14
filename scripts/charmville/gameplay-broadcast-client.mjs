import {createGameplayPeer} from './gameplay-peer.mjs';

/** Loopback playtest signaling adapter. This owns peer connections, not capture
 * tracks. Closing it cannot force a hostile remote P2P receiver to stop media.
 * @param {{url:string,token:string,onTrack?:(id:string,track:MediaStreamTrack,streams:readonly MediaStream[])=>void,onEnded?:(id:string,reason:string)=>void,onError?:(reason:string)=>void,WebSocketImpl?:typeof WebSocket,peerFactory?:typeof createGameplayPeer,configuration?:RTCConfiguration,renewMs?:number,requestTimeoutMs?:number}} options
 */
export async function createGameplayBroadcastClient({url,token,onTrack=()=>{},onEnded=()=>{},onError=()=>{},WebSocketImpl=globalThis.WebSocket,peerFactory=createGameplayPeer,configuration={},renewMs=5000,requestTimeoutMs=8000}){
 const endpoint=new URL(url);
 if(!['ws:','wss:'].includes(endpoint.protocol)||!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/broadcast'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw Error('A loopback broadcast gateway is required');
 if(!/^[a-f0-9]{64}$/i.test(token)||typeof WebSocketImpl!=='function'||renewMs<100||renewMs>5000||requestTimeoutMs<100||requestTimeoutMs>10000)throw Error('Invalid local broadcast options');
 const socket=new WebSocketImpl(url),publications=new Map(),pending=new Map();
 let closed=false,nextId=1,connectionId='',profileId='',chain=Promise.resolve(),renewing=false,timer;
 let resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const readyTimeout=setTimeout(()=>shutdown('Authentication timeout'),requestTimeoutMs);
 const rejectAll=reason=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error(reason));}pending.clear();};
 function end(publicationId,reason){const entry=publications.get(publicationId);if(!entry)return;publications.delete(publicationId);for(const peer of entry.peers.values())peer.close(reason);entry.peers.clear();entry.queued.length=0;try{onEnded(publicationId,reason);}catch{/* UI callbacks cannot interrupt cleanup. */}}
 function shutdown(reason='closed'){
  if(closed)return;closed=true;token='';clearTimeout(readyTimeout);clearInterval(timer);rejectReady(Error(reason));rejectAll(reason);
  for(const id of [...publications.keys()])end(id,reason);
  socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;socket.close();
 }
 const report=reason=>{try{onError(reason);}catch{/* Observers do not control transport cleanup. */}};
 function request(command){
  const operation=chain.then(()=>new Promise((resolve,reject)=>{
   if(closed||!connectionId){reject(Error('Broadcast client is offline'));return;}
   const requestId=nextId++;
   const deadline=setTimeout(()=>{pending.delete(requestId);reject(Error('Signaling request timed out'));shutdown('Signaling request timed out');},requestTimeoutMs);
   pending.set(requestId,{resolve,reject,timer:deadline});
   try{socket.send(JSON.stringify({...command,requestId}));}catch{clearTimeout(deadline);pending.delete(requestId);reject(Error('Signaling unavailable'));shutdown('Signaling unavailable');}
  }));chain=operation.catch(()=>{});return operation;
 }
 function addPeer(entry,target){
  if(entry.peers.has(target))return entry.peers.get(target);
  if(entry.peers.size>=16)throw Error('Local peer preview capacity reached');
  const peer=peerFactory({role:entry.role,stream:entry.stream??null,configuration,
   send:signal=>{void request({type:'signal',publicationId:entry.id,target,signal}).catch(()=>{peer.close('Signaling rejected');report('Signaling rejected');});},
   onTrack:(track,streams)=>onTrack(entry.id,track,streams),
   onClose:()=>entry.peers.delete(target),
  });
  entry.peers.set(target,peer);return peer;
 }
 async function routeSignal(message){
  const entry=publications.get(message.publicationId);if(!entry)return;
  if(entry.role==='viewer'&&!entry.publisher){if(entry.queued.length>=64)throw Error('Too many early signals');entry.queued.push(message);return;}
  const peer=entry.peers.get(message.from);
  if(!peer)throw Error('Unknown media peer');
  await peer.receive(message.signal);
 }
 socket.onopen=()=>{if(closed)return;try{socket.send(JSON.stringify({type:'authenticate',token}));token='';}catch{shutdown('Authentication transport failed');}};
 socket.onerror=()=>shutdown('Signaling connection failed');
 socket.onclose=()=>shutdown('Signaling connection closed');
 socket.onmessage=event=>{
  if(closed)return;
  let message;try{if(typeof event.data!=='string'||event.data.length>65536)throw Error();message=JSON.parse(event.data);}catch{shutdown('Invalid gateway response');return;}
  if(message.type==='broadcast:ready'){
   if(connectionId||typeof message.connectionId!=='string'||typeof message.profileId!=='string'){shutdown('Invalid gateway identity');return;}
   connectionId=message.connectionId;profileId=message.profileId;clearTimeout(readyTimeout);resolveReady();return;
  }
  if(message.type==='broadcast:result'||message.type==='broadcast:error'){
   const entry=pending.get(message.requestId);if(!entry)return;pending.delete(message.requestId);clearTimeout(entry.timer);
   if(message.type==='broadcast:error')entry.reject(Error('Gateway rejected the request'));else entry.resolve(message.result);return;
  }
  if(message.type==='broadcast:ended'){end(message.publicationId,'Publication ended');return;}
  if(message.type==='broadcast:subscriber'){
   const entry=publications.get(message.publicationId);if(!entry||entry.role!=='publisher'||entry.peers.has(message.viewerConnectionId))return;
   try{const peer=addPeer(entry,message.viewerConnectionId);void peer.start().catch(()=>{peer.close('Offer failed');report('Offer failed');});}catch{report('Local peer preview capacity reached');}return;
  }
  if(message.type==='broadcast:signal')void routeSignal(message).catch(()=>report('Media negotiation failed'));
 };
 await ready;
 timer=setInterval(()=>{
  if(closed||renewing)return;renewing=true;
  void (async()=>{for(const entry of publications.values()){
   try{await request({type:entry.role==='publisher'?'renew':'subscribe',publicationId:entry.id});}catch{end(entry.id,'Publication authorization expired');}
  }})().finally(()=>{renewing=false;});
 },renewMs);
 return {
  get profileId(){return profileId;},
  async publish(stream){
   if([...publications.values()].some(entry=>entry.role==='publisher'))throw Error('Already publishing');
   // Validate tracks before granting a server publication.
   const tracks=stream?.getTracks()??[];
   if(tracks.filter(track=>track.kind==='video').length!==1||tracks.length>2||tracks.some(track=>!['video','audio'].includes(track.kind)||track.readyState!=='live'))throw Error('Choose one live gameplay video source');
   const result=await request({type:'start',ownerId:profileId});
   if(closed)throw Error('Broadcast client closed');
   publications.set(result.id,{id:result.id,role:'publisher',stream,peers:new Map(),queued:[]});return result.id;
  },
  async subscribe(publicationId){
   if(typeof publicationId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(publicationId)||publications.has(publicationId)||publications.size>=8)throw Error('Invalid or duplicate publication');
   const entry={id:publicationId,role:'viewer',publisher:'',peers:new Map(),queued:[]};publications.set(publicationId,entry);
   try{const result=await request({type:'subscribe',publicationId});if(closed||publications.get(publicationId)!==entry)throw Error('Subscription ended');entry.publisher=result.publisherConnectionId;addPeer(entry,entry.publisher);for(const message of entry.queued.splice(0))await routeSignal(message);return publicationId;}
   catch(error){end(publicationId,'Subscription rejected');throw error;}
  },
  close:()=>shutdown('closed'),
  get active(){return !closed;},
 };
}
