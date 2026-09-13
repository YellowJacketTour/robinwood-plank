import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportPrivateRuntime } from './export-private-runtime.mjs';

/** Local/CI packaging only. Does not fetch, certify, enable or deploy anything. */
export async function stagePrivateRuntimeRelease({ input, standalone, release, expectedInventorySha256 }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release) || !/^[a-f0-9]{64}$/.test(expectedInventorySha256)) throw Error('Explicit release and inventory hash required');
  const root = await realpath(input), destination = await realpath(standalone);
  for (const name of ['PACKAGE-COMPLETE.json', 'inventory.json']) {
    const info = await lstat(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw Error('Invalid package metadata');
  }
  const receipt = JSON.parse(await readFile(path.join(root, 'PACKAGE-COMPLETE.json'), 'utf8'));
  const bytes = await readFile(path.join(root, 'inventory.json'));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedInventorySha256 || receipt.inventorySha256 !== actual || receipt.release !== release || receipt.kind !== 'charmville-runtime-release' || receipt.readyToServe !== true) throw Error('Reviewed runnable package required; candidates cannot be staged');
  const inventory = JSON.parse(bytes.toString('utf8'));
  if(inventory.completeInventory!==true||!Array.isArray(inventory.files)||!Array.isArray(inventory.issues)||inventory.issues.length)throw Error('Complete inventory required');
  // The exporter preserves only selected metadata fields. Refuse any mismatch
  // so the staged output retains the exact already-reviewed inventory identity.
  const canonical = { schemaVersion: inventory.schemaVersion, scope: inventory.scope, completeInventory: true,
    files: inventory.files.map(({root,path,route,role,bytes,sha256,status}) => ({root,path,route,role,bytes,sha256,status})),
    issues: [], readiness: 'self-contained-inputs-only' };
  const privateParent = path.join(destination, 'private', 'charmville');
  await mkdir(privateParent, { recursive: true });
  const output = path.join(privateParent, 'runtime');
  const roots = Object.fromEntries(['repo','runtime','content','sprite'].map(name => [name, path.join(root, name)]));
  await exportPrivateRuntime({ manifest: canonical, roots, output });
  // The verified source inventory and receipt supersede the input-only marker
  // in this newly created local directory, never in the source package.
  await writeFile(path.join(output, 'inventory.json'), bytes);
  await writeFile(path.join(output, 'PACKAGE-COMPLETE.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { release, inventorySha256: actual, relativeRoot: 'private/charmville/runtime', readyToDeploy: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {}; const flags = new Set(['input','standalone','release','inventory-sha256']);
  for (let i=2;i<process.argv.length;i+=2) {
    const key=process.argv[i].slice(2),value=process.argv[i+1];
    if(!process.argv[i].startsWith('--')||!flags.has(key)||args[key]||!value||value.startsWith('--'))throw Error('Invalid staging arguments');
    args[key]=value;
  }
  for(const key of flags)if(!args[key])throw Error(`Missing --${key}`);
  console.log(JSON.stringify(await stagePrivateRuntimeRelease({input:args.input,standalone:args.standalone,release:args.release,expectedInventorySha256:args['inventory-sha256']})));
}
