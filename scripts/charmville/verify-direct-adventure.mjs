import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.argv[2]||'.charmville-direct-check');await mkdir(out,{recursive:true});
const b=await chromium.launch({headless:true});
try{
 const p=await b.newPage({viewport:{width:1280,height:900}});const errors=[],failures=[],external=[];
 p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400)failures.push(r.url());});
 await p.route('**/*',r=>{const u=new URL(r.request().url());if(['http:','https:'].includes(u.protocol)&&!['localhost','127.0.0.1'].includes(u.hostname)){external.push(u.origin);return r.abort();}return r.continue();});
 await p.goto('http://localhost:3021/charmville/');assert.equal(new URL(p.url()).searchParams.get('dmap'),'4');
 // Exercise a delayed user gesture, which previously broke suspended SDL audio.
 await p.waitForTimeout(2500);await p.getByRole('button',{name:'Enter the world',exact:true}).click();
 await p.waitForFunction(()=>document.getElementById('status')?.hidden,{},{timeout:30000});await p.waitForTimeout(2500);
 assert.equal(await p.evaluate(()=>crossOriginIsolated),true);await p.screenshot({path:path.join(out,'start.png')});
 async function hold(key,ms=120){await p.keyboard.down(key);await p.waitForTimeout(ms);await p.keyboard.up(key);}
 await hold('ArrowLeft',400);await p.keyboard.down('z');await p.waitForTimeout(120);await p.screenshot({path:path.join(out,'sword.png')});await p.keyboard.up('z');
 await hold('Enter');await p.waitForTimeout(1000);await p.screenshot({path:path.join(out,'inventory.png')});
 await p.reload();await p.getByRole('button',{name:'Enter the world',exact:true}).click();await p.waitForFunction(()=>document.getElementById('status')?.hidden,{},{timeout:30000});await p.waitForTimeout(2500);
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(external,[]);
 const receipt={result:'pass',checks:['Direct authored map entry','Delayed gesture audio startup','Sword and movement inputs exercised; screenshots retained','Source inventory opened; screenshot retained','Warm reload','Cross-origin isolation','No page errors, failed HTTP responses or external requests'],limitations:['Test mode resets progress','Farming, creatures, multiplayer and PlankSpace inventory not connected']};
 await writeFile(path.join(out,'verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await b.close();}
