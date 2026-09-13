import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const refs=path.resolve(repo,'../charmville-references');
const source=path.join(refs,'zquest-classic/timidity');
const output=path.join(source,'soundfont-pats');
const converter=path.join(refs,'tooling/unsf/build-wasm/unsf-static.js');
await access(converter);await mkdir(output,{recursive:true});
for(const entry of await readdir(path.join(source,'soundfonts'),{withFileTypes:true})){
 if(!entry.isFile()||!entry.name.endsWith('.sf2'))continue;
 const name=path.parse(entry.name).name;
 execFileSync(process.execPath,[converter,'-O',output.replaceAll('\\','/'),path.join(source,'soundfonts',entry.name).replaceAll('\\','/')],{stdio:'inherit'});
 const cfg=path.join(output,`${name}.cfg`);
 const original=await readFile(cfg,'utf8');
 const text=original.replaceAll(`${name}/`,`soundfont-pats/${name}/`).replaceAll(`${name}-Drums/`,`soundfont-pats/${name}-Drums/`);
 if(!text.trim())throw Error(`Empty configuration: ${name}`);
 await writeFile(cfg,text,'utf8');
}
