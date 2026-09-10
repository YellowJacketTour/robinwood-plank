import {chromium} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {MAX_PHYSICAL_BALLS} from '../public/arcade/lottery-population.js';
const population=Number(process.argv[2]||16),output=resolve(process.argv[3]||'work/lottery-physics');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const consoleErrors=[];page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
try{
 await page.goto('http://127.0.0.1:8765/arcade/crash.html?physicsDebug=1');
 await page.evaluate(()=>{window.samples=[];document.addEventListener('plank:lottery-presented',()=>document.querySelector('.lottery-theatre')?.dispatchEvent(new Event('pointerdown')));setInterval(()=>{const c=document.querySelector('.lottery-theatre canvas');if(c?.dataset.physics==='rapier')window.samples.push({...c.dataset});},35);});
 await page.evaluate(n=>document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:'Physics fixture',participated:true,verified:true,hit:false,ballCount:String(n),drawnBall:String(Math.min(17,n)),nextPrize:'0'}})),population);
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented'||document.querySelector('.lottery-static-ball'),{},{timeout:30000}).catch(async e=>{throw Error(JSON.stringify({error:e.message,consoleErrors,errors,text:await page.locator('body').innerText()}));});
 if(await page.locator('.lottery-static-ball').count())throw Error(JSON.stringify({fallback:true,consoleErrors,errors}));
 const samples=await page.evaluate(()=>[...window.samples,{...document.querySelector(".lottery-theatre canvas").dataset}]),phases=[...new Set(samples.map(s=>s.phase))];
 for(const phase of ['mixing','chute','rolling','orienting','presented'])if(!phases.includes(phase))throw Error('Missing phase '+phase);
 const initialBodies=samples.map(s=>JSON.parse(s.chamberSnapshot||'[]')).find(b=>b.length>0)||[];
 const initialHeights=new Set(initialBodies.map(b=>Math.round(b.position.y*1000))).size;
 if(population>1&&!initialBodies.length)throw Error('Missing initial chamber snapshot');
 if(initialHeights<Math.min(10,initialBodies.length/2))throw Error('Initial chamber is still arranged in construction rows');
 let maximumPenetration=0,maximumEscape=0,maximumRimPenetration=0,moving=false,peak=null;
 for(const sample of samples){const bodies=JSON.parse(sample.chamberSnapshot||'[]');
  for(let i=0;i<bodies.length;i++){const p=bodies[i].position,v=bodies[i].velocity;if(Math.hypot(v.x,v.y,v.z)>.1)moving=true;
   if(p.y>.32)maximumEscape=Math.max(maximumEscape,Math.hypot(p.x,p.y-.89,p.z)-(1.12-Number(sample.ballRadius)));
   maximumRimPenetration=Math.max(maximumRimPenetration,Number(sample.ballRadius)+.055-Math.hypot(Math.hypot(p.x,p.z)-.94,p.y-.32));
   if(p.y<-.65)throw Error('Chamber ball escaped into chassis');
   for(let j=0;j<i;j++){const q=bodies[j].position;const penetration=2*Number(sample.ballRadius)-Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);if(penetration>maximumPenetration){maximumPenetration=penetration;peak={phase:sample.phase,i,j,p,q};}}
  }
 }
 if(!moving||maximumEscape>.002||maximumRimPenetration>.002||maximumPenetration>.004||errors.length)throw Error(JSON.stringify({moving,maximumEscape,maximumRimPenetration,maximumPenetration,errors,peak}));
 if(Number(samples.at(-1).visiblePopulation)!==Math.min(population,MAX_PHYSICAL_BALLS))throw Error('Population mismatch');
 const rolling=samples.filter(s=>s.phase==='rolling'),orienting=samples.filter(s=>s.phase==='orienting');
 if(new Set(rolling.map(s=>s.ballRotation)).size<2||new Set(orienting.map(s=>s.ballRotation)).size<2)throw Error('Missing roll or orientation motion');
 const maximumFunnelPenetration=Math.max(...samples.map(s=>Number(s.funnelPenetration||0)));
 if(maximumFunnelPenetration>.002)throw Error(`Funnel penetration ${maximumFunnelPenetration} ${samples.find(s=>Number(s.funnelPenetration)===maximumFunnelPenetration)?.funnelContact}`);
 const report={maximumFunnelPenetration,population,visiblePopulation:Number(samples.at(-1).visiblePopulation),radius:Number(samples.at(-1).ballRadius),initialHeights,errors,phases,moving,maximumEscape,maximumRimPenetration,maximumPenetration,sampleCount:samples.length};
 await page.screenshot({path:resolve(output,'machine.png')});
 await writeFile(resolve(output,'physics-proof.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
