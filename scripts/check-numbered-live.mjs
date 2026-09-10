import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const output='C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/';
const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});const p=await b.newPage({viewport:{width:390,height:844}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
 await p.goto('http://127.0.0.1:8765/arcade/crash.html');
 await p.evaluate(()=>{window.draws=[];window.flightFrames=[];setInterval(()=>{const stage=document.querySelector(".stage");if(stage?.dataset.presentation==="flight")window.flightFrames.push({altitude:Number(stage.dataset.altitude),mult:document.querySelector("#multReadout")?.textContent});},100);document.addEventListener('plank:lottery-result',e=>window.draws.push(e.detail));});
 await p.getByRole('button',{name:'Practice',exact:true}).click();
 for(let i=0;i<3;i++){
   await p.getByRole('button',{name:'Play · Ξ 0.000001',exact:true}).click({timeout:110000});
   await p.waitForFunction(()=>document.querySelector('.lottery-theatre')?.open,{},{timeout:110000});
   await p.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented'||document.querySelector('.lottery-theatre h2')?.textContent==='Result verification unavailable',{},{timeout:30000});
   const draws=await p.evaluate(()=>window.draws),last=draws.at(-1);
   if(last?.ballCount&&last.ballCount!=='0'){
     if(!last.verified)throw new Error('Numbered result verification failed');
     await p.screenshot({path:output+'numbered-lottery-live-mobile.png',fullPage:true});
     await writeFile(output+'numbered-lottery-live-verification.json',JSON.stringify({errors,draw:last,view:await p.locator('.lottery-theatre').innerText()},null,2));
     const frames=await p.evaluate(()=>window.flightFrames);if(!frames.some(f=>f.altitude>0))throw new Error("No rising flight observed before lottery");console.log(JSON.stringify({errors,draw:last,flightFrames:frames.length,maxAltitude:Math.max(...frames.map(f=>f.altitude))}));break;
   }
   await p.getByRole('button',{name:'Back to flight',exact:true}).click();
   if(i===2)throw new Error('No funded draw after three rounds');
 }
}finally{await b.close();}
