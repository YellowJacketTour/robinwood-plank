import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {adventureUrl} from './adventure-entry.mjs';
const out=process.argv[2]??'work/runtime-performance';await mkdir(out,{recursive:true});
const browser=await chromium.launch();const records=[];
try{
 for(const viewport of [{width:390,height:844},{width:1100,height:950}]){
  const context=await browser.newContext({viewport,deviceScaleFactor:1});const page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
  let encodedBytes=0,completedRequests=0,readyAt=null;const errors=[],failedRequests=[];const started=Date.now();
  cdp.on('Network.loadingFinished',event=>{encodedBytes+=event.encodedDataLength;completedRequests++;});
  page.on('pageerror',error=>errors.push(error.message));page.on('requestfailed',r=>failedRequests.push({url:r.url(),failure:r.failure()?.errorText}));
  page.on('console',message=>{if(message.text().includes('CHARMVILLE_HOMESTEAD_ACTIVE')&&readyAt===null)readyAt=Date.now();});
  await page.addInitScript(()=>performance.setResourceTimingBufferSize(3000));
  const url=new URL(adventureUrl(),'http://localhost:3021');url.searchParams.set('test','/quests/charmville/homestead/r01/Homestead.qst');
  await page.goto(url.href,{waitUntil:'load',timeout:60000});const navigationWallMs=Date.now()-started;
  const clickedAt=Date.now();await page.getByRole('button',{name:'Enter the world',exact:true}).click();
  const deadline=Date.now()+45000;while(readyAt===null&&Date.now()<deadline)await page.waitForTimeout(250);
  await page.waitForTimeout(1000);
  const cadence=await page.evaluate(()=>new Promise(resolve=>{const deltas=[];let previous=null,start=null;function frame(now){if(start===null)start=now;if(previous!==null)deltas.push(now-previous);previous=now;if(now-start<3000)requestAnimationFrame(frame);else{const sorted=[...deltas].sort((a,b)=>a-b);resolve({samples:deltas.length,durationMs:now-start,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:Math.max(...deltas),callbacksPerSecond:deltas.length/((now-start)/1000)});}}requestAnimationFrame(frame);}));
  const timings=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(n=>({domContentLoadedMs:n.domContentLoadedEventEnd,loadMs:n.loadEventEnd,responseEndMs:n.responseEnd})),resources:performance.getEntriesByType('resource').map(r=>({name:r.name,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize})),userAgent:navigator.userAgent,canvas:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,displayWidth:c.getBoundingClientRect().width,displayHeight:c.getBoundingClientRect().height}))}));
  await page.screenshot({path:`${out}/${viewport.width}x${viewport.height}.png`});
  records.push({viewport,deviceScaleFactor:1,isMobile:false,touchEmulation:false,navigationWallMs,enterToQuestMarkerMs:readyAt===null?null:readyAt-clickedAt,questMarkerObserved:readyAt!==null,network:{cdpEncodedBytes:encodedBytes,completedRequests,note:'CDP encodedDataLength totals completed requests through sample window; excludes incomplete streams and is not a production CDN payload benchmark.'},rafCadence:cadence,errors,failedRequests,...timings});
  await context.close();
 }
 const result={capturedAt:new Date().toISOString(),environment:{platform:process.platform,node:process.version,chromium:browser.version(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,totalMemoryBytes:os.totalmem(),headless:true},limitations:['Desktop Chromium at two viewport sizes; not physical mobile hardware.','Fresh browser contexts; OS/server filesystem and browser-process caches may remain warm.','No network or CPU throttling. Localhost transfer is not WAN delivery.','requestAnimationFrame cadence is browser callback scheduling, not game engine FPS or input latency.','Single sample per viewport; no statistical performance guarantee.'],records};
 await writeFile(out+'/baseline.json',JSON.stringify(result,null,2));console.log(JSON.stringify(records.map(({viewport,navigationWallMs,enterToQuestMarkerMs,network,rafCadence,errors,failedRequests})=>({viewport,navigationWallMs,enterToQuestMarkerMs,network,rafCadence,errors,failedRequests})),null,2));
}finally{await browser.close();}
