import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(process.argv[2]||'work/arcade-verification');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const errors=[];
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765/arcade/crash.html');
  await page.getByText('☰',{exact:true}).click();
  await page.getByRole('button',{name:'Explore space',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.stage').dataset.altitude)>.8);
  await page.screenshot({path:resolve(output,'chalkstronaut-flight-desktop.png')});
  await page.getByRole('button',{name:'Open lottery machine'}).click();
  await page.screenshot({path:resolve(output,'lottery-machine-desktop.png')});
  await page.getByRole('button',{name:'Back to flight'}).click();
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await page.getByText('☰',{exact:true}).click();
  await page.getByRole('button',{name:'Explore space',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.stage').dataset.altitude)>.8);
  await page.screenshot({path:resolve(output,'chalkstronaut-flight-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw new Error('Mobile horizontal overflow');
  // Real local round: commit the smallest stake and use the real fuel candidate.
  await page.getByRole('button',{name:'▶ Start practice',exact:true}).click();
  await page.getByRole('button',{name:'Play · Ξ 0.000001',exact:true}).click({timeout:100000});
  await page.getByText('Fuel · burn PLANK',{exact:true}).click();
  await page.getByRole('button',{name:'Burn & fuel',exact:true}).click({timeout:100000});
  await page.waitForFunction(()=>document.getElementById('communityFuelControl')?.dataset.confirmed==='true',{},{timeout:30000});
  await page.screenshot({path:resolve(output,'practice-fuel-receipt.png'),fullPage:true});
  await page.waitForFunction(()=>document.querySelector('.lottery-theatre')?.open,{},{timeout:100000});
  await page.waitForFunction(()=>['Prize awarded','Prize rolls over'].includes(document.querySelector('.lottery-theatre h2')?.textContent),{},{timeout:10000});
  await page.screenshot({path:resolve(output,'recorded-lottery-result.png'),fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  await writeFile(resolve(output,'verification.json'),JSON.stringify({passed:true,mobileWidth:390,horizontalOverflow:false,pageErrors:errors,checks:['visible high-altitude Chalkstronaut','full-size 3D lottery','penny stake accepted','fuel burn confirmed','contract lottery result revealed']},null,2));
  console.log('PASS: flight, 390px layout, penny wager, fuel burn, recorded lottery reveal');
}finally{await browser.close();}
