import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateCanary } from "./lib/plankcrash-canary-validation.js";
import {deploymentOverrides,releaseDigest,releaseSnapshot,validateReleaseBinding} from './lib/plankcrash-release-binding.js';
import {validateRealSoak,verifyRealSoakOnChain} from './lib/plankcrash-real-soak-validation.js';
import {JsonRpcProvider} from 'ethers';

const required = {
  PLANKCRASH_EXTERNAL_CONTRACT_AUDIT_SHA256: /^[0-9a-f]{64}$/,
  PLANKCRASH_EXTERNAL_MATH_REVIEW_SHA256: /^[0-9a-f]{64}$/,
  PLANKCRASH_LEGAL_APPROVAL_REFERENCE: /^.{8,200}$/,
  PLANKCRASH_INCIDENT_DRILL_REFERENCE: /^.{8,200}$/,
  PLANKCRASH_BUG_BOUNTY_REFERENCE: /^.{8,200}$/,
};
const blockers: string[] = [];
// This register is source-bound with the review. Missing external documents
// must not be the only reason a candidate with a reproduced exploit is blocked.
try {
  const register=JSON.parse(await readFile('docs/marketplank/OPEN-SECURITY-FINDINGS.json','utf8'));
  if(register.schema!=='plankcrash.open-findings.v1'||!Array.isArray(register.findings))throw new Error('invalid findings register');
  for(const finding of register.findings){
    if(typeof finding.id!=='string'||typeof finding.status!=='string'||typeof finding.blocking!=='boolean')throw new Error('invalid finding');
    if(finding.blocking&&finding.status!=='resolved')blockers.push(`Open security finding ${finding.id}: ${finding.summary}`);
  }
} catch { blockers.push('security findings register is missing or invalid'); }

let sourceFingerprint='';
try{
  sourceFingerprint=(await releaseSnapshot()).sourceFingerprint;
  const config=JSON.parse(await readFile(process.env.PLANKCRASH_RELEASE_CONFIG_PATH?.trim()||'','utf8'));
  if(releaseDigest(config)!==releaseDigest(await deploymentOverrides()))blockers.push('release configuration does not match current deployment overrides');
  const review=JSON.parse(await readFile(process.env.PLANKCRASH_REVIEW_BINDING_PATH?.trim()||'','utf8'));
  blockers.push(...validateReleaseBinding(review,sourceFingerprint,config));
  if(review.contractAuditSha256!==process.env.PLANKCRASH_EXTERNAL_CONTRACT_AUDIT_SHA256||review.mathReviewSha256!==process.env.PLANKCRASH_EXTERNAL_MATH_REVIEW_SHA256)blockers.push('review binding does not reference the supplied independent reviews');
}catch(error){blockers.push(`release source/config binding failed: ${error instanceof Error?error.message:String(error)}`);}
try{
  const soak=JSON.parse(await readFile(process.env.PLANKCRASH_REAL_BEACON_SOAK_PATH?.trim()||'','utf8'));
  const soakErrors=validateRealSoak(soak,process.env.CANARY_EXPECTED_SIGNER?.trim()||'',sourceFingerprint);
  blockers.push(...soakErrors);
  if(!soakErrors.length){
    const rpc=process.env.PLANKCRASH_TESTNET_RPC_URL?.trim();
    if(!rpc)blockers.push('public testnet RPC is required to reverify soak receipts');
    else await verifyRealSoakOnChain(soak,new JsonRpcProvider(rpc));
  }
  const drill=await readFile(process.env.PLANKCRASH_INCIDENT_DRILL_REPORT_PATH?.trim()||'');
  if(createHash('sha256').update(drill).digest('hex')!==soak.drillReportSha256)blockers.push('incident drill report does not match real-beacon evidence');
}catch(error){blockers.push(`real-beacon public-testnet soak verification failed: ${error instanceof Error?error.message:String(error)}`);}
for (const [key, pattern] of Object.entries(required)) {
  if (!pattern.test(process.env[key]?.trim() || "")) blockers.push(`${key} is absent or malformed`);
}
for (const prefix of ["PLANKCRASH_EXTERNAL_CONTRACT_AUDIT", "PLANKCRASH_EXTERNAL_MATH_REVIEW"]) {
  try {
    const contents = await readFile(process.env[`${prefix}_PATH`]?.trim() || "");
    if (!contents.length || createHash("sha256").update(contents).digest("hex") !== process.env[`${prefix}_SHA256`]?.trim()) blockers.push(`${prefix} document does not match its digest`);
  } catch { blockers.push(`${prefix}_PATH is absent or unreadable`); }
}
const canaryPath = process.env.PLANKCRASH_TESTNET_CANARY_PATH?.trim();
if (!canaryPath) blockers.push("PLANKCRASH_TESTNET_CANARY_PATH is absent");
else {
  try {
    const canary = JSON.parse(await readFile(canaryPath, "utf8"));
    blockers.push(...validateCanary(canary, process.env.CANARY_EXPECTED_SIGNER?.trim() || ""));
  } catch (error) {
    blockers.push(`testnet canary is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = { schema: "plankcrash.mainnet-launch-gate.v2", sourceFingerprint, passed: blockers.length === 0, blockers };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (blockers.length) process.exitCode = 1;

