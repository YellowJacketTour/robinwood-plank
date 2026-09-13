import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPrivateReleaseEnvironment } from '../../scripts/configure-charmville-private-release.mjs';
const input={CHARMVILLE_ACCESS_MODE:'private',CHARMVILLE_ADMIN_WALLETS:'0x'+'a'.repeat(40),CHARMVILLE_RUNTIME_READY:'1',CHARMVILLE_RUNTIME_RELEASE:'alpha-01'};
test('private deployment rejects absent, inherited, malformed and injectable authority',()=>{
 for(const patch of [{CHARMVILLE_ADMIN_WALLETS:undefined,PLANK_ADMIN_ADDRESSES:input.CHARMVILLE_ADMIN_WALLETS},{CHARMVILLE_ADMIN_WALLETS:input.CHARMVILLE_ADMIN_WALLETS+','},{CHARMVILLE_RUNTIME_RELEASE:'alpha\nEVIL=1'},{CHARMVILLE_ACCESS_MODE:'local-development'},{CHARMVILLE_RUNTIME_READY:'0'}]) assert.throws(()=>renderPrivateReleaseEnvironment('',{...input,...patch}));
});
test('private deployment preserves unrelated settings and removes duplicate stale authority',()=>{
 const source='# unrelated\nPLANK_ADMIN_ADDRESSES=other\nPGPASSWORD="fake fixture # value"\nexport CHARMVILLE_ADMIN_WALLETS=old\nCHARMVILLE_ADMIN_WALLETS=older\nCHARMVILLE_RUNTIME_ROOT=/old\nCHARMVILLE_ALLOWED_WALLETS=old-player\n';
 const output=renderPrivateReleaseEnvironment(source,input);
 assert.ok(output.startsWith('# unrelated\nPLANK_ADMIN_ADDRESSES=other\nPGPASSWORD="fake fixture # value"\n'));
 assert.equal(output.match(/CHARMVILLE_ADMIN_WALLETS=/g)?.length,1);
 assert.ok(output.includes('CHARMVILLE_ALLOWED_WALLETS=\n'));
 assert.ok(!output.includes('CHARMVILLE_RUNTIME_ROOT'));
 assert.throws(()=>renderPrivateReleaseEnvironment('CHARMVILLE_ADMIN_WALLETS="unfinished\n',input));
});
