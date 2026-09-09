import {WebSocketServer} from 'ws';
// Local guest presence only. No PlankSpace authentication, inventory or settlement.
const server=new WebSocketServer({host:'127.0.0.1',port:3022,maxPayload:512,verifyClient:({origin})=>origin==='http://localhost:3021'});
const players=new Map();
server.on('connection',socket=>{
 const id=Array.from({length:16},(_,i)=>i).find(i=>![...players.values()].some(p=>p.id===i));
 if(id===undefined){socket.close(1013,'Playtest full');return;}
 const player={id,sequence:-1,scene:null,joined:false,window:Date.now(),count:0};players.set(socket,player);
 socket.on('message',data=>{
  const parts=data.toString().split('|');const numbers=parts.slice(1).map(Number);
  if(parts[0]!=='world'||numbers.length!==10||numbers.some(n=>!Number.isSafeInteger(n))){socket.close(1008,'Invalid message');return;}
  const [sequence,x,y,tile,cset,flip,dmap,screen,joined,aura]=numbers;
  if(sequence<=player.sequence||x<0||x>255||y<0||y>175||tile<0||tile>65535||cset<0||cset>15||flip<0||flip>3||dmap<0||dmap>511||screen<0||screen>135||![0,1].includes(joined)||![0,1].includes(aura)){socket.close(1008,'Invalid pose');return;}
  if(Date.now()-player.window>=1000){player.window=Date.now();player.count=0;}if(++player.count>30){socket.close(1008,'Rate limit');return;}
  Object.assign(player,{sequence,scene:`${dmap}:${screen}`,joined:Boolean(joined),pose:[x,y,tile,cset,flip,aura]});
  for(const [otherSocket,other] of players){if(otherSocket===socket||!other.joined||!player.joined||other.scene!==player.scene)continue;otherSocket.send('peer|'+[id,...player.pose,dmap,screen].join('|'));}
 });
 socket.on('close',()=>players.delete(socket));socket.on('error',()=>players.delete(socket));
});
console.log('Local guest homestead presence on ws://localhost:3022; no account/economy authority');
