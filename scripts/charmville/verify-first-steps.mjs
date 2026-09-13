import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base='http://localhost:3017';
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});
 assert.equal(response.status(),200);const user=await response.json();
 await page.addInitScript(p=>{sessionStorage.setItem('charmville-local-test-wallet',p.wallet);localStorage.setItem('plankspace-session:'+p.wallet,p.token);},user);
 await page.goto(base+'/charmville/world?panel=play');
 const guide=page.getByRole('region',{name:'Your next adventure'});
 await guide.getByRole('button',{name:'Set up my home'}).click();
 await page.getByRole('button',{name:'Set up home',exact:true}).click();
 await page.getByRole('button',{name:'TREECKO',exact:true}).click();
 await page.getByRole('button',{name:'Confirm companion',exact:true}).click();
 await page.getByRole('button',{name:'Walk with me',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Play',exact:true}).click();
 await guide.getByRole('button',{name:'Enter my home'}).click();
 await guide.getByRole('heading',{name:'Your homestead',exact:true}).waitFor();
 await guide.screenshot({path:'work/first-steps-mobile.png'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // Respect the server's one-second travel throttle.
 await page.waitForTimeout(1100);
 await guide.getByRole('button',{name:'Visit the meadow'}).click();
 await guide.getByRole('heading',{name:'Out in the shared meadow'}).waitFor();
 assert.equal(await page.locator('iframe').count(),1);
 await page.setViewportSize({width:1440,height:1000});
 await guide.screenshot({path:'work/first-steps-desktop.png'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await guide.getByRole('button',{name:'Players & travel'}).click();
 await page.getByRole('region',{name:'Players here',exact:true}).waitFor();
 console.log('Fresh account: home claim, starter selection, home admission and public admission through UI passed; 390/1440 widths; iframe retained.');
}finally{await browser.close();}
