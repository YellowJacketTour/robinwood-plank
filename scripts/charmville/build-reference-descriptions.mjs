import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='../charmville-references/pokeemerald/src/data/text/item_descriptions.h';
const bytes=await readFile(file),text=bytes.toString('utf8');const symbols=new Map();
for(const match of text.matchAll(/static const u8 (\w+)\[\]\s*=\s*_\(\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\);/g)){
 const value=[...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m=>m[1].replace(/\\n/g,' ').replace(/\\"/g,'"').replace(/\\\\/g,'\\')).join('').replace(/\s+/g,' ').trim();symbols.set(match[1],{text:value,symbol:match[1],line:text.slice(0,match.index).split('\n').length});
}
const catalog=JSON.parse(await readFile('public/charmville/reference-items/catalog.json'));const items={};for(const item of catalog.items){if(item.source==='pokeemerald'&&symbols.has(item.fields?.description))items[item.id]=symbols.get(item.fields.description);}
await writeFile('public/charmville/catalog/reference-item-descriptions.json',JSON.stringify({schemaVersion:1,source:{repository:'https://github.com/pret/pokeemerald',revision:catalog.revisions.pokeemerald,path:'src/data/text/item_descriptions.h',sha256:createHash('sha256').update(bytes).digest('hex')},meaning:'Original game effect; does not claim implemented Charmville behavior',items},null,2)+'\n');console.log(Object.keys(items).length);
