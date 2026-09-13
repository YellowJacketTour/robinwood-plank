/** Scheduling evidence in Chromium, not proof of physical phone/GPU performance. */
export async function measureFrameTiming(page, label, cpuRate=1) {
  const cdp=await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
    const result=await page.evaluate(async()=>{
      const intervals=[];let previous=0;const started=performance.now();
      await new Promise(resolve=>{
        function tick(now){if(previous)intervals.push(now-previous);previous=now;
          if(now-started<4000)requestAnimationFrame(tick);else resolve();}
        requestAnimationFrame(tick);
      });
      intervals.sort((a,b)=>a-b);
      return {samples:intervals.length,p50Ms:intervals[Math.floor(intervals.length*.5)],
        p95Ms:intervals[Math.floor(intervals.length*.95)],over33ms:intervals.filter(v=>v>33.4).length,
        runningCropAnimations:[...document.querySelectorAll("[data-plot] image")].filter(e=>getComputedStyle(e).animationName!=="none"&&getComputedStyle(e).animationPlayState==="running").length,
        sceneNodes:document.querySelector('svg[aria-label="Isometric Charmville yard"]')?.querySelectorAll('*').length,
        viewport:{width:innerWidth,height:innerHeight},userAgent:navigator.userAgent};
    });
    return {label,cpuRate,...result};
  }finally{await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();}
}
