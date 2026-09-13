import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const GLOBAL_IDS=Array.from({length:25},(_,i)=>`GLOBAL-${String(i+1).padStart(2,'0')}`);
export const RETAINED_ID='RETAINED-VISION';
const states=new Set(['planned','implementing','blocked','verifying','accepted']);
const text=value=>typeof value==='string'&&value.trim().length>0;
const retainedSources=['USER-INTENT.md','WORLD-MASTER-SPEC.md','REQUIREMENT-COVERAGE-AUDIT.md'].map(name=>`docs/charmville-reconstruction/${name}`);

/** Metadata validation is not gameplay acceptance. A reviewer must inspect and
 * reproduce evidence; this checker cannot establish quality or honest results. */
export async function validateCompletion({root,ledger,contract,requireComplete=false}) {
 const errors=[];const counts={planned:0,implementing:0,blocked:0,verifying:0,accepted:0};
 const contractIds=[...contract.matchAll(/^\|\s*(GLOBAL-\d+)\s*\|/gm)].map(match=>match[1]);
 for(const id of GLOBAL_IDS)if(contractIds.filter(value=>value===id).length!==1)errors.push(`Contract must retain exactly one ${id}`);
 for(const id of contractIds)if(!GLOBAL_IDS.includes(id))errors.push(`Unknown contract gate ${id}; update the checker explicitly before extending acceptance`);
 if(ledger?.schemaVersion!==1)errors.push('Unsupported or missing ledger schemaVersion');
 const gates=Array.isArray(ledger?.gates)?ledger.gates:[];
 const ids=[...GLOBAL_IDS,RETAINED_ID];
 for(const id of ids)if(gates.filter(g=>g?.id===id).length!==1)errors.push(`Ledger must retain exactly one ${id}`);
 const canonicalRoot=await realpath(root);
 const checkRef=async(ref,label)=>{
  if(!text(ref)||isAbsolute(ref)||ref.includes('\\')||ref.split('/').includes('..')){errors.push(`${label}: expected repository-relative file reference`);return;}
  try{
   const path=await realpath(resolve(root,ref));const rel=relative(canonicalRoot,path);
   if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||!(await stat(path)).isFile())throw Error('outside repository or not a file');
  }catch{errors.push(`${label}: missing or unsafe file ${ref}`);}
 };
 for(const gate of gates){
  if(!ids.includes(gate?.id)){errors.push(`Unknown ledger gate ${gate?.id}`);continue;}
  const label=gate.id;
  if(!states.has(gate.status))errors.push(`${label}: invalid status`);else counts[gate.status]++;
  if(!text(gate.title)||!text(gate.remaining))errors.push(`${label}: title and remaining limitations must be explicit`);
  if(!Array.isArray(gate.references)||!gate.references.length)errors.push(`${label}: missing source references`);
  else for(const ref of gate.references)await checkRef(ref,label);
  if(label===RETAINED_ID)for(const ref of retainedSources)if(!Array.isArray(gate.references)||!gate.references.includes(ref))errors.push(`${label}: cannot omit prior scope source ${ref}`);
  if(!Array.isArray(gate.evidence))errors.push(`${label}: evidence must be an array`);
  else for(const [index,evidence] of gate.evidence.entries()){
   const item=`${label} evidence ${index+1}`;
   for(const key of ['implementationRef','artifactRef'])await checkRef(evidence?.[key],`${item} ${key}`);
   for(const key of ['version','procedure','environment','limitations','reviewedBy'])if(!text(evidence?.[key]))errors.push(`${item}: missing ${key}`);
   if(!text(evidence?.reviewedAt)||!Number.isFinite(Date.parse(evidence.reviewedAt)))errors.push(`${item}: invalid reviewedAt`);
   if(!['passed','failed','partial'].includes(evidence?.result))errors.push(`${item}: invalid result`);
  }
  if(gate.status==='accepted'){
   if(!Array.isArray(gate.evidence)||!gate.evidence.length||gate.evidence.some(e=>e?.result!=='passed'))errors.push(`${label}: accepted requires reviewed passing evidence`);
   if(label===RETAINED_ID&&!text(gate.scopeReconciliation))errors.push(`${label}: acceptance requires explicit reconciliation of all retained requirements`);
  }
  if(requireComplete&&gate.status!=='accepted')errors.push(`${label}: ${gate.status}; completion is not established`);
 }
 return {ok:errors.length===0,errors,counts};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.some(arg=>!['--check','--require-complete'].includes(arg))){console.error('Usage: node scripts/charmville/check-completion.mjs [--check] [--require-complete]');process.exitCode=2;}
 else try{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const dir='docs/charmville-reconstruction/';
  const ledger=JSON.parse(await readFile(resolve(root,dir+'completion-gates.json'),'utf8'));
  const contract=await readFile(resolve(root,dir+'APPROVED-GLOBAL-COMPLETION-CONTRACT.md'),'utf8');
  const result=await validateCompletion({root,ledger,contract,requireComplete:args.includes('--require-complete')});
  console.log(JSON.stringify({validation:result.ok?'passed':'failed',...result.counts,note:'Metadata checks do not certify gameplay quality or completeness.'},null,2));
  for(const error of result.errors)console.error(error);
  if(!result.ok)process.exitCode=1;
 }catch(error){console.error(`Completion check failed: ${error.message}`);process.exitCode=1;}
}
