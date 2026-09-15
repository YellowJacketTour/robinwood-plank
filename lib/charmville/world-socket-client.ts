import type {SavedActor} from './native-movement-client';

export function createWorldSocket(token:string,onSnapshot:(state:SavedActor)=>void,onUnavailable:()=>void,onEncounter?:(state:unknown|null)=>void){
 let socket:WebSocket|null=null,ready=false,closed=false,serial=0,reconnect:ReturnType<typeof setTimeout>|undefined;
 const pending=new Map<number,{resolve:(state:SavedActor)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const rejectPending=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Movement connection interrupted. Checking saved position.'));}pending.clear();};
 // Failed optional socket probes must not invalidate a healthy HTTP projection.
 const loseReadyConnection=()=>{
  const wasReady=ready;ready=false;rejectPending();
  if(wasReady&&!closed){onUnavailable();onEncounter?.(null);}
 };
 const connect=()=>{
  if(closed)return;
  const current=new WebSocket('ws://127.0.0.1:3023');socket=current;
  current.onopen=()=>{if(!closed&&socket===current)current.send(JSON.stringify({type:'authenticate',token}));};
  current.onmessage=event=>{
   if(closed||socket!==current)return;
   let data;try{data=JSON.parse(event.data);}catch{return;}
   if(data.type==='ready'||data.type==='snapshot'){ready=true;onSnapshot(data.state);}
   if(data.type==='unavailable')loseReadyConnection();
   if(data.type==='encounter')onEncounter?.(data.state);
   if(data.type==='result'){
    const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);
    if(data.status===200)p.resolve(data.state);else p.reject(Error(data.error??'Movement rejected'));
   }
  };
  current.onclose=()=>{if(closed||socket!==current)return;socket=null;loseReadyConnection();reconnect=setTimeout(connect,2000);};
  current.onerror=()=>{if(!closed&&socket===current)current.close();};
 };
 connect();
 return {
  available:()=>ready&&socket?.readyState===WebSocket.OPEN,
  step:(body:object)=>new Promise<SavedActor>((resolve,reject)=>{
   if(!ready||socket?.readyState!==WebSocket.OPEN){reject(Error('Movement connection unavailable'));return;}
   const id=++serial;
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('Movement acknowledgment timed out'));socket?.close();},6000);
   pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({type:'step',id,body}));
  }),
  dispose(){closed=true;ready=false;clearTimeout(reconnect);rejectPending();socket?.close();},
 };
}
