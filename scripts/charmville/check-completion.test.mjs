import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {validateCompletion} from './check-completion.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=new URL('../../docs/charmville-reconstruction/',import.meta.url);
const ledger=JSON.parse(await readFile(new URL('completion-gates.json',dir),'utf8'));
const contract=await readFile(new URL('APPROVED-GLOBAL-COMPLETION-CONTRACT.md',dir),'utf8');
const copy=()=>structuredClone(ledger);

test('current ledger is structurally valid but cannot declare completion',async()=>{
 assert.equal((await validateCompletion({root,ledger,contract})).ok,true);
 const result=await validateCompletion({root,ledger,contract,requireComplete:true});
 assert.equal(result.ok,false);assert.equal(result.counts.accepted,0);
 assert.equal(result.errors.filter(e=>e.includes('completion is not established')).length,26);
});
test('removing a gate from both contract and ledger cannot shrink approved scope',async()=>{
 const changed=copy();changed.gates=changed.gates.filter(g=>g.id!=='GLOBAL-04');
 const result=await validateCompletion({root,ledger:changed,contract:contract.replace(/^\| GLOBAL-04.*$/m,'')});
 assert.ok(result.errors.some(e=>e.includes('Contract must retain exactly one GLOBAL-04')));
 assert.ok(result.errors.some(e=>e.includes('Ledger must retain exactly one GLOBAL-04')));
});
test('duplicate gates and lost retained scope sources fail closed',async()=>{
 const changed=copy();changed.gates.push(changed.gates[0]);changed.gates.find(g=>g.id==='RETAINED-VISION').references=[];
 const result=await validateCompletion({root,ledger:changed,contract});
 assert.ok(result.errors.some(e=>e.includes('exactly one GLOBAL-01')));
 assert.equal(result.errors.filter(e=>e.includes('cannot omit prior scope source')).length,3);
});
test('accepted gates require passing reviewed evidence and safe existing files',async()=>{
 const changed=copy();changed.gates[0].status='accepted';
 let result=await validateCompletion({root,ledger:changed,contract});
 assert.ok(result.errors.some(e=>e.includes('accepted requires reviewed passing evidence')));
 changed.gates[0].evidence=[{implementationRef:'../outside',artifactRef:'does-not-exist',result:'passed'}];
 result=await validateCompletion({root,ledger:changed,contract});
 assert.ok(result.errors.some(e=>e.includes('repository-relative file reference')));
 assert.ok(result.errors.some(e=>e.includes('missing or unsafe file')));
 assert.ok(result.errors.some(e=>e.includes('missing reviewedBy')));
});
