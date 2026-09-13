import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';

/** Deliberately refuses ordinary local app databases and every non-loopback host.
 * The database name must carry an explicit test/acceptance marker and match the
 * operator's independent confirmation. No production DATABASE_URL fallback.
 */
export function localFixtureDatabase(raw,expectedName) {
  let url;
  try {url=new URL(raw);} catch {throw Error('Explicit isolated PostgreSQL test URL required');}
  const name=decodeURIComponent(url.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||
    url.search||url.hash||!name||name!==expectedName||! /^(?:charmville|plankspace|plank)_[a-z0-9_]{1,80}$/.test(name)||
    !/(?:^|_)(?:test|acceptance)(?:_|$)/.test(name))throw Error('Only an explicitly confirmed isolated local test database is allowed');
  return {connectionString:url.href,name};
}

async function privateOutput() {
  const directory=await mkdtemp(path.join(tmpdir(),'charmville-runtime-fixture-'));
  try {
    if(process.platform==='win32') {
      const identity=execFileSync('whoami',[],{encoding:'utf8',windowsHide:true}).trim();
      if(!identity||/[\r\n]/.test(identity))throw Error('Local identity unavailable');
      execFileSync('icacls',[directory,'/inheritance:r','/grant:r',`${identity}:(OI)(CI)F`],{stdio:'ignore',windowsHide:true});
    } else await chmod(directory,0o700);
    return {directory,filename:path.join(directory,'fixture.json')};
  } catch(error) {await rmdir(directory).catch(()=>{});throw error;}
}

export async function provisionRuntimeBrowserFixture(env=process.env) {
  if(env.CHARMVILLE_PROVISION_SYNTHETIC_FIXTURE!=='1')throw Error('Explicit synthetic fixture permission required');
  const config=localFixtureDatabase(env.CHARMVILLE_TEST_DATABASE_URL,env.CHARMVILLE_TEST_DATABASE_NAME);
  const output=await privateOutput();
  const pool=new Pool({connectionString:config.connectionString,connectionTimeoutMillis:5000,max:1});
  let client;
  try {
    client=await pool.connect();
    const database=(await client.query('SELECT current_database() AS name')).rows[0]?.name;
    if(database!==config.name)throw Error('Connected database identity mismatch');
    const wallet='0x'+randomBytes(20).toString('hex'),token=randomBytes(32).toString('hex');
    const handle='runtime_test_'+randomBytes(6).toString('hex');
    await client.query('BEGIN');
    const profile=(await client.query(`INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status,layout_json)
      VALUES($1,$2,'Synthetic runtime guest','approved','["feed","friends"]') RETURNING id::text`,[wallet,handle])).rows[0];
    const expiresAt=(await client.query("SELECT (clock_timestamp()+interval '2 hours') AS expiry")).rows[0].expiry.toISOString();
    await client.query('INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),wallet,expiresAt]);
    await client.query('INSERT INTO charmville_admission_grants(profile_id,expires_at) VALUES($1,$2)',[profile.id,expiresAt]);
    // No runtime ticket is seeded: the browser must exercise the protected issuer.
    await client.query('COMMIT');
    await writeFile(output.filename,JSON.stringify({schemaVersion:1,synthetic:true,purpose:'isolated-runtime-browser-acceptance',baseUrl:'http://localhost:3018',database:config.name,profileId:profile.id,wallet,handle,token,expiresAt})+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    return {synthetic:true,fixtureFile:output.filename,profileId:profile.id,handle,expiresAt};
  } catch(error) {
    if(client)await client.query('ROLLBACK').catch(()=>{});
    await rm(output.filename,{force:true}).catch(()=>{});await rmdir(output.directory).catch(()=>{});
    throw error;
  } finally {client?.release();await pool.end();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.slice(2).join(' ')!=='--synthetic-local-only')throw Error('Use --synthetic-local-only with an isolated test database');
  try {console.log(JSON.stringify(await provisionRuntimeBrowserFixture()));}
  catch {console.error('Synthetic runtime fixture provisioning failed. No credentials were printed. Check isolated database configuration and schema.');process.exitCode=1;}
}
