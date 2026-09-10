/** Read-only evidence collector. Does not deploy, bet, change clocks, or invent
 * outage drills. A dedicated evidence key signs the report, never transactions.
 * Run after a real-beacon testnet deployment and a separately recorded drill. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Contract,JsonRpcProvider,Wallet,getBytes,Interface} from 'ethers';
import {releaseSnapshot} from './lib/plankcrash-release-binding.js';
import {EVMNET_HASH,SETTLED_EVENT,assertRuntime,validateRealSoak,verifyRealSoakOnChain} from './lib/plankcrash-real-soak-validation.js';
import {canonicalJson,sha256Hex} from './lib/testnet-canary-evidence.js';
const required=(key:string)=>{const v=process.env[key]?.trim();if(!v)throw new Error(`${key} is required`);return v;};
const rpc=new JsonRpcProvider(required('PLANKCRASH_TESTNET_RPC_URL'));
if((await rpc.getNetwork()).chainId!==46630n)throw new Error('Only public Robinhood testnet is supported');
const crashAddress=required('PLANKCRASH_SOAK_CRASH');
const crashContract=required('PLANKCRASH_SOAK_CONTRACT');
if(!['PlankGuardedCrash','PlankCrash','PlankScalableCrash'].includes(crashContract))throw new Error('unsupported crash contract');
const crash=new Contract(crashAddress,['function beacon() view returns(address)'],rpc);
const beacon=await crash.beacon();
const beaconCodeHash=await assertRuntime(rpc,beacon,'DrandBeacon'); // a mock fails here
const crashCodeHash=await assertRuntime(rpc,crashAddress,crashContract);
const from=Number(required('PLANKCRASH_SOAK_FROM_BLOCK')),to=(await rpc.getBlockNumber())-20;
if(!Number.isSafeInteger(from)||from<1||from>to)throw new Error('invalid initial block');
const iface=new Interface([SETTLED_EVENT]),topic=iface.getEvent('RoundSettled')!.topicHash;
const rounds=[];
for(let cursor=from;cursor<=to;cursor+=1000){
 const logs=await rpc.getLogs({address:crashAddress,topics:[topic],fromBlock:cursor,toBlock:Math.min(cursor+999,to)});
 for(const log of logs){
  const parsed=iface.parseLog(log)!,block=await rpc.getBlock(log.blockNumber),receipt=await rpc.getTransactionReceipt(log.transactionHash);
  if(!block||receipt?.status!==1)throw new Error('missing canonical settlement');
  rounds.push({roundId:parsed.args.roundId.toString(),transactionHash:log.transactionHash,blockHash:log.blockHash,blockNumber:log.blockNumber,timestamp:block.timestamp,receiptStatus:receipt.status});
 }
}
const drillContents=await readFile(required('PLANKCRASH_INCIDENT_DRILL_REPORT_PATH'));
const drill=JSON.parse(drillContents.toString());
// These are reviewed incident observations, not facts inferred from settlement logs.
const unsigned={schema:'plankcrash.real-testnet-soak.v2',chainId:46630,mode:'observed-public-network',generatedAt:new Date().toISOString(),
 sourceFingerprint:(await releaseSnapshot()).sourceFingerprint,crash:crashAddress,crashContract,crashCodeHash,beacon,beaconCodeHash,
 beaconChainHash:EVMNET_HASH,mockBeacon:false,rounds,drills:drill.drills,drillReportSha256:createHash('sha256').update(drillContents).digest('hex')};
const signer=new Wallet(required('PLANKCRASH_EVIDENCE_SIGNING_KEY'));
const payloadSha256=sha256Hex(canonicalJson(unsigned));
const signed={...unsigned,payloadSha256,signature:await signer.signMessage(getBytes(payloadSha256))};
const errors=validateRealSoak(signed,required('CANARY_EXPECTED_SIGNER'),unsigned.sourceFingerprint);
if(errors.length)throw new Error(errors.join('; '));
await verifyRealSoakOnChain(signed,rpc);
await writeFile(required('PLANKCRASH_REAL_BEACON_SOAK_PATH'),JSON.stringify(signed,null,2)+'\n',{flag:'wx'});
process.stdout.write(`Verified ${rounds.length} public testnet settlements. Evidence written.\n`);
