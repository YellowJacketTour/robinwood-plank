import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Public repository metadata only. No artwork is downloaded or published.
const repositories=['pret/pokeemerald','rh-hideout/pokeemerald-expansion','PMDCollab/SpriteCollab','TeamAquasHideout/Team-Aquas-Asset-Repo'];
const api=route=>JSON.parse(execFileSync('gh',['api',route],{encoding:'utf8',maxBuffer:64*1024*1024}));
const sources=[];
for(const repository of repositories){
 const info=api(`repos/${repository}`),commit=api(`repos/${repository}/commits/${info.default_branch}`).sha;
 const tree=api(`repos/${repository}/git/trees/${commit}?recursive=1`),files=tree.tree.filter(entry=>entry.type==='blob');
 const docs=files.filter(entry=>/(^|\/)(license[^/]*|copying[^/]*|credits[^/]*|readme[^/]*)$/i.test(entry.path));
 const rootDocs=docs.filter(entry=>!entry.path.includes('/'));
 const documentPins=[];
 for(const doc of rootDocs.slice(0,8)){
  const url=`https://raw.githubusercontent.com/${repository}/${commit}/${doc.path}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(`Could not read ${repository} documentation`);
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>1024*1024)throw Error('Unexpected documentation size');
  documentPins.push({path:doc.path,gitBlobSha:doc.sha,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,url});
 }
 let topLevelSpriteDirectories=null;
 if(repository==='PMDCollab/SpriteCollab'){
  const root=api(`repos/${repository}/git/trees/${commit}`),sprite=root.tree.find(entry=>entry.path==='sprite');
  if(sprite){const child=api(`repos/${repository}/git/trees/${sprite.sha}`);topLevelSpriteDirectories={count:child.tree.filter(entry=>entry.type==='tree').length,complete:!child.truncated,meaning:'top-level source directories; not a count of complete species animations'};}
 }
 sources.push({repository:`https://github.com/${repository}`,commit,defaultBranch:info.default_branch,treeComplete:!tree.truncated,countInterpretation:tree.truncated?'lower bounds from truncated recursive tree':'exact matching file paths in pinned recursive tree',
  counts:{indexedFiles:files.length,pngFiles:files.filter(entry=>/\.png$/i.test(entry.path)).length,gifFiles:files.filter(entry=>/\.gif$/i.test(entry.path)).length,svgFiles:files.filter(entry=>/\.svg$/i.test(entry.path)).length,itemPngFiles:files.filter(entry=>/(^|\/)items?\//i.test(entry.path)&&/\.png$/i.test(entry.path)).length,animationXmlFiles:files.filter(entry=>/\/AnimData\.xml$/i.test(entry.path)).length,animationSheets:files.filter(entry=>/-Anim\.png$/i.test(entry.path)).length,offsetSheets:files.filter(entry=>/-Offsets\.png$/i.test(entry.path)).length,creditOrLicenseDocuments:docs.length},topLevelSpriteDirectories,documentPins,shippingApproved:false,
  rightsStatus:repository==='PMDCollab/SpriteCollab'?'CC-BY-NC-4.0 submission terms; repository also identifies official Chunsoft sprites; per-file attribution and underlying rights review required':'Repository availability and credits do not establish a blanket right to ship every depicted franchise asset; per-file review required',
  animationStatus:'Source file inventory only; no claim of gameplay move, timing, layering or direction coverage'});
}
const output={schemaVersion:1,observedAt:new Date().toISOString(),scope:'Pinned public repository metadata and documentation fingerprints. No new artwork downloaded.',sources};
const target=path.resolve('docs/charmville-reconstruction/source-evidence/fan-asset-repository-inventory.json');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(sources.map(source=>({repository:source.repository,commit:source.commit,treeComplete:source.treeComplete,counts:source.counts}))));
