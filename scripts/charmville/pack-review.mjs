#!/usr/bin/env node
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPackFiles,sha256} from './pack-validate.mjs';

const directions=['up','down','left','right'];
export const escapeMarkup=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function frameAt(frames,timeMs){
 const total=frames.reduce((sum,f)=>sum+f.durationMs,0);
 const local=((timeMs%total)+total)%total;
 let start=0;
 for(let index=0;index<frames.length;index++){const end=start+frames[index].durationMs;if(local<end)return {index,start,end,local,total};start=end;}
 throw Error('Empty animation');
}

export async function buildPackReview(manifestPath,assetRoot,outputDirectory){
 const bytes=await readFile(manifestPath);
 if(bytes.length>4*1024*1024)throw Error('Review manifest exceeds 4 MiB');
 const pack=JSON.parse(bytes);
 const errors=await verifyPackFiles(pack,assetRoot);
 if(errors.length)throw Error(errors.join('\n'));
 const frameCount=pack.actions.reduce((n,a)=>n+directions.reduce((s,d)=>s+a.directions[d].length,0),0);
 if(frameCount>2048)throw Error('Split packs above 2048 review frames');
 const assets={};let embeddedBytes=0;const realRoot=await realpath(assetRoot);
 for(const asset of pack.assets){const file=await realpath(path.resolve(realRoot,asset.path)),relative=path.relative(realRoot,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Asset escapes pack root');const data=await readFile(file);if(sha256(data)!==asset.sha256)throw Error('Asset changed after verification');embeddedBytes+=data.length;if(embeddedBytes>32*1024*1024)throw Error('Review image payload exceeds 32 MiB');assets[asset.id]='data:image/png;base64,'+data.toString('base64');}
 const allFrames=pack.actions.flatMap(a=>directions.flatMap(d=>a.directions[d]));
 if(allFrames.some(f=>f.region.width>512||f.region.height>512))throw Error('Review frame exceeds 512px; split oversized art before inspection');
 if(pack.assets.some(a=>a.width*a.height>16777216))throw Error('Review atlas exceeds 16 megapixels');
 if(allFrames.reduce((n,f)=>n+assets[f.asset].length,0)>64*1024*1024)throw Error('Contact sheet exceeds 64 MiB; split the review pack');
 const extent=Math.max(40,...allFrames.flatMap(f=>[f.origin.x,f.origin.y,f.region.width-f.origin.x,f.region.height-f.origin.y]));
 const digest=sha256(bytes);
 const payload=JSON.stringify({pack,assets,digest,extent}).replace(/</g,'\\u003c');
 const document=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeMarkup(pack.id)} — animation review</title>
<style>body{margin:0;background:#102f3a;color:#f2f7e6;font:16px system-ui}header,main{padding:20px;max-width:1200px;margin:auto}h1{font-size:24px}code{overflow-wrap:anywhere}label{display:inline-flex;gap:8px;align-items:center;margin:6px}button,select,input{font:inherit}button,select{min-height:44px}#players{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}figure{margin:0}canvas{width:100%;height:auto;image-rendering:pixelated;border:1px solid #75b7b3;background:repeating-conic-gradient(#174955 0% 25%,#205966 0% 50%) 0/20px 20px}figcaption{font-size:13px;min-height:3em}#time{width:min(600px,80vw)}.note{max-width:80ch;line-height:1.5}@media(max-width:600px){#players{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>
<header><h1>${escapeMarkup(pack.id)} — artwork review</h1><p>Manifest <code>${digest}</code></p><p class="note">Verified local source bytes. Playback is presentation only: no gameplay, inventory, publishing or network authority. Origin stays at the crosshair; blue marks grip, green marks collision. The companion contact sheet exposes every frame. Rights and visual acceptance remain separate checks.</p></header>
<main><label>Action <select id="action"></select></label><button id="play">Play</button><button id="step">Next frame</button><label>Pixel scale <select id="scale"><option>1</option><option>2</option><option selected>3</option><option>4</option></select></label><label><input type="checkbox" id="overlays" checked>Anchors and collision</label><p><input type="range" id="time" min="0" value="0" step="1" aria-label="Timeline milliseconds"><output id="clock"></output></p><div id="players"></div><p id="meaning" class="note"></p><p><a href="contact-sheet.svg" style="color:#f8d66d">Open all-frame contact sheet</a> · <a href="review.json" style="color:#f8d66d">Source and timing report</a></p></main>
<script>const data=${payload};const dirs=['up','down','left','right'];const images={};const players=document.querySelector('#players'),action=document.querySelector('#action'),slider=document.querySelector('#time'),scale=document.querySelector('#scale'),overlays=document.querySelector('#overlays');let playing=false,last=0,elapsed=0;
data.pack.actions.forEach((a,i)=>{const o=document.createElement('option');o.value=i;o.textContent=a.id;action.append(o)});
for(const direction of dirs){const f=document.createElement('figure'),c=document.createElement('canvas'),caption=document.createElement('figcaption');c.width=384;c.height=288;c.dataset.direction=direction;f.append(c,caption);players.append(f)}
const canvases=[...players.querySelectorAll('canvas')];
function current(){return data.pack.actions[Number(action.value)||0]}function duration(frames){return frames.reduce((n,f)=>n+f.durationMs,0)}
function at(frames,time){let t=time%duration(frames),start=0;for(let i=0;i<frames.length;i++){if(t<start+frames[i].durationMs)return {frame:frames[i],index:i,local:t};start+=frames[i].durationMs}}
function render(){const a=current(),max=Math.max(...dirs.map(d=>duration(a.directions[d])));slider.max=max-1;slider.value=Math.floor(elapsed%max);document.querySelector('#clock').textContent=Math.floor(elapsed%max)+' ms';document.querySelector('#meaning').textContent=a.meaning+' · contact '+a.contactMs+' ms · recovery '+a.recoveryMs+' ms · '+a.interruptPolicy;
for(const c of canvases){const d=c.dataset.direction,{frame:f,index,local}=at(a.directions[d],elapsed),s=Number(scale.value),ctx=c.getContext('2d');c.width=c.height=Math.max(192,data.extent*2*s+24);ctx.clearRect(0,0,c.width,c.height);ctx.imageSmoothingEnabled=false;ctx.save();ctx.translate(c.width/2,c.height/2);ctx.scale(s*(f.flipX?-1:1),s*(f.flipY?-1:1));const r=f.region;ctx.drawImage(images[f.asset],r.x,r.y,r.width,r.height,-f.origin.x,-f.origin.y,r.width,r.height);if(overlays.checked){ctx.lineWidth=1/s;ctx.strokeStyle='#80ed99';ctx.strokeRect(f.collision.x-f.origin.x,f.collision.y-f.origin.y,f.collision.width,f.collision.height);ctx.fillStyle='#69d6ff';ctx.fillRect(f.grip.x-f.origin.x-1,f.grip.y-f.origin.y-1,2,2)}ctx.restore();if(overlays.checked){ctx.strokeStyle='#f8d66d';ctx.beginPath();ctx.moveTo(c.width/2-6,c.height/2);ctx.lineTo(c.width/2+6,c.height/2);ctx.moveTo(c.width/2,c.height/2-6);ctx.lineTo(c.width/2,c.height/2+6);ctx.stroke()}c.nextElementSibling.textContent=d+' · frame '+(index+1)+'/'+a.directions[d].length+' · '+f.durationMs+' ms · '+(local<a.contactMs?'anticipation':local<a.contactMs+a.recoveryMs?'contact / recovery':'settled');}}
function tick(t){if(playing){elapsed+=last?t-last:0;render()}last=t;requestAnimationFrame(tick)}
document.querySelector('#play').onclick=()=>{playing=!playing;last=0;document.querySelector('#play').textContent=playing?'Pause':'Play'};document.querySelector('#step').onclick=()=>{playing=false;document.querySelector('#play').textContent='Play';let next=Infinity;for(const frames of Object.values(current().directions)){let start=0,local=elapsed%duration(frames);for(const f of frames){start+=f.durationMs;if(start>local){next=Math.min(next,start-local);break}}}elapsed+=next;render()};slider.oninput=()=>{playing=false;document.querySelector('#play').textContent='Play';elapsed=Number(slider.value);render()};action.onchange=()=>{elapsed=0;render()};scale.onchange=render;overlays.onchange=render;
Promise.all(Object.entries(data.assets).map(([id,url])=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{images[id]=image;resolve()};image.onerror=reject;image.src=url}))).then(()=>{render();requestAnimationFrame(tick)}).catch(()=>{document.querySelector('#meaning').textContent='PNG decode failed. Review rejected.'});</script></html>`;
 const rows=[];let y=48;
 for(const a of pack.actions){rows.push(`<text x="12" y="${y}" fill="#f2f7e6">${escapeMarkup(a.id)} — contact ${a.contactMs} ms, recovery ${a.recoveryMs} ms</text>`);y+=20;for(const direction of directions){for(let i=0;i<a.directions[direction].length;i++){const f=a.directions[direction][i],r=f.region,x=12+(i%6)*160;if(i&&i%6===0)y+=180;const clip='c'+rows.length;rows.push(`<g><rect x="${x}" y="${y}" width="150" height="150" fill="#205966"/><svg x="${x}" y="${y}" width="150" height="150" viewBox="${-extent} ${-extent} ${extent*2} ${extent*2}"><g transform="scale(${f.flipX?-1:1} ${f.flipY?-1:1})"><defs><clipPath id="${clip}"><rect x="${-f.origin.x}" y="${-f.origin.y}" width="${r.width}" height="${r.height}"/></clipPath></defs><image clip-path="url(#${clip})" href="${assets[f.asset]}" x="${-r.x-f.origin.x}" y="${-r.y-f.origin.y}" width="${pack.assets.find(a=>a.id===f.asset).width}" height="${pack.assets.find(a=>a.id===f.asset).height}" image-rendering="pixelated"/><rect x="${f.collision.x-f.origin.x}" y="${f.collision.y-f.origin.y}" width="${f.collision.width}" height="${f.collision.height}" fill="none" stroke="#80ed99" stroke-width=".5"/><circle cx="${f.grip.x-f.origin.x}" cy="${f.grip.y-f.origin.y}" r="1" fill="#69d6ff"/></g><path d="M-3 0h6M0-3v6" stroke="#f8d66d" stroke-width=".5"/></svg><text x="${x}" y="${y+168}" fill="#f2f7e6">${direction} ${i+1} · ${f.durationMs}ms</text></g>`)}y+=188;}y+=16;}
 const sheet=`<svg xmlns="http://www.w3.org/2000/svg" width="984" height="${y}" viewBox="0 0 984 ${y}"><title>${escapeMarkup(pack.id)} all-frame contact sheet</title><rect width="100%" height="100%" fill="#102f3a"/><g font-family="monospace" font-size="12">${rows.join('')}</g></svg>`;
 const report={schemaVersion:1,packId:pack.id,manifestSha256:digest,assets:pack.assets.map(a=>({id:a.id,sha256:a.sha256,provenance:a.provenance,rights:a.rights})),frames:frameCount,actions:pack.actions.map(a=>({id:a.id,contactMs:a.contactMs,recoveryMs:a.recoveryMs,directions:Object.fromEntries(directions.map(d=>[d,{frames:a.directions[d].length,durationMs:a.directions[d].reduce((n,f)=>n+f.durationMs,0)}]))})),visualAcceptance:false,gameplayAuthority:false,exports:['review.html','contact-sheet.svg','review.json'],notExported:['GIF','MP4'],notes:['The HTML is offline review tooling, not an accepted runtime pack.','Animation timing is sourced from the validated manifest.','Burning Heart art intent is Christian love and generosity rooted in the gospels; narrative implementation requires its own acceptance.']};
 await mkdir(outputDirectory,{recursive:true});
 await writeFile(path.join(outputDirectory,'review.html'),document,{flag:'wx'});
 await writeFile(path.join(outputDirectory,'contact-sheet.svg'),sheet,{flag:'wx'});
 await writeFile(path.join(outputDirectory,'review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{if(process.argv.length!==5)throw Error('Usage: node pack-review.mjs manifest.json asset-root new-output-directory');const r=await buildPackReview(...process.argv.slice(2));console.log(JSON.stringify({pack:r.packId,frames:r.frames,exports:r.exports,visualAcceptance:r.visualAcceptance},null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
