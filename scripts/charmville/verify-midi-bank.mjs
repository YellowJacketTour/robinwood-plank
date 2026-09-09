import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out=process.argv[2]||'work/midi-bank';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage(),messages=[],errors=[],failed=[];
 page.on('console',m=>messages.push(m.text()));page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().includes('/timidity/')&&!r.ok())failed.push(r.url());});
 await page.goto('http://localhost:3021/charmville/tutorial/');await page.getByRole('button',{name:'Enter the world',exact:true}).click();
 await page.waitForFunction(()=>typeof FS!=='undefined'&&FS.analyzePath('/etc/Tone_000/024_Nylon_Guitar.pat').exists,{},{timeout:60000});
 await page.waitForTimeout(12000);
 assert(messages.some(m=>m.includes('CHARMVILLE_MIDI_BANK_READY 191')));
 assert(messages.some(m=>m.includes('CHARMVILLE_HOMESTEAD_ACTIVE')));
 const missing=messages.filter(m=>/\.pat/i.test(m)&&/not found|cannot|could not|failed|No such/i.test(m));
 assert.deepEqual(missing,[]);assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
 await writeFile(out+'/verification.json',JSON.stringify({missing,errors,failed,ready:messages.filter(m=>m.startsWith('CHARMVILLE_')),note:'Instrument loading verified; no auditory quality judgment.'},null,2));
 console.log('Default MIDI bank loaded; no missing patch errors.');
}finally{await browser.close();}
