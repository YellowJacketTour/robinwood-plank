import {captureGameplay} from './gameplay-capture.mjs';
import {createGameplayBroadcastClient} from './gameplay-broadcast-client.mjs';

const colors=['rgb(220,50,50)','rgb(40,170,80)','rgb(40,90,230)','rgb(220,180,40)'];
const videos=new Map(),ended=[];
let client,capture,paint,source;
window.mediaHarness={
 async initialize({token,url,index}){
  document.body.style.cssText='margin:16px;background:#102f3a;color:#f2f7e6;font:16px sans-serif';
  const title=document.createElement('h1');title.textContent=`Synthetic media source ${index+1}`;document.body.append(title);
  const caption=document.createElement('p');caption.textContent='Local transport acceptance — this is not a rendered game world.';document.body.append(caption);
  source=document.createElement('canvas');source.width=256;source.height=176;document.body.append(source);
  const context=source.getContext('2d');let tick=0;
  function draw(){context.fillStyle=colors[index];context.fillRect(0,0,256,176);context.fillStyle='#ffffff';context.font='bold 18px sans-serif';context.fillText(`PROFILE ${index+1}`,48,40);context.fillText(`FRAME ${tick++}`,48,72);context.fillRect(32+(tick%180),112,12,12);}
  draw();paint=setInterval(draw,1000/15);capture=captureGameplay(source,{frameRate:15});
  client=await createGameplayBroadcastClient({url,token,
   onEnded:id=>{ended.push(id);const entry=videos.get(id);if(entry){entry.stopped=true;entry.video.pause();entry.video.srcObject=null;}},
   onTrack:(id,track)=>{
    const frame=document.createElement('section');frame.style.cssText='display:inline-block;margin:12px;vertical-align:top';
    const label=document.createElement('p');label.textContent='Received remote source';frame.append(label);
    const video=document.createElement('video');video.width=256;video.height=176;video.autoplay=true;video.muted=true;video.playsInline=true;video.srcObject=new MediaStream([track]);frame.append(video);document.body.append(frame);
    const entry={video,presented:0,stopped:false};videos.set(id,entry);
    const count=(_now,meta)=>{if(entry.stopped)return;entry.presented=meta.presentedFrames;video.requestVideoFrameCallback(count);};
    video.requestVideoFrameCallback(count);void video.play();
   },
  });
  return client.publish(capture.stream);
 },
 async subscribe(ids){for(const id of ids)await client.subscribe(id);},
 stats(){return [...videos].map(([id,entry])=>{
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=176;
  const ctx=canvas.getContext('2d');let rgb=null;
  if(entry.video.readyState>=2){ctx.drawImage(entry.video,0,0,256,176);rgb=[...ctx.getImageData(4,4,1,1).data].slice(0,3);}
  return {id,presented:entry.presented,decoded:entry.video.webkitDecodedFrameCount??null,rgb,stopped:entry.stopped};
 });},
 ended(){return [...ended];},
 stop(){clearInterval(paint);client?.close();capture?.stop();for(const entry of videos.values()){entry.stopped=true;for(const track of entry.video.srcObject?.getTracks()??[])track.stop();entry.video.srcObject=null;}},
};
