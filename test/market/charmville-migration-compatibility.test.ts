import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
test('Charmville trigger migrations retain PostgreSQL 9.6 compatible invocation syntax',()=>{
 const root=join(process.cwd(),'deploy/inmotion/postgres/migrations');
 let triggers=0;
 for(const file of readdirSync(root).filter(name=>/^\d+_charmville_.*\.sql$/.test(name))) {
  const sql=readFileSync(join(root,file),'utf8');
  assert.doesNotMatch(sql,/\bEXECUTE\s+FUNCTION\b/i,file);
  triggers+=(sql.match(/\bEXECUTE\s+PROCEDURE\s+charmville_/gi)||[]).length;
 }
 assert.equal(triggers,3);
});
