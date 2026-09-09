import {WebSocketServer} from 'ws';
import {writeFile} from 'node:fs/promises';
// Local transport verification only. No inventory, account, persistence or rewards.
const server=new WebSocketServer({host:'127.0.0.1',port:3022,maxPayload:512,
 verifyClient:({origin})=>origin==='http://localhost:3021'});
const receipt={connections:0,messages:0,rejected:0,samples:[]};
server.on('connection',socket=>{
 receipt.connections++;let previous=-1;
 socket.on('message',bytes=>{
  const fields=bytes.toString().split('|');const values=fields.slice(1).map(Number);
  if(fields.length!==5||fields[0]!=='pose'||values.some(n=>!Number.isSafeInteger(n))||values[0]<=previous||values[1]<0||values[1]>4096||values[2]<0||values[2]>4096||values[3]<0||values[3]>100000){receipt.rejected++;socket.close(1008,'Invalid pose');return;}
  previous=values[0];receipt.messages++;
  if(receipt.samples.length<20)receipt.samples.push({sequence:values[0],x:values[1],y:values[2],hp:values[3]});
  socket.send('ack|'+previous);
 });
 socket.on('close',()=>writeFile('.charmville-bridge-receipt.json',JSON.stringify(receipt,null,2)).catch(console.error));
});
console.log('Local read-only pose probe: ws://localhost:3022');
