import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';

if (!process.argv.includes('--synthetic')) {
  console.log('For real wallet testing open http://localhost:3017/profile-editor in your normal browser.');
  console.log('For an isolated synthetic fixture explicitly run this script with --synthetic.');
  process.exit(0);
}

// A real local board and session, never a production authentication bypass.
const db = new URL(process.env.CHARMVILLE_TEST_DATABASE_URL);
const base = new URL(process.env.CHARMVILLE_TEST_BASE_URL || 'http://localhost:3017');
if (![db, base].every(url => ['localhost', '127.0.0.1'].includes(url.hostname))) {
  throw new Error('Playtest requires a local database and local application.');
}
const pool = new Pool({ connectionString: db.href, connectionTimeoutMillis:5000 });
const wallet = '0x' + randomBytes(20).toString('hex');
const token = randomBytes(32).toString('hex');
const handle = 'play_' + randomBytes(5).toString('hex');
let browser;
try {
  await pool.query(`INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status,layout_json)
    VALUES($1,$2,'Your Charmville playtest','approved','["feed","friends"]')`, [wallet, handle]);
  await pool.query(`INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)`,
    [createHash('sha256').update(token).digest('hex'), wallet, new Date(Date.now()+86400000).toISOString()]);
  browser = await chromium.launch({ headless:false });
  const context = await browser.newContext({ viewport:null });
  await context.addInitScript(({wallet,token}) => {
    localStorage.setItem('plankspace-terms-2026-08-22-v1','accepted');
    localStorage.setItem('plankspace-session:'+wallet,token);
    localStorage.setItem('plankspace-last-verified-wallet',wallet);
    window.ethereum = { isMetaMask:true, request:async ({method}) => {
      if (method==='eth_accounts'||method==='eth_requestAccounts') return [wallet];
      if (method==='eth_chainId') return '0x1237';
      throw new Error('This local playtest wallet cannot sign or submit transactions.');
    }, on(){}, removeListener(){} };
  }, {wallet,token});
  const page = await context.newPage();
  await page.goto(new URL('/u/'+handle,base).href);
  await page.getByRole('region',{name:'Charmville porch'}).scrollIntoViewIfNeeded();
  console.log(`Playtest open: ${base.origin}/u/${handle}`);
  console.log('Use the opened browser: claim, gather, replant, open the satchel. Reload preserves the server state.');
  console.log('Synthetic local session expires in 24 hours. Close the browser to finish and remove the fixture.');
  await new Promise(resolve => browser.once('disconnected',resolve));
} finally {
  await browser?.close();
  // Only this random fixture is removed, with FK children before their parents.
  await pool.query('DELETE FROM plankspace_wallet_sessions WHERE wallet=$1',[wallet]);
  for (const table of ['charmville_stamps','charmville_tends']) {
    const column=table==='charmville_tends'?'actor_profile_id':'profile_id';
    await pool.query(`DELETE FROM ${table} WHERE ${column}=(SELECT id FROM plankspace_profiles WHERE wallet=$1)`,[wallet]);
  }
  for (const table of ['charmville_receipts','charmville_plots','charmville_seeds','charmville_stacks','charmville_yards']) {
    await pool.query(`DELETE FROM ${table} WHERE profile_id=(SELECT id FROM plankspace_profiles WHERE wallet=$1)`,[wallet]);
  }
  await pool.query('DELETE FROM plankspace_posts WHERE author_wallet=$1',[wallet]);
  await pool.query('DELETE FROM plankspace_profiles WHERE wallet=$1',[wallet]);
  await pool.end();
}
