import {getBytes,verifyMessage,Contract,JsonRpcProvider,keccak256,Interface} from 'ethers';
import {readFile} from 'node:fs/promises';
import {canonicalJson,sha256Hex} from './testnet-canary-evidence.js';
export const EVMNET_HASH='0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
const hash=/^0x[0-9a-fA-F]{64}$/;
/** Authentication and coverage, not an assertion that self-reported drills happened.
 * The release gate separately requires the independently reviewed drill report. */
export function validateRealSoak(value:any,signer:string,sourceFingerprint:string,now=Date.now()):string[]{
 if(!value||typeof value!=='object')return ['real-beacon soak is absent'];
 const errors:string[]=[];
 if(value.schema!=='plankcrash.real-testnet-soak.v2'||value.chainId!==46630||value.mode!=='observed-public-network')errors.push('real-beacon soak must be public testnet, not a local simulation');
 if(value.sourceFingerprint!==sourceFingerprint)errors.push('real-beacon soak source differs from release');
 if(value.beaconChainHash!==EVMNET_HASH||value.mockBeacon!==false||!hash.test(value.beaconCodeHash))errors.push('real-beacon soak has no pinned real beacon');
 if(!Array.isArray(value.rounds)||value.rounds.length<100)errors.push('real-beacon soak needs at least 100 settled rounds');
 const rounds=Array.isArray(value.rounds)?value.rounds:[];
 const ids=new Set(),txs=new Set();
 for(const r of rounds){
  if(!r||!/^[1-9][0-9]*$/.test(r.roundId)||ids.has(r.roundId)||txs.has(r.transactionHash)||!hash.test(r.transactionHash)||!hash.test(r.blockHash)||r.receiptStatus!==1||!Number.isSafeInteger(r.timestamp)||r.timestamp<=0||!Number.isSafeInteger(r.blockNumber)||r.blockNumber<=0)errors.push('invalid or reused real-beacon round evidence');
  if(r){ids.add(r.roundId);txs.add(r.transactionHash);}
 }
 const times=rounds.map((r:any)=>Number(r?.timestamp)*1000);
 const first=Math.min(...times),last=Math.max(...times);
 if(!Number.isFinite(first)||!Number.isFinite(last)||last-first<86400000||last>now+60000||now-last>7*86400000)errors.push('real-beacon soak needs 24 hours of settlements, ending within seven days');
 for(const operation of ['withdrawal','freeze-recovery','reconnect','relay-outage','congestion'])if(!value.drillReportSha256||!/^[0-9a-f]{64}$/.test(value.drillReportSha256)||value.drills?.[operation]!==true)errors.push(`real-beacon drill ${operation} missing`);
 try{
  const {payloadSha256,signature,...unsigned}=value;
  if(!/^0x[0-9a-fA-F]{40}$/.test(signer)||payloadSha256!==sha256Hex(canonicalJson(unsigned))||verifyMessage(getBytes(payloadSha256),signature).toLowerCase()!==signer.toLowerCase())throw new Error();
 }catch{errors.push('real-beacon soak signature mismatch');}
 return errors;
}

export const SETTLED_EVENT='event RoundSettled(uint256 indexed roundId,uint256 crashBps,uint256 effectiveRakeBps,uint256 grossRake,uint256 keeperReward,uint256 totalPlayerPaid,uint256 totalBonus,uint256 houseReturned,uint256 bustedToReserve,uint8 mode)';
export async function assertRuntime(provider:JsonRpcProvider,address:string,name:string){
 const artifact=JSON.parse(await readFile(`.hardhat-artifacts/contracts/${name}.sol/${name}.json`,'utf8'));
 const actual=await provider.getCode(address);
 const normalize=(code:string)=>{
  const bytes=getBytes(code);
  for(const refs of Object.values(artifact.immutableReferences) as {start:number;length:number}[][])for(const ref of refs)bytes.fill(0,ref.start,ref.start+ref.length);
  return keccak256(bytes);
 };
 if(actual==='0x'||normalize(actual)!==normalize(artifact.deployedBytecode))throw new Error(`${name} runtime does not match reviewed compiler output`);
 return keccak256(actual);
}
/** Re-fetch receipts and canonical blocks; signed invented receipts cannot pass. */
export async function verifyRealSoakOnChain(value:any,provider:JsonRpcProvider){
 if((await provider.getNetwork()).chainId!==46630n)throw new Error('soak RPC is not Robinhood testnet');
 const actual=await assertRuntime(provider,value.beacon,'DrandBeacon');
 if(actual!==value.beaconCodeHash)throw new Error('beacon runtime changed');
 if(!['PlankGuardedCrash','PlankCrash','PlankScalableCrash'].includes(value.crashContract))throw new Error('unsupported crash contract');
 const crashHash=await assertRuntime(provider,value.crash,value.crashContract);
 if(crashHash!==value.crashCodeHash)throw new Error('crash runtime changed');
 const beacon=new Contract(value.beacon,['function chainHash() view returns(bytes32)','function period() view returns(uint256)','function genesisTimestamp() view returns(uint256)','function getPublicKey() view returns(uint256[4])','function domain() view returns(bytes)','function randomnessOrZero(uint64) view returns(bytes32)'],provider);
 const fixture=JSON.parse(await readFile('test/contracts/fixtures/drand-round.json','utf8'));
 if(await beacon.chainHash()!==EVMNET_HASH||await beacon.period()!==3n||await beacon.genesisTimestamp()!==1727521075n||JSON.stringify((await beacon.getPublicKey()).map(String))!==JSON.stringify(fixture.publicKey)||await beacon.domain()!==`0x${Buffer.from(fixture.domain).toString('hex')}`)throw new Error('beacon parameters do not match pinned evmnet');
 const crash=new Contract(value.crash,['function beacon() view returns(address)'],provider);
 if((await crash.beacon()).toLowerCase()!==value.beacon.toLowerCase())throw new Error('crash/beacon wiring mismatch');
 const iface=new Interface([SETTLED_EVENT]);
 const latest=await provider.getBlockNumber();
 for(const round of value.rounds){
  const receipt=await provider.getTransactionReceipt(round.transactionHash),block=await provider.getBlock(round.blockNumber);
  if(!receipt||!block||receipt.status!==1||receipt.blockHash!==round.blockHash||block.hash!==round.blockHash||block.timestamp!==round.timestamp||receipt.blockNumber!==round.blockNumber||latest-round.blockNumber<20)throw new Error('unconfirmed or noncanonical soak receipt');
  if(!receipt.logs.some(log=>{try{return log.address.toLowerCase()===value.crash.toLowerCase()&&iface.parseLog(log)?.args.roundId.toString()===round.roundId;}catch{return false;}}))throw new Error('receipt has no matching crash settlement');
 }
}
