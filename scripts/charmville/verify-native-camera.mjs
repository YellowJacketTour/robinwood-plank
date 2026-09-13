import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.argv[2]||'.charmville-camera-candidate';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://localhost:3025/play/?test=%2Fquests%2Fcharmville%2Fhomestead-region%2Fr01%2FHomestead.qst&dmap=4&screen=63&storage=idb&testParty=6');
 await page.getByRole('button',{name:'Enter the world',exact:true}).click();
 await page.waitForFunction(()=>window.charmvilleCameraReady===true,null,{timeout:180000});
 await page.waitForFunction(()=>{try{return FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/position.txt',{encoding:'utf8'}).includes('|');}catch{return false;}},null,{timeout:10000});
 const state=()=>page.evaluate(()=>({zoom:window.charmvilleCameraActualZoom,view:window.charmvilleCameraViewport,position:(()=>{try{return FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/position.txt',{encoding:'utf8'});}catch{return null;}})(),rect:(()=>{const r=document.querySelector('#canvas').getBoundingClientRect();return {width:r.width,height:r.height};})()}));
 // The existing tutorial relocates its initial engine spawn. Establish an idle
 // baseline before sending any camera input, then assert zoom preserves it.
 let stable=0,previous='';const startup=[];
 for(let i=0;i<30&&stable<3;i++){
  const sample=await state();const position=sample.position?.split('|').slice(1,5).join('|');startup.push(position);
  stable=position&&position===previous?stable+1:0;previous=position;
  await page.waitForTimeout(100);
 }
 assert(stable>=3,'Tutorial placement did not settle');
 const normal=await state();
 await page.screenshot({path:output+'/normal.png'});
 await page.locator('#canvas').hover();await page.mouse.wheel(0,500);
 await page.waitForFunction(()=>window.charmvilleCameraActualZoom<=.51,null,{timeout:10000});
 const wide=await state();
 assert.deepEqual(wide.rect,normal.rect,'Camera zoom must not resize the canvas');
 assert(wide.view.width>normal.view.width,'Zoom must reveal a wider world rectangle');
 assert(wide.view.height>normal.view.height,'Zoom must reveal a taller world rectangle');
 assert.deepEqual(wide.position.split('|').slice(1,5),normal.position.split('|').slice(1,5),'Zoom alone must not relocate the player');
 await page.screenshot({path:output+'/wide.png'});
 const introduction=page.getByRole('button',{name:/^(Continue introduction|Begin exploring)$/});
 for(let stage=0;stage<3;stage++){
  await page.waitForFunction(()=>{const b=document.querySelector('.charm-tutorial-continue');return !b||b.hidden||!b.disabled;},null,{timeout:10000});
  if(!await introduction.isVisible())break;
  await introduction.click();await page.waitForTimeout(400);
 }
 await page.getByRole('button',{name:'Resume keyboard play',exact:true}).click();
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(600);await page.keyboard.up('ArrowRight');
 await page.screenshot({path:output+'/wide-gameplay.png'});
 await page.keyboard.press('0');
 await page.waitForFunction(()=>window.charmvilleCameraActualZoom===1,null,{timeout:10000});
 const restored=await state();assert.deepEqual(restored.rect,normal.rect);
 await page.screenshot({path:output+'/restored.png'});
 await page.getByRole('button',{name:'Map overview',exact:true}).click();
 await page.waitForFunction(()=>window.charmvilleMapOpen===true,null,{timeout:30000});
 await page.getByRole('button',{name:'Return to world',exact:true}).waitFor();
 await page.waitForFunction(()=>window.charmvilleMapNavigationReady===true);
 const mapState=()=>page.evaluate(()=>window.charmvilleMapNavigation);
 const mapBefore=await mapState();
 await page.locator('#canvas').hover();await page.mouse.wheel(0,-100);
 await page.waitForFunction(index=>window.charmvilleMapNavigation.scaleIndex>index,mapBefore.scaleIndex);
 const mapZoomed=await mapState();
 const box=await page.locator('#canvas').boundingBox();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.6,box.y+box.height*.55,{steps:8});await page.mouse.up();
 await page.waitForFunction(x=>window.charmvilleMapNavigation.panX>x,mapZoomed.panX);
 const mapDragged=await mapState();
 await page.keyboard.down('w');await page.waitForTimeout(200);await page.keyboard.up('w');
 await page.waitForFunction(y=>window.charmvilleMapNavigation.panY>y,mapDragged.panY);
 const mapKeyboard=await mapState();
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(200);await page.keyboard.up('ArrowRight');
 await page.waitForFunction(x=>window.charmvilleMapNavigation.panX<x,mapKeyboard.panX);
 await page.screenshot({path:output+'/overview.png'});
 await page.getByRole('button',{name:'Return to world',exact:true}).click();
 await page.waitForFunction(()=>window.charmvilleMapOpen===false,null,{timeout:10000});
 assert.deepEqual(errors,[]);
 await writeFile(output+'/result.json',JSON.stringify({startup,normal,wide,restored,mapBefore,mapZoomed,mapDragged,mapKeyboard,errors,limitations:['Not multiplayer scale proof','Not a full quest replay comparison','Touch tested separately with synthetic gesture unit tests']},null,2));
 console.log('PASS native camera changes world extent without changing canvas size');
}finally{await browser.close();}
