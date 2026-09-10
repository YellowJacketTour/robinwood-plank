import type {SavedActor} from './native-movement-client';

export function createWorldSocket(token:string,onSnapshot:(state:SavedActor)=>void,onUnavailable:()=>void){
 let socket:WebSocket|null=null,ready=false,closed=false,serial=0,reconnect:ReturnType<typeof setTimeout>|undefined;
 const pending=new Map<number,{resolve:(state:SavedActor)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const rejectPending=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Movement connection interrupted. Checking saved position.'));}pending.clear();};
 const connect=()=>{
  if(closed)return;
  socket=new WebSocket('ws://127.0.0.1:3023');
  socket.onopen=()=>socket?.send(JSON.stringify({type:'authenticate',token}));
  socket.onmessage=event=>{
   let data;try{data=JSON.parse(event.data);}catch{return;}
   if(data.type==='ready'||data.type==='snapshot'){ready=true;onSnapshot(data.state);}
   if(data.type==='unavailable'){ready=false;onUnavailable();}
   if(data.type==='result'){
    const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);
    if(data.status===200)p.resolve(data.state);else p.reject(Error(data.error??'Movement rejected'));
   }
  };
  socket.onclose=()=>{ready=false;rejectPending();onUnavailable();if(!closed)reconnect=setTimeout(connect,2000);};
  socket.onerror=()=>socket?.close();
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
