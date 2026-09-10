import assert from "node:assert/strict";
import test, { after } from "node:test";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { upsertTrackedCollection } from "../../lib/market/multichain/store";
import { observedFloorChanges24h, floorSubjectKey } from "../../lib/market/multichain/observed-floor-change";

test("floor history compares the same venue/currency and exact current ask across chains, without requiring trades", {skip:!hasPostgresConfig()}, async () => {
  const ids:number[]=[];
  try {
    const subjects=[];
    for(const chainSlug of ["eth-mainnet","solana-mainnet","bitcoin-mainnet"]){
      const collectionKey=`zztest-floor-history-${chainSlug}-${Date.now()}`;
      const id=await upsertTrackedCollection({chainSlug,chainId:null,contractAddress:collectionKey,adapter:"test"});ids.push(id);
      await postgresQuery(`INSERT INTO plank_collection_floor_observations(collection_id,price_atomic,currency,marketplace,source,observed_at,observation_bucket) VALUES
        ($1,100,'NATIVE','venue','test',NOW()-INTERVAL '24 hours 10 minutes',NOW()-INTERVAL '24 hours 10 minutes'),
        ($1,120,'NATIVE','venue','test',NOW(),NOW()),
        ($1,1,'OTHER','venue','test',NOW()-INTERVAL '24 hours 5 minutes',NOW()-INTERVAL '24 hours 5 minutes'),
        ($1,2,'NATIVE','other-venue','test',NOW()-INTERVAL '24 hours 1 minute',NOW()-INTERVAL '24 hours 1 minute')`,[id]);
      subjects.push({chainSlug,collectionKey,marketplace:"venue",currency:"NATIVE",currentPriceAtomic:"120"});
    }
    const result=await observedFloorChanges24h(subjects);
    assert.equal(result.size,3);
    for(const subject of subjects){assert.equal(result.get(floorSubjectKey(subject))?.changePct,20);assert.equal(result.get(floorSubjectKey(subject))?.comparisonPriceAtomic,"100");}
    assert.equal((await observedFloorChanges24h(subjects.map(s=>({...s,currentPriceAtomic:"121"})))).size,0,"mismatched current snapshot cannot claim a change");
    await postgresQuery(`UPDATE plank_collection_floor_observations SET observed_at=NOW()-INTERVAL '3 hours' WHERE collection_id=ANY($1::bigint[]) AND price_atomic=120`,[ids]);
    assert.equal((await observedFloorChanges24h(subjects)).size,0,"stale current observations cannot claim a current 24h change");
  } finally {
    await postgresQuery(`DELETE FROM plank_collection_floor_observations WHERE collection_id=ANY($1::bigint[])`,[ids]);
    await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=ANY($1::bigint[])`,[ids]);
  }
});

after(closePostgres);
