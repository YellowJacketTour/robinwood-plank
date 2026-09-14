import {readFile, realpath, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from([137,80,78,71,13,10,26,10]);
const sourceUrls={pokeemerald:'https://github.com/pret/pokeemerald','solarus-zsdx':'https://gitlab.com/solarus-games/games/zsdx'};
function relativeFile(value){return typeof value==='string'&&/^[a-zA-Z0-9_./-]+$/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');}
function frameLayout(item){return Array.isArray(item.directions)?item.directions:[];}

/** Content-addressed metadata for already-preserved reference files. Never copies
 * assets, applies palettes, executes imported scripts or grants item custody. */
export async function buildReferenceAssetIndex(root){
 const base=await realpath(root),catalogBytes=await readFile(path.join(base,'catalog.json'));
 const catalog=JSON.parse(catalogBytes),assets=new Map(),paths=new Map(),presentations=new Map(),items=[];
 for(const artifact of catalog.artifacts){
  if(!sourceUrls[artifact.source]||!relativeFile(artifact.path)||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw Error('Invalid artifact reference');
  const relative=`${artifact.source}/${artifact.path}`,file=await realpath(path.join(base,relative));
  if(!file.startsWith(base+path.sep))throw Error('Artifact escapes the preserved root');
  const bytes=await readFile(file);
  if(bytes.length!==artifact.bytes||sha(bytes)!==artifact.sha256)throw Error(`Artifact changed: ${relative}`);
  const id=`sha256:${artifact.sha256}`;
  let image=null;
  if(artifact.path.endsWith('.png')){
   if(bytes.length<33||!bytes.subarray(0,8).equals(png)||bytes.toString('ascii',12,16)!=='IHDR')throw Error('Invalid PNG header');
   const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
   if(!width||!height||width>16384||height>16384)throw Error('Invalid PNG dimensions');
   image={width,height,bitDepth:bytes[24],colorType:bytes[25],nativePaletteApplied:false};
  }
  const reference={source:artifact.source,path:artifact.path,revision:catalog.revisions[artifact.source],url:artifact.url};
  const existing=assets.get(id);
  if(existing)existing.references.push(reference);
  else assets.set(id,{id,sha256:artifact.sha256,bytes:bytes.length,format:path.extname(artifact.path).slice(1),image,references:[reference],releaseStatus:'reference-only; per-file rights and visual review required'});
  if(paths.has(relative))throw Error('Duplicate source path');paths.set(relative,id);
 }
 const lookup=(source,file)=>{if(!file)return null;const id=paths.get(`${source}/${file}`);if(!id)throw Error(`Unindexed reference ${source}/${file}`);return id;};
 const itemIds=new Set();
 for(const item of catalog.items){
  if(itemIds.has(item.id))throw Error('Duplicate source item ID');itemIds.add(item.id);
  const image=item.art?lookup(item.source,item.art.path):null;
  const palette=item.palette?.path?lookup(item.source,item.palette.path):null;
  const behavior=item.behavior?lookup(item.source,item.behavior.path):null;
  const directions=frameLayout(item);
  const identity={image,palette,directions};
  const presentationId=image?`presentation:${sha(JSON.stringify(identity))}`:null;
  if(presentationId&&!presentations.has(presentationId))presentations.set(presentationId,{id:presentationId,...identity,animation:{status:directions.length?'source-layout-only':'static-icon',timingsVerified:false,gameplayBound:false},visualAcceptance:false});
  items.push({id:item.id,source:item.source,sourceId:item.sourceId,name:item.name,category:item.category,revision:item.revision,presentationId,behaviorAssetId:behavior,gameplayItemId:null,charmIdentity:null,ownershipGranted:false,implementationStatus:'reference-only'});
 }
 return {schemaVersion:1,sourceCatalogSha256:sha(catalogBytes),sources:Object.entries(catalog.revisions).map(([id,revision])=>({id,repository:sourceUrls[id],revision,rightsStatus:id==='pokeemerald'?'decompilation reference; no blanket artwork grant identified':'mixed GPL scripts, CC-BY-SA originals and Nintendo-derived material; review each file'})),
  counts:{sourceItems:items.length,sourceArtifactPaths:paths.size,uniqueContentAssets:assets.size,uniqueImages:[...assets.values()].filter(asset=>asset.image).length,presentations:presentations.size,sourceItemsWithArt:items.filter(item=>item.presentationId).length},
  notes:['Content hashes deduplicate bytes, not item identity or custody.','Presentation IDs include palette identity and source direction layout. Same pixels with different palettes are not interchangeable.','Existing files are referenced without copying new art. No permission, gameplay behavior or economic supply is created.','Static inventory icons do not imply thrown, held, overworld or animated move coverage.'],
  assets:[...assets.values()].sort((a,b)=>a.id.localeCompare(b.id)),presentations:[...presentations.values()].sort((a,b)=>a.id.localeCompare(b.id)),items};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=await buildReferenceAssetIndex(path.resolve('public/charmville/reference-items'));
 const target=path.resolve('public/charmville/catalog/reference-asset-index.json');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(index,null,2)+'\n');console.log(JSON.stringify(index.counts));
}
