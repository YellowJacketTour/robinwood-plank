import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {canonicalJson,sha256Hex} from './testnet-canary-evidence.js';

export const releaseDigest=(value:unknown)=>sha256Hex(canonicalJson(value));
export async function deploymentOverrides(env:NodeJS.ProcessEnv=process.env){
 const source=await readFile('scripts/deploy-casino.ts','utf8');
 // Only public deployment inputs consumed by this script; never serialize keys.
 const keys=new Set([...source.matchAll(/(?:envBig|envNum|required)\("(CASINO_[A-Z0-9_]+)"/g)].map(m=>m[1]));
 for(const m of source.matchAll(/process\.env\.(CASINO_[A-Z0-9_]+)/g))keys.add(m[1]);
 return {schema:'plankcrash.deployment-overrides.v1',chainId:4663,environment:Object.fromEntries([...keys].sort().map(key=>[key,env[key]?.trim()||null]))};
}
const contracts=['PlankGuardedCrash','PlankCycleLottery','PlankCrash','PlankScalableCrash','PlankNumberedLottery','PlankLottery','PlankBank','PlankRakeRouter','PlankBurnEngine','PlankV2TwapOracle','DrandBeacon'];
/** Bind current source, dependencies and checked compiler inputs to bytecode.
 * Timestamp and Git dirty labels are deliberately outside the stable digest. */
export async function releaseSnapshot(){
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--',
  'contracts','test/contracts','lib/casino','public/arcade','test/market/*plankcrash*','test/market/*casino*','test/market/live-lock-policy.test.ts','test/market/public-round-clock.test.ts','test/market/wallet-transaction-queue.test.ts','test/market/lottery-physics-cadence.test.ts','test/market/lottery-population.test.ts','test/market/target-input.test.ts','test/market/settled-return.test.ts','test/market/lottery-player-odds.test.ts',
  'scripts/*casino*','scripts/*plankcrash*','scripts/lib/plankcrash*','scripts/lib/testnet-canary-evidence.ts',
  'scripts/relay-drand.ts','scripts/check-safety-console.mjs','docs/marketplank/SAFETY-AUDITOR-HANDOFF.md','scripts/check-public-game-loop.mjs','scripts/check-shared-lottery.mjs','scripts/check-lottery-collection-fixture.mjs','scripts/check-arcade-refinement.mjs','scripts/check-pocket-controls.mjs','scripts/check-lottery-physics.mjs','scripts/check-lottery-visual.mjs','scripts/research/plankcrash*','docs/marketplank/INDEXED-CAPPED-POOL-REVIEW.md','docs/marketplank/LIVE-LOCK-DESIGN.md','docs/marketplank/REWARD-SUBSIDY-BOUNDARY.md','docs/marketplank/FUNDED-CYCLE-FUNDING.md','hardhat.config.ts','package.json','package-lock.json'],{encoding:'utf8'})
  .split(/\r?\n/).filter(Boolean);
 // The candidate is a dirty working tree: bind every changed tracked file
 // and every nonignored new file so the auditor overlay cannot omit a changed
 // helper, application test, ABI exporter or deployment dependency.
 paths.push(...execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean));
 paths.push(...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean));
 const files=await Promise.all([...new Set(paths)].sort().map(async file=>({file,sha256:sha256Hex(await readFile(file))})));
 const artifacts=[];
 for(const name of contracts){
  const artifact=JSON.parse(await readFile(`.hardhat-artifacts/contracts/${name}.sol/${name}.json`,'utf8'));
  const build=JSON.parse(await readFile(`.hardhat-artifacts/build-info/${artifact.buildInfoId}.json`,'utf8'));
  const output=JSON.parse(await readFile(`.hardhat-artifacts/build-info/${artifact.buildInfoId}.output.json`,'utf8'));
  for(const [source,entry] of Object.entries(build.input.sources) as [string,{content:string}][]){
   const file=source.startsWith('project/')?source.slice(8):source.replace(/^npm\/(.+)@[^/]+\/(.+)$/,'node_modules/$1/$2');
   if(await readFile(file,'utf8')!==entry.content)throw new Error(`Stale compiler input for ${name}: ${file}`);
  }
  const compiled=output.output.contracts[artifact.inputSourceName][name];
  if(artifact.bytecode!==`0x${compiled.evm.bytecode.object}`||artifact.deployedBytecode!==`0x${compiled.evm.deployedBytecode.object}`)throw new Error(`Artifact/build mismatch: ${name}`);
  artifacts.push({name,compiler:build.solcLongVersion,settings:build.input.settings,
   compilerInputSha256:releaseDigest(build.input),abiSha256:releaseDigest(artifact.abi),
   bytecodeSha256:sha256Hex(artifact.bytecode),runtimeTemplateSha256:sha256Hex(artifact.deployedBytecode),runtimeBytes:(artifact.deployedBytecode.length-2)/2});
 }
 const binding={files,artifacts};
 return {schema:'plankcrash.release-source.v1',...binding,sourceFingerprint:releaseDigest(binding)};
}

export function validateReleaseBinding(review:unknown,sourceFingerprint:string,config:unknown):string[]{
 const value=review as Record<string,unknown>|null;
 if(!value||typeof value!=='object')return ['release binding must be an object'];
 const errors=[];
 if(value.schema!=='plankcrash.review-binding.v1')errors.push('release binding schema mismatch');
 if(value.sourceFingerprint!==sourceFingerprint)errors.push('review does not bind current source and compiled artifacts');
 if(value.configFingerprint!==releaseDigest(config))errors.push('review does not bind the deployment configuration');
 for(const field of ['contractAuditSha256','mathReviewSha256'])if(!/^[0-9a-f]{64}$/.test(String(value[field])))errors.push(`release binding ${field} missing`);
 return errors;
}
