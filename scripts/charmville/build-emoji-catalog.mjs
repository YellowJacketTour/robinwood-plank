import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source='public/charmville/catalog/emoji-test-17.0.txt';
const text=await readFile(source,'utf8');
if(!text.includes('# Version: 17.0'))throw Error('Expected pinned Unicode 17.0');
const domains={'Smileys & Emotion':['expression','Social expression, festival crafting and collection'], 'People & Body':['identity','Avatar expression and professions; appearance grants no economic advantage'], 'Animals & Nature':['ecology','Species, husbandry, habitats, pollination and resource regeneration'], 'Food & Drink':['provisions','Farming, cooking, preservation, feed and consumables'], 'Travel & Places':['infrastructure','Homes, public works, transport and exploration'], Activities:['culture','Events, recreation, achievements and equipment'], Objects:['industry','Tools, materials, equipment and production'], Symbols:['language','Signals, permissions, inscriptions and expression'], Flags:['identity','Community identity and decoration; no inherent scarcity ranking'], Component:['appearance','Presentation component, not a standalone commodity']};
let group='',subgroup='';const entries=[];
for(const line of text.split(/\r?\n/)){
 if(line.startsWith('# group: ')){group=line.slice(9);continue;}
 if(line.startsWith('# subgroup: ')){subgroup=line.slice(12);continue;}
 const match=line.match(/^([0-9A-F ]+)\s*;\s*(fully-qualified|component)\s*#\s*(\S+)\s+E([\d.]+)\s+(.+)$/);
 if(!match)continue;
 const codepoints=match[1].trim().split(/\s+/),[domain,proposal]=domains[group]||['review','Needs author review'];
 entries.push({id:'emoji:'+codepoints.join('-').toLowerCase(),glyph:match[3],name:match[5],group,subgroup,qualification:match[2],introduced:match[4],domain,proposal,gameplayStatus:'unmapped',artStatus:'unmapped'});
}
if(new Set(entries.map(x=>x.id)).size!==entries.length||entries.length<3900)throw Error('Incomplete or duplicate source coverage');
const result={schemaVersion:1,unicodeVersion:'17.0',source:'https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt',sourceSha256:createHash('sha256').update(text).digest('hex'),notice:'Catalogue coverage and proposed design roles only. Entries are not minted assets, balances, authored recipes, or imported game artwork.',count:entries.length,entries};
await writeFile('public/charmville/catalog/emoji-catalog.json',JSON.stringify(result,null,2)+'\n');console.log({count:result.count,qualified:entries.filter(x=>x.qualification==='fully-qualified').length,components:entries.filter(x=>x.qualification==='component').length});
