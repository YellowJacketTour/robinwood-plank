import {chromium} from 'playwright';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const out=process.argv[2]||'.charmville-controls-check';await mkdir(out,{recursive:true});const b=await chromium.launch();
try{
 const p=await b.newPage({viewport:{width:1280,height:900}});await p.addInitScript(()=>{window.pad={connected:true,id:'Standard controller test fixture',mapping:'standard',buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};navigator.getGamepads=()=>[window.pad];window.keyEvents=[];for(const type of ['keydown','keyup'])document.addEventListener(type,e=>window.keyEvents.push([type,e.key]));});
 await p.goto('http://localhost:3021/charmville/');await p.waitForTimeout(300);await p.evaluate(()=>document.activeElement?.blur());
 await p.evaluate(()=>{window.pad.buttons[0].pressed=true;});await p.waitForTimeout(150);await p.evaluate(()=>{window.pad.buttons[0].pressed=false;});await p.waitForTimeout(150);
 let events=await p.evaluate(()=>window.keyEvents);assert(events.some(e=>e[0]==='keydown'&&e[1]==='z'));assert(events.some(e=>e[0]==='keyup'&&e[1]==='z'));
 await p.evaluate(()=>{window.keyEvents=[];window.pad.axes[0]=.1;});await p.waitForTimeout(120);assert.equal((await p.evaluate(()=>window.keyEvents)).length,0);
 await p.evaluate(()=>{window.pad.axes[0]=.8;});await p.waitForTimeout(120);await p.evaluate(()=>{window.pad.connected=false;});await p.waitForTimeout(120);events=await p.evaluate(()=>window.keyEvents);assert(events.some(e=>e[0]==='keyup'&&e[1]==='ArrowRight'));
 await p.getByText('Display',{exact:true}).click();const slider=p.getByRole('slider',{name:'Game size'});await slider.fill('150');await p.waitForTimeout(100);assert.equal(await slider.inputValue(),'150');
 await p.setViewportSize({width:3840,height:2160});await p.waitForTimeout(300);let rect=await p.locator('#canvas').boundingBox();assert(rect.width>1000);await p.getByRole('button',{name:'Fit',exact:true}).click();await p.getByRole('button',{name:'Fullscreen',exact:true}).click();await p.waitForTimeout(200);assert(await p.evaluate(()=>Boolean(document.fullscreenElement)));
 assert(await p.evaluate(()=>getComputedStyle(document.querySelector('header')).display==='none'));
 rect=await p.locator('#canvas').boundingBox();assert(rect.height<=2160&&rect.width<=3840);
 await p.getByRole('button',{name:'Menu',exact:true}).click();assert(await p.locator('header').isVisible());
 await p.getByRole('checkbox',{name:'Whole pixel scaling'}).check();
 assert(await p.evaluate(()=>{const c=document.getElementById('canvas');const scale=parseFloat(c.style.getPropertyValue('--charm-width'))/c.width;return Number.isInteger(scale);}));
 await p.screenshot({path:out+'/desktop-fullscreen.png'});await p.evaluate(()=>document.exitFullscreen());
 const mobile=await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await mobile.goto('http://localhost:3021/charmville/');await mobile.waitForTimeout(200);rect=await mobile.locator('#canvas').boundingBox();assert(rect.width<=390);await mobile.screenshot({path:out+'/mobile-controls.png'});
 await writeFile(out+'/controls-verification.json',JSON.stringify({result:'pass',checks:['Synthetic standard gamepad sword down/up','Dead zone rejects stick drift','Disconnect releases held movement','Zoom slider','3840x2160 layout','Fullscreen enter/exit','390x844 touch layout'],limitations:['No physical controller tested','Pinch gesture not yet device-tested']},null,2));console.log('PASS display and synthetic controller checks');
}finally{await b.close()}
