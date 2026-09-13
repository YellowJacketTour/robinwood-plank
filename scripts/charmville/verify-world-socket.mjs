import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base='http://localhost:3017',sockets=[];
async function account(){
 const r=await fetch(base+'/api/charmville/local-playtest',{method:'POST',headers:{Origin:base}});assert.equal(r.status,200);const user=await r.json();
 const headers={Origin:base,authorization:`Bearer ${user.token}`,'Content-Type':'application/json'};
 const p=await(await fetch(base+'/api/charmville/world/presence',{headers})).json();
 assert.equal((await fetch(base+'/api/charmville/world/presence',{method:'POST',headers,body:JSON.stringify({destination:'public',revision:p.revision})})).status,200);
 return {headers,token:user.token};
}
function connect(token){
 const socket=new WebSocket('ws://127.0.0.1:3023',{origin:base});sockets.push(socket);const messages=[];
 socket.on('message',b=>messages.push(JSON.parse(b.toString())));
 socket.on('open',()=>socket.send(JSON.stringify({type:'authenticate',token})));
 const until=async predicate=>{const end=Date.now()+8000;while(Date.now()<end){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,25));}throw Error('Socket evidence timed out');};
 return {socket,messages,until};
}
try{
 // Valid JSON primitives must reject only that connection, never crash the gateway.
 for(const payload of ['null','[]','42','"hello"'])await new Promise((resolve,reject)=>{
  const malformed=new WebSocket('ws://127.0.0.1:3023',{origin:base});sockets.push(malformed);
  const timer=setTimeout(()=>{malformed.terminate();reject(Error('Malformed message remained open'));},7000);
  malformed.on('open',()=>malformed.send(payload));
  malformed.on('error',reject);
  malformed.on('close',code=>{clearTimeout(timer);try{assert.equal(code,1008);resolve();}catch(e){reject(e);}});
 });
 const a=await account(),b=await account();const first=connect(a.token),second=connect(b.token);
 const initial=(await first.until(m=>m.type==='ready')).state;
 await second.until(m=>m.type==='ready');
 const creatureA=(await first.until(m=>m.type==='encounter'&&m.state?.encounter)).state;
 const creatureB=(await second.until(m=>m.type==='encounter'&&m.state?.encounter)).state;
 assert.equal(creatureA.encounter.id,creatureB.encounter.id);
 assert.equal(creatureA.encounter.hp,creatureB.encounter.hp);
 await first.until(m=>m.type==='snapshot'&&m.state.peers?.length>0);
 first.socket.send(JSON.stringify({type:'step',id:1,body:{x:initial.cell.x+1,y:initial.cell.y,sequence:initial.sequence+1,regionEpoch:initial.regionEpoch,presenceRevision:initial.presenceRevision,geometryId:initial.geometryId}}));
 const moved=await first.until(m=>m.type==='result'&&m.id===1);assert.equal(moved.status,200);
 await second.until(m=>m.type==='snapshot'&&m.state.peers?.some(p=>p.profileId===initial.profileId&&p.cell.x===moved.state.cell.x));
 const saved=await(await fetch(base+'/api/charmville/world/actor',{headers:a.headers})).json();assert.equal(saved.sequence,moved.state.sequence);
 const invalid=connect('invalid');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Invalid token remained open')),7000);invalid.socket.on('close',code=>{clearTimeout(timer);try{assert.equal(code,1008);resolve();}catch(e){reject(e);}});});
 assert(!invalid.messages.some(m=>m.state));
 await new Promise((resolve,reject)=>{
  const foreign=new WebSocket('ws://127.0.0.1:3023',{origin:'https://example.com'});sockets.push(foreign);
  foreign.on('open',()=>reject(Error('Foreign origin accepted')));
  foreign.on('unexpected-response',(_request,response)=>{try{assert.equal(response.statusCode,401);response.resume();foreign.terminate();resolve();}catch(e){reject(e);}});
  foreign.on('error',()=>{});
 });
 console.log('Two authenticated sockets: shared creature identity/HP, persisted movement and peer delivery; invalid session receives no state.');
}finally{for(const socket of sockets)socket.close();}
