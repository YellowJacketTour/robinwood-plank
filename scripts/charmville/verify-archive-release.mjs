import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const [manifestPath,referenceDirectory,releaseId,outputPath]=process.argv.slice(2);
if(!outputPath)throw Error('Usage: node verify-archive-release.mjs <manifest> <references> <release-id> <receipt>');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const release=JSON.parse(execFileSync('gh',['api',`repos/${manifest.repository}/releases/${releaseId}`],{encoding:'utf8',maxBuffer:10*1024*1024}));
const expected=(await readdir(referenceDirectory,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name);
for(const source of expected)if(!manifest.archives.some(a=>a.source===source))throw Error(`Missing source archive: ${source}`);
for(const item of manifest.archives){const remote=release.assets.find(a=>a.name===item.file);if(!remote||remote.size!==item.bytes||remote.digest!==`sha256:${item.sha256}`)throw Error(`Remote size/SHA-256 mismatch: ${item.file}`);}
const receipt={verifiedAt:new Date().toISOString(),repository:manifest.repository,tag:manifest.tag,releaseId:Number(releaseId),sourceCollections:manifest.archives.length,totalArchiveBytes:manifest.archives.reduce((n,a)=>n+a.bytes,0),verification:'Every local source directory represented; all uploaded archive sizes and GitHub SHA-256 digests match manifest.',exclusions:manifest.exclusions};
await writeFile(path.resolve(outputPath),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
