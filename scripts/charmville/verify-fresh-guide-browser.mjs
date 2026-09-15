import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {localFixtureDatabase,provisionRuntimeBrowserFixture} from './provision-runtime-browser-fixture.mjs';

const config=localFixtureDatabase(process.env.CHARMVILLE_TEST_DATABASE_URL,process.env.CHARMVILLE_TEST_DATABASE_NAME);
assert.equal(config.name,'charmville_acceptance_20260913');
assert.equal(process.env.CHARMVILLE_PROVISION_SYNTHETIC_FIXTURE,'1');
const base='http://localhost:3018',output=path.resolve('work/fresh-guide-browser');
await mkdir(output,{recursive:true});
const pool=new Pool({connectionString:config.connectionString});
let fixture,privateFile,browser,stage='provision';
const evidence={status:'pending',scope:'fresh synthetic account, real local app/database, headless browser; no native cinematic or follower acceptance',profile26Preserved:false,cleaned:false};
const protectedBefore=(await pool.query("SELECT row_to_json(y) AS yard FROM charmville_yards y WHERE profile_id=26")).rows;
try{
 const provisioned=await provisionRuntimeBrowserFixture();privateFile=provisioned.fixtureFile;
 fixture=JSON.parse(await readFile(privateFile,'utf8'));evidence.syntheticProfileId=fixture.profileId;
 assert.notEqual(fixture.profileId,'26');assert.match(fixture.handle,/^runtime_test_[a-f0-9]+$/);
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 await page.addInitScript(({wallet,token})=>{sessionStorage.setItem('charmville-local-test-wallet',wallet);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);},{wallet:fixture.wallet,token:fixture.token});
 stage='new-arrival';await page.goto(base+'/charmville/world?panel=play');
 await page.getByRole('button',{name:'Begin my journey',exact:true}).click({timeout:45000});
 stage='claim-home';await page.getByRole('button',{name:'Set up home',exact:true}).click();
 stage='journal-after-claim';await page.getByRole('tab',{name:'Journal',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[role="tab"][aria-selected="true"]')?.textContent==='Journal');
 const guide=page.getByRole('region',{name:'Your fairy guide',exact:true});
 await guide.getByRole('button',{name:'Return home',exact:true}).waitFor();
 evidence.claimRoutesToJournal=true;
 stage='family-reader';await guide.getByRole('button',{name:'Read the opening',exact:true}).click();
 await guide.getByRole('heading',{name:'Mother',exact:true}).waitFor();
 await page.keyboard.press('a');await guide.getByRole('heading',{name:'Father',exact:true}).waitFor();
 await page.keyboard.press('b');await guide.getByRole('button',{name:'Continue the opening',exact:true}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'Journal',exact:true}).getAttribute('aria-selected'),'true');
 await guide.getByRole('button',{name:'Continue the opening',exact:true}).click();
 await guide.getByRole('heading',{name:'Father',exact:true}).waitFor();
 await page.keyboard.press('Escape');await guide.getByRole('button',{name:'Continue the opening',exact:true}).waitFor();
 evidence.readerBackKeepsJournal=true;evidence.localBookmarkResumes=true;
 stage='home-admission';await guide.getByRole('button',{name:'Return home',exact:true}).click();
 await guide.getByRole('heading',{name:'A place for love to grow',exact:true}).waitFor();
 await guide.getByRole('button',{name:'Go to my beds',exact:true}).waitFor();
 evidence.firstLessonIsSoil=true;
 stage='no-implicit-companion';const companions=(await pool.query('SELECT count(*)::int AS n FROM charmville_companions WHERE owner_profile_id=$1',[fixture.profileId])).rows[0].n;
 assert.equal(companions,0);evidence.noCompanionGrantedByReading=true;
 const family=(await pool.query('SELECT count(*)::int AS n FROM charmville_family_entitlements WHERE profile_id=$1',[fixture.profileId])).rows[0].n;
 assert.equal(family,0);evidence.noFamilyGiftGrantedByReading=true;
 await page.screenshot({path:path.join(output,'journal-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(output,'journal-mobile.png')});
 evidence.mobileNoPageOverflow=true;evidence.status='passed';
}catch{evidence.status='failed';evidence.failureStage=stage;process.exitCode=1;}
finally{
 await browser?.close();
 if(fixture&&fixture.profileId!=='26'&&/^runtime_test_[a-f0-9]+$/.test(fixture.handle)){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const row=(await client.query('SELECT handle FROM plankspace_profiles WHERE id=$1 AND wallet=$2 FOR UPDATE',[fixture.profileId,fixture.wallet])).rows[0];
   assert.equal(row?.handle,fixture.handle);assert.notEqual(fixture.profileId,'26');
   await client.query("DELETE FROM charmville_native_resources WHERE region_id='home:' || $1::text",[fixture.profileId]);
   for(const table of ['charmville_runtime_sessions','charmville_native_actions','charmville_capture_supply','charmville_creature_rosters','charmville_receipts','charmville_plots','charmville_seeds','charmville_stacks','charmville_yards','charmville_admission_grants'])await client.query(`DELETE FROM ${table} WHERE profile_id=$1`,[fixture.profileId]);
   await client.query('DELETE FROM plankspace_wallet_sessions WHERE wallet=$1',[fixture.wallet]);
   await client.query('DELETE FROM plankspace_profiles WHERE id=$1',[fixture.profileId]);
   await client.query('COMMIT');evidence.cleaned=true;
  }catch(error){evidence.cleanupErrorCode=error.code??'assertion';evidence.cleanupConstraint=error.constraint??null;await client.query('ROLLBACK');await client.query("UPDATE plankspace_wallet_sessions SET expires_at=clock_timestamp() WHERE wallet=$1",[fixture.wallet]);evidence.cleanup='session revoked; fixture rows retained';evidence.status='failed';process.exitCode=1;}
  finally{client.release();}
 }
 const protectedAfter=(await pool.query("SELECT row_to_json(y) AS yard FROM charmville_yards y WHERE profile_id=26")).rows;
 evidence.profile26Preserved=JSON.stringify(protectedBefore)===JSON.stringify(protectedAfter);
 if(!evidence.profile26Preserved){evidence.status='failed';process.exitCode=1;}
 await pool.end();
 if(privateFile){await unlink(privateFile);await rmdir(path.dirname(privateFile));}
 await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
}
