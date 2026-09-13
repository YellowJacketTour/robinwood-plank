// Isolated visual review; never changes a quest, save or published spawn.
import {chromium} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const input=process.argv[2];
if(!input)throw Error('Supply a JSON array of {dmap,screen,name} source candidates');
const candidates=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(candidates)||candidates.length>64||candidates.some(c=>!Number.isInteger(c.dmap)||c.dmap<0||c.dmap>511||!Number.isInteger(c.screen)||c.screen<0||c.screen>127))throw Error('Invalid bounded map candidates');
const output='work/starter-map-review';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});const results=[];
try{
 for(const c of candidates){
  const page=await browser.newPage({viewport:{width:1024,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   const query=new URLSearchParams({test:'/quests/purezc/139/r01/HeroOfDreams.qst',dmap:String(c.dmap),screen:String(c.screen),storage:'idb'});
   await page.goto('http://localhost:3024/play/?'+query);
   await page.getByRole('button',{name:'Enter the world',exact:true}).click();
   await page.waitForFunction(()=>window.charmvilleCameraReady===true,null,{timeout:30000});
   await page.waitForTimeout(1000);
   const file=`dmap-${c.dmap}-screen-${c.screen}.png`;
   await page.locator('#canvas').screenshot({path:output+'/'+file});
   results.push({...c,file,errors,status:'captured-not-approved'});
  }catch(e){results.push({...c,status:'unavailable',error:String(e),errors});}
  finally{await page.close();}
 }
}finally{await browser.close();}
await writeFile(output+'/index.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
