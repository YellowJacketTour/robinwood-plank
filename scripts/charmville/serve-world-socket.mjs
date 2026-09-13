import {WebSocketServer} from 'ws';

// Local transport gateway. Existing authenticated HTTP transactions remain authority.
const upstream='http://localhost:3017';
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
const server=new WebSocketServer({host:'127.0.0.1',port:3023,maxPayload:4096,perMessageDeflate:false,verifyClient:({origin},done)=>done(origins.has(origin))});
server.on('connection',socket=>{
 if(server.clients.size>32){socket.close(1013,'Local capacity reached');return;}
 let token='',authenticated=false,reading=false,writing=false,closed=false;
 const abort=new AbortController();
 const send=value=>{if(socket.readyState===1){if(socket.bufferedAmount>65536){socket.close(1013,'Slow consumer');return;}socket.send(JSON.stringify(value));}};
 const request=async(body,path='actor')=>{
  const response=await fetch(upstream+'/api/charmville/world/'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,origin:upstream,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),redirect:'error'});
  const data=await response.json();
  if(!response.ok)throw Object.assign(Error('World request rejected'),{status:response.status,data});
  return data;
 };
 const deadline=setTimeout(()=>socket.close(1008,'Authentication required'),5000);
 socket.on('message',async bytes=>{
  let message;try{message=JSON.parse(bytes.toString());}catch{socket.close(1008,'Invalid message');return;}
  if(!message||typeof message!=='object'||Array.isArray(message)){socket.close(1008,'Invalid message');return;}
  if(!authenticated){
   if(reading||message.type!=='authenticate'||typeof message.token!=='string'||message.token.length>512){socket.close(1008,'Authentication required');return;}
   reading=true;token=message.token;
   try{const state=await request();if(closed)return;authenticated=true;clearTimeout(deadline);send({type:'ready',state});}catch{socket.close(1008,'World admission required');}finally{reading=false;}
   return;
  }
  if(message.type!=='step'||!Number.isSafeInteger(message.id)||message.id<1||!message.body||typeof message.body!=='object'){socket.close(1008,'Invalid command');return;}
  if(writing){send({type:'result',id:message.id,status:429,error:'Movement request already pending'});return;}
  writing=true;
  try{const state=await request(message.body);send({type:'result',id:message.id,status:200,state});}
  catch(error){send({type:'result',id:message.id,status:error.status??503,error:error.data?.error??'Movement interrupted'});if([401,403].includes(error.status))socket.close(1008,'Admission expired');}
  finally{writing=false;}
 });
 const tick=setInterval(async()=>{
  if(!authenticated||reading||writing||closed)return;
  reading=true;
  try{send({type:'snapshot',state:await request()});}catch{send({type:'unavailable'});socket.close(1011,'World state unavailable');}finally{reading=false;}
 },100);
 let encounterReading=false;
 const encounterTick=setInterval(async()=>{
  if(!authenticated||encounterReading||closed)return;
  encounterReading=true;
  try{send({type:'encounter',state:await request(undefined,'encounter')});}
  catch{send({type:'encounter',state:null});}
  finally{encounterReading=false;}
 },200);
 socket.on('close',()=>{closed=true;token='';abort.abort();clearInterval(tick);clearInterval(encounterTick);clearTimeout(deadline);});
 socket.on('error',()=>socket.close());
});
console.log('Authenticated local world socket listening on ws://127.0.0.1:3023 (10 Hz target, 32 connections).');
