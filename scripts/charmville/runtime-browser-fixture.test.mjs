import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localFixtureDatabase,provisionRuntimeBrowserFixture} from './provision-runtime-browser-fixture.mjs';
test('fixture database accepts only confirmed loopback test identities',()=>{
 assert.equal(localFixtureDatabase('postgresql://tester:synthetic@127.0.0.1:5432/charmville_runtime_test','charmville_runtime_test').name,'charmville_runtime_test');
 for(const [url,name] of [
  ['postgresql://db.example/charmville_runtime_test','charmville_runtime_test'],
  ['postgresql://localhost/plankspace','plankspace'],
  ['postgresql://localhost/charmville_live','charmville_live'],
  ['postgresql://localhost/charmville_runtime_test','another_test'],
  ['postgresql://localhost/charmville_runtime_test?host=remote.example','charmville_runtime_test'],
  ['postgresql://localhost/postgres','postgres'],
  ['http://localhost/charmville_runtime_test','charmville_runtime_test'],
 ])assert.throws(()=>localFixtureDatabase(url,name));
});
test('fixture creation requires explicit synthetic permission before DB or file work',async()=>{
 await assert.rejects(provisionRuntimeBrowserFixture({CHARMVILLE_TEST_DATABASE_URL:'postgresql://localhost/charmville_runtime_test',CHARMVILLE_TEST_DATABASE_NAME:'charmville_runtime_test'}),/Explicit synthetic fixture permission/);
});
