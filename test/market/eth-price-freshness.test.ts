import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEthUsdPrice } from '../../lib/eth-price';

test('failed price refreshes do not make an old USD quote look fresh', async () => {
  const originalFetch=globalThis.fetch;
  const state=globalThis as typeof globalThis & {__plankEthUsd?:{usd:number;fetchedAt:number;source:string}};
  const previous=state.__plankEthUsd;
  const fetchedAt=Date.now()-300000;
  state.__plankEthUsd={usd:2500,fetchedAt,source:'coinbase'};
  globalThis.fetch=async()=>{throw new Error('offline');};
  try {
    const quote=await getEthUsdPrice();
    assert.equal(quote.usd,2500);
    assert.ok(quote.ageMs>=300000);
    assert.equal(state.__plankEthUsd.fetchedAt,fetchedAt);
  } finally {globalThis.fetch=originalFetch;state.__plankEthUsd=previous;}
});
