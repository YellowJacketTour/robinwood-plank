import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,getBytes} from 'ethers';
import {EVMNET_HASH,validateRealSoak} from '../../scripts/lib/plankcrash-real-soak-validation.js';
import {canonicalJson,sha256Hex} from '../../scripts/lib/testnet-canary-evidence.js';
const signer=Wallet.createRandom(),now=Date.now(),source='0x'+'a'.repeat(64);
async function evidence(change:Record<string,unknown>={}){
 const unsigned={schema:'plankcrash.real-testnet-soak.v2',chainId:46630,mode:'observed-public-network',sourceFingerprint:source,beaconChainHash:EVMNET_HASH,mockBeacon:false,beaconCodeHash:'0x'+'b'.repeat(64),
  rounds:Array.from({length:101},(_,i)=>({roundId:String(i+1),transactionHash:'0x'+(i+1).toString(16).padStart(64,'0'),blockHash:'0x'+'c'.repeat(64),receiptStatus:1,blockNumber:i+1,timestamp:Math.floor(now/1000)-86400+i*864})),
  drillReportSha256:'d'.repeat(64),drills:Object.fromEntries(['withdrawal','freeze-recovery','reconnect','relay-outage','congestion'].map(k=>[k,true])),...change};
 const payloadSha256=sha256Hex(canonicalJson(unsigned));return {...unsigned,payloadSha256,signature:await signer.signMessage(getBytes(payloadSha256))};
}
test('accepts authenticated coverage, separately from required on-chain re-verification',async()=>{
 assert.deepEqual(validateRealSoak(await evidence(),signer.address,source,now),[]);
});
test('rejects local, mock, stale-source, abbreviated and unauthenticated evidence',async()=>{
 for(const change of [{chainId:31337},{mockBeacon:true},{sourceFingerprint:'0x'+'f'.repeat(64)},{rounds:[]},{drills:{}},{beaconChainHash:'0x'+'0'.repeat(64)}])assert.ok(validateRealSoak(await evidence(change),signer.address,source,now).length);
 const valid=await evidence();assert.ok(validateRealSoak({...valid,mode:'tampered'},signer.address,source,now).some(e=>e.includes('signature')));
 const repeated=valid.rounds.map(r=>({...r,transactionHash:valid.rounds[0].transactionHash}));
 assert.ok(validateRealSoak(await evidence({rounds:repeated}),signer.address,source,now).some(e=>e.includes('reused')));
 assert.ok(validateRealSoak(valid,Wallet.createRandom().address,source,now).some(e=>e.includes('signature')));
});
