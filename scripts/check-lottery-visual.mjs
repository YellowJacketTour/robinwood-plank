import {chromium} from '@playwright/test';
const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const p=await b.newPage({viewport:{width:1100,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto('http://127.0.0.1:8765/arcade/crash.html');await p.getByRole('button',{name:'Open lottery machine'}).click();
await p.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='chute');
await p.screenshot({path:'C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/lottery-chute.png'});
await p.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented');
await p.screenshot({path:'C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/lottery-presented.png'});
console.log(JSON.stringify({errors,text:await p.locator('.lottery-theatre').innerText()}));await b.close();
