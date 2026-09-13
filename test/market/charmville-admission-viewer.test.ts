import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {requireCharmvilleViewer} from '../../lib/charmville/admission-viewer';

test('private reads reject anonymous and expired sessions before returning data',async()=>{
 const previous=process.env.CHARMVILLE_ACCESS_MODE;
 process.env.CHARMVILLE_ACCESS_MODE='private';
 let queries=0;
 const db={query:async()=>{queries++;return {rows:[]};}} as unknown as Pool;
 try {
  await assert.rejects(requireCharmvilleViewer(db,''),{status:401});
  assert.equal(queries,0);
  await assert.rejects(requireCharmvilleViewer(db,'a'.repeat(64)),{status:401});
  assert.equal(queries,1);
 } finally {if(previous===undefined)delete process.env.CHARMVILLE_ACCESS_MODE;else process.env.CHARMVILLE_ACCESS_MODE=previous;}
});

test('closed private reads fail before accessing database',async()=>{
 const previous=process.env.CHARMVILLE_ACCESS_MODE;
 process.env.CHARMVILLE_ACCESS_MODE='disabled';
 const db={query:async()=>assert.fail('closed deployment must not query')} as unknown as Pool;
 try {await assert.rejects(requireCharmvilleViewer(db,'a'.repeat(64)),{status:403});}
 finally {if(previous===undefined)delete process.env.CHARMVILLE_ACCESS_MODE;else process.env.CHARMVILLE_ACCESS_MODE=previous;}
});
