import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decryptRuntimePackage} from './runtime-package-envelope.mjs';
import {extractPrivateRuntime} from './private-runtime-archive.mjs';
import {stagePrivateRuntimeRelease} from './stage-private-runtime-release.mjs';

/** CI-only local preparation. Never publishes, changes admission or sets READY. */
export async function preparePrivateRuntimeRelease({input,workdir,standalone,release,archiveSha256,plaintextSha256,inventorySha256,key}){
 const root=path.resolve(workdir);if(root.split(path.sep).some(part=>part.toLowerCase()==='public'))throw Error('Private work directory required');
 await mkdir(root); // Fresh directory only; no reuse of previous plaintext.
 const decrypted=path.join(root,'runtime.cvgz'),extracted=path.join(root,'extracted');
 await decryptRuntimePackage({input,output:decrypted,key,archiveSha256,plaintextSha256});
 await extractPrivateRuntime({input:decrypted,output:extracted,release,inventorySha256});
 return stagePrivateRuntimeRelease({input:extracted,standalone,release,expectedInventorySha256:inventorySha256});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={},keys={input:'input',workdir:'workdir',standalone:'standalone',release:'release','archive-sha256':'archiveSha256','plaintext-sha256':'plaintextSha256','inventory-sha256':'inventorySha256'};
 for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2),value=process.argv[i+1];if(!process.argv[i].startsWith('--')||!Object.hasOwn(keys,key)||args[keys[key]]||!value||value.startsWith('--'))throw Error('Invalid preparation arguments');args[keys[key]]=value;}
 for(const key of Object.values(keys))if(!args[key])throw Error(`Missing ${key}`);
 try{console.log(JSON.stringify(await preparePrivateRuntimeRelease({...args,key:process.env.CHARMVILLE_RUNTIME_PACKAGE_KEY})));}
 catch{console.error('Private runtime preparation failed; no runtime was enabled or deployed.');process.exitCode=1;}
}
