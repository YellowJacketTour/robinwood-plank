import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {assistAvailable,controllerAtEncounter} from '../../lib/charmville/battle-assist';

const encounter={region:'public:meadow',geometry:'authored-r1'};
test('controller must occupy the encounter geometry and range in every direction',()=>{
 for(const [x,y] of [[1.5,9],[6.5,9],[4,6.5],[4,11.5]])assert.equal(controllerAtEncounter({...encounter,x,y},encounter),true);
 for(const [x,y] of [[1.49,9],[6.51,9],[4,6.49],[4,11.51],[6,11],[NaN,9],[4,Infinity]])assert.equal(controllerAtEncounter({...encounter,x,y},encounter),false);
 assert.equal(controllerAtEncounter({...encounter,x:4,y:9,region:'home:2'},encounter),false);
 assert.equal(controllerAtEncounter({...encounter,x:4,y:9,geometry:'authored-r0'},encounter),false);
});

test('assistance recomputes controller placement instead of caching invitation eligibility',async()=>{
 let x=4,geometry=encounter.geometry,present=true;
 const c={query:async(sql:string)=>({rows:sql.includes('to_regclass')?[{present:true}]:present?[{x,y:9,actor_region:encounter.region,actor_geometry:geometry,encounter_region:encounter.region,encounter_geometry:encounter.geometry}]:[]})} as unknown as PoolClient;
 assert.equal(await assistAvailable(c,'encounter','helper','controller'),true);
 x=20;assert.equal(await assistAvailable(c,'encounter','helper','controller'),false);
 x=4;geometry='old-map';assert.equal(await assistAvailable(c,'encounter','helper','controller'),false);
 geometry=encounter.geometry;present=false;assert.equal(await assistAvailable(c,'encounter','helper','controller'),false);
 present=true;assert.equal(await assistAvailable(c,'encounter','helper',null),false);
 assert.equal(await assistAvailable(c,'encounter','helper','controller'),true);
});
