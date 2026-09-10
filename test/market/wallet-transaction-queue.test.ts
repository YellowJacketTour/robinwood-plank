import test from 'node:test';
import assert from 'node:assert/strict';
import {queueWalletTransactions} from '../../public/arcade/wallet-transaction-queue.js';
test('wallet sends and pending nonce allocation are serialized through inclusion',async()=>{
 let pending=0n,active=0,maxActive=0;
 const observed:bigint[]=[];
 const provider={getNetwork:async()=>({chainId:31337n}),send:async()=>`0x${pending.toString(16)}`};
 const wallet={address:'0xabc',sendTransaction:async({nonce}:any)=>{active++;maxActive=Math.max(maxActive,active);observed.push(nonce);pending++;return{wait:async()=>{await new Promise(r=>setTimeout(r,10));active--;}};}};
 queueWalletTransactions(wallet,provider,null);
 await Promise.all([wallet.sendTransaction({}),wallet.sendTransaction({}),wallet.sendTransaction({})]);
 assert.deepEqual(observed,[0n,1n,2n]);assert.equal(maxActive,1);
});
test('failed estimation releases the queue without reserving a nonce',async()=>{
 let calls=0;
 const provider={getNetwork:async()=>({chainId:31337n}),send:async()=>'0x7'};
 const wallet={address:'0xabc',sendTransaction:async({nonce}:any)=>{assert.equal(nonce,7n);if(calls++===0)throw new Error('estimate rejected');return{wait:async()=>{}};}};
 queueWalletTransactions(wallet,provider,null);
 await assert.rejects(wallet.sendTransaction({}),/estimate rejected/);
 await wallet.sendTransaction({});assert.equal(calls,2);
});
