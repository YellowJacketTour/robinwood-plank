import test from 'node:test';
import assert from 'node:assert/strict';
import {localSocketConfig} from './local-socket-config.mjs';
test('local gateway follows the actual application port',()=>{
 const config=localSocketConfig({CHARMVILLE_LOCAL_UPSTREAM:'http://localhost:3018'});
 assert.equal(config.upstream,'http://localhost:3018');assert.equal(config.port,3023);
 assert.deepEqual([...config.origins],['http://localhost:3018','http://127.0.0.1:3018']);
});
test('gateway cannot be configured as a remote or credential-bearing proxy',()=>{
 for(const upstream of ['https://plank.love','http://evil.example','http://user:pass@localhost:3018','http://localhost:3018/api','http://localhost:3018/?token=secret'])assert.throws(()=>localSocketConfig({CHARMVILLE_LOCAL_UPSTREAM:upstream}));
 for(const port of ['80','0','NaN','99999','3023.1'])assert.throws(()=>localSocketConfig({CHARMVILLE_LOCAL_SOCKET_PORT:port}));
 assert.throws(()=>localSocketConfig({CHARMVILLE_LOCAL_UPSTREAM:'http://localhost:3023'}));
});
