// Read-only upstream census. Does not install or execute upstream projects.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root='docs/charmville-research-2026-09-08';
await mkdir(root,{recursive:true});
const gh=(path)=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',maxBuffer:30e6}));
const repos=['FV-Replowed/fv-replowed','AcidCaos/farmvillage','Kristianfriis/FarmVille','joeyinbox/world-of-farmcraft','fariazz/html5-farming-demo','CodingQuests/FarmVille-Game','gadget-hq/2d-farming-game','dacousb/feiok','AmbientRun/flowerpot','nocktoshi/memoji-market','OpenRCT2/OpenGraphics','OpenTTD/OpenGFX2'];
const census=[];
for(const repo of repos){
 try {
  const meta=gh(`repos/${repo}`),commit=gh(`repos/${repo}/commits/${meta.default_branch}`);
  const tree=gh(`repos/${repo}/git/trees/${commit.sha}?recursive=1`);
  const paths=tree.tree.filter(x=>x.type==='blob').map(x=>x.path);
  const record={repo,url:meta.html_url,commit:commit.sha,description:meta.description,license:meta.license?.spdx_id??null,truncated:tree.truncated,files:paths.length,artFiles:paths.filter(x=>/\.(png|jpg|jpeg|webp|svg|blend|obj|fbx|aseprite|psd|swf)$/i.test(x)).length,manifests:paths.filter(x=>/(readme|license|credit|copying|package.json|composer.json|requirements.txt|project.godot|go.mod|\.csproj$)/i.test(x)).slice(0,100)};
  census.push(record);
  await writeFile(`${root}/${repo.replaceAll('/','--')}-tree.json`,JSON.stringify({commit:commit.sha,truncated:tree.truncated,paths},null,2)+'\n');
  console.log(`${repo}: ${record.files} files, ${record.artFiles} art candidates`);
 } catch(e){census.push({repo,error:String(e.message).slice(0,250)});}
}
await writeFile(`${root}/repository-census.json`,JSON.stringify({date:'2026-09-08',scope:'Selected relevant repositories; counts are filenames, not visual inspection or proof of asset completeness',repos:census},null,2)+'\n');
for(const name of ['farmville-repo-search','farming-repo-search']){
 const bytes=await readFile(`.dream-loop/${name}.json`);const raw=bytes[0]===255?bytes.toString('utf16le'):bytes.toString('utf8');
 await writeFile(`${root}/${name}.json`,JSON.stringify(JSON.parse(raw.replace(/^\uFEFF/,'')),null,2)+'\n');
}
const source=await readFile('../charmville-references/memoji-market/src/constants/index.ts','utf8');
const entries=[...source.matchAll(/\{\s*denom:\s*`([^`]+)`,\s*name:\s*"([^"]+)",\s*maxSupply:\s*"([^"]+)",\s*emoji:\s*"([^"]*)",\s*listed:\s*(true|false),\s*poolId:\s*"([^"]*)"\s*\}/g)].map(m=>({denomTemplate:m[1],name:m[2],maxSupplyRaw:m[3],glyph:m[4],listed:m[5]==='true',poolId:m[6]}));
await writeFile(`${root}/memoji-registry.json`,JSON.stringify({source:'https://github.com/nocktoshi/memoji-market/blob/'+execFileSync('git',['-C','../charmville-references/memoji-market','rev-parse','HEAD'],{encoding:'utf8'}).trim()+'/src/constants/index.ts',network:'osmo-test-5; historical/reference registry, not verified live Unicorn mainnet inventory',count:entries.length,entries},null,2)+'\n');
console.log(`Extracted ${entries.length} memoji registry records`);
