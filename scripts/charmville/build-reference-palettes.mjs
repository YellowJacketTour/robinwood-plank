import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildReferenceAssetIndex} from './build-reference-asset-index.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function chunks(bytes){
 if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('PNG signature');
 const result=[];let at=8;
 while(at<bytes.length){if(at+12>bytes.length)throw Error('Truncated PNG');const size=bytes.readUInt32BE(at);if(at+12+size>bytes.length)throw Error('Truncated PNG chunk');const raw=bytes.subarray(at,at+12+size),type=raw.toString('ascii',4,8);if(crc32(raw.subarray(4,8+size))!==raw.readUInt32BE(8+size))throw Error('PNG CRC mismatch');result.push({type,raw,data:raw.subarray(8,8+size)});at+=12+size;}
 if(result[0]?.type!=='IHDR'||result.at(-1)?.type!=='IEND')throw Error('PNG structure');return result;
}
export function applyPalette(image,palette){
 const parts=chunks(image),header=parts[0].data;if(header[9]!==3)throw Error('Expected indexed PNG');
 const lines=palette.toString('utf8').trim().split(/\r?\n/).map(x=>x.trim());const count=Number(lines[2]);
 if(lines[0]!=='JASC-PAL'||lines[1]!=='0100'||!Number.isInteger(count)||count<1||count>256||lines.length!==count+3)throw Error('Invalid JASC palette');
 const colors=Buffer.from(lines.slice(3).flatMap(line=>{const rgb=line.split(/\s+/).map(Number);if(rgb.length!==3||rgb.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid palette RGB');return rgb;}));
 if(parts.filter(p=>p.type==='PLTE').length!==1)throw Error('Expected one palette');
 const prior=parts.find(p=>p.type==='PLTE');if(colors.length!==prior.data.length)throw Error('Palette size mismatch');
 const replacement=Buffer.alloc(colors.length+12);replacement.writeUInt32BE(colors.length);replacement.write('PLTE',4);colors.copy(replacement,8);replacement.writeUInt32BE(crc32(replacement.subarray(4,-4)),replacement.length-4);
 return Buffer.concat([image.subarray(0,8),...parts.map(p=>p.type==='PLTE'?replacement:p.raw)]);
}
export async function buildPalettes(root){
 await buildReferenceAssetIndex(root);const catalog=JSON.parse(await readFile(path.join(root,'catalog.json')));const artifacts=new Map(catalog.artifacts.map(a=>[`${a.source}/${a.path}`,a]));const items={};const out=path.join(root,'derived');await mkdir(out,{recursive:true});
 for(const item of catalog.items){if(!item.art||!item.palette?.path)continue;const pal=artifacts.get(`${item.source}/${item.palette.path}`);if(!pal)throw Error('Missing palette');const image=await readFile(path.join(root,item.source,item.art.path)),palette=await readFile(path.join(root,item.source,pal.path));const bytes=applyPalette(image,palette),hash=sha(bytes);await writeFile(path.join(out,`${hash}.png`),bytes);items[item.id]={url:`/charmville/reference-items/derived/${hash}.png`,sha256:hash,sourceImageSha256:sha(image),sourcePaletteSha256:sha(palette),sourceImage:item.art.path,sourcePalette:pal.path,nativePaletteApplied:true,indicesPreserved:true};}
 return {schemaVersion:1,sourceCatalogSha256:sha(await readFile(path.join(root,'catalog.json'))),releaseStatus:'reference-only',items};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const manifest=await buildPalettes(path.resolve('public/charmville/reference-items'));await writeFile('public/charmville/catalog/reference-item-presentations.json',JSON.stringify(manifest,null,2)+'\n');console.log(`Palette-correct items: ${Object.keys(manifest.items).length}`);}
