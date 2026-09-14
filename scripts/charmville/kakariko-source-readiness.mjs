#!/usr/bin/env node
// Read-only input audit. Never searches personal folders, downloads a ROM or admits a scene.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.argv[2]||'../charmville-references/zelda3');
const expectedRevision='fbbb3f967a51fafe642e6140d0753979e73b4090';
async function exists(relative){try{return (await stat(path.join(root,relative))).isFile();}catch{return false;}}
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const tables=await readFile(path.join(root,'assets/tables.py'),'utf8');
const areas=[...tables.matchAll(/LW\s+(\d+)\s*:\s*(Kakariko (?:NW|NE|SW|SE))/g)].map(m=>({sourceArea:Number(m[1]),name:m[2]}));
const inputs={rom:await exists('zelda3.sfc'),compiledAssets:await exists('zelda3_assets.dat'),villageAreaHeadYaml:await exists('assets/overworld/overworld-24.yaml')};
const blockers=[];
if(revision!==expectedRevision)blockers.push('Source revision changed; re-audit decoder and coordinate semantics.');
if(areas.length!==4)blockers.push('Source table does not identify all four expected village quadrants.');
if(!inputs.rom&&!inputs.compiledAssets)blockers.push('No source resource package found at documented input paths.');
if(!inputs.villageAreaHeadYaml)blockers.push('No decoded area-head metadata found at the documented output path.');
blockers.push('Rendered artwork, collision semantics, entrances, service bindings and redistribution provenance require acceptance.');
console.log(JSON.stringify({schemaVersion:1,source:'https://github.com/snesrev/zelda3',revision,expectedRevision,areas,inputs,readyForSceneAdmission:false,blockers,notPerformed:['ROM search outside the named checkout','resource download','native quest modification','travel admission','account changes']},null,2));
