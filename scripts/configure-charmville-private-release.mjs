import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const keys = ['CHARMVILLE_ACCESS_MODE','CHARMVILLE_ADMIN_WALLETS','CHARMVILLE_ALLOWED_WALLETS','CHARMVILLE_RUNTIME_READY','CHARMVILLE_RUNTIME_RELEASE','CHARMVILLE_RUNTIME_ROOT'];

/** Explicit deployment input only. Never inherits global administrators. */
export function renderPrivateReleaseEnvironment(source, input) {
  if (input.CHARMVILLE_ACCESS_MODE !== 'private') throw Error('Explicit private access mode is required');
  const admins = (input.CHARMVILLE_ADMIN_WALLETS ?? '').split(',').map(v=>v.trim().toLowerCase());
  if (!admins.length || admins.some(v=>!/^0x[a-f0-9]{40}$/.test(v))) throw Error('Explicit valid Charmville administrators are required');
  const release = input.CHARMVILLE_RUNTIME_RELEASE;
  if (typeof release !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release)) throw Error('Valid accepted runtime release is required');
  if (input.CHARMVILLE_RUNTIME_READY !== '1') throw Error('Explicit runtime enablement is required');
  // Reject ambiguous multiline values for owned settings instead of leaving a
  // continuation that could change how Node interprets the rewritten file.
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const assignment=line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    const value=assignment?.[1]?.trim();
    if(value && /^["'`]/.test(value) && !new RegExp(`^${value[0]}[^${value[0]}]*${value[0]}\\s*(?:#.*)?$`).test(value)) throw Error('Multiline environment requires explicit operator reconciliation');
  }
  const kept = lines.filter(line=>{
    const match=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if (!match || !keys.includes(match[1])) return true;
    const value=match[2].trim();
    if (/^["'`]/.test(value) && !new RegExp(`^${value[0]}[^${value[0]}]*${value[0]}\\s*(?:#.*)?$`).test(value)) throw Error('Ambiguous existing Charmville setting');
    return false;
  });
  while(kept.at(-1)==='') kept.pop();
  return `${kept.join('\n')}\nCHARMVILLE_ACCESS_MODE=private\nCHARMVILLE_ADMIN_WALLETS=${[...new Set(admins)].join(',')}\nCHARMVILLE_ALLOWED_WALLETS=\nCHARMVILLE_RUNTIME_READY=1\nCHARMVILLE_RUNTIME_RELEASE=${release}\n`;
}

export async function configurePrivateRelease(filename, input) {
  if (!path.isAbsolute(filename)) throw Error('Absolute server environment path required');
  const stat=await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>2_000_000) throw Error('Expected ordinary environment file');
  const source=await fs.readFile(filename,'utf8');
  const output=renderPrivateReleaseEnvironment(source,input);
  const suffix=randomUUID(), temporary=`${filename}.charmville-${suffix}.tmp`, backup=`${filename}.charmville-${suffix}.bak`;
  // Exclusive backup and same-directory atomic rename. Do not print file contents.
  await fs.copyFile(filename,backup,constants.COPYFILE_EXCL);
  await fs.chmod(backup,0o600);
  try {
    await fs.writeFile(temporary,output,{flag:'wx',mode:0o600});
    const handle=await fs.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
    if(await fs.readFile(filename,'utf8')!==source) throw Error('Environment changed concurrently; configuration not replaced');
    await fs.rename(temporary,filename);
  } finally {await fs.rm(temporary,{force:true});}
  return {configured:true};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3){console.error('Usage: configure-charmville-private-release.mjs <absolute-env-file>');process.exitCode=1;}
  else configurePrivateRelease(process.argv[2],process.env).then(()=>console.log('Private Charmville runtime configuration updated')).catch(()=>{console.error('Private Charmville configuration failed; inspect validated deployment inputs and file access');process.exitCode=1;});
}
