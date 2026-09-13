import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sourceRoots = ['repo', 'runtime', 'content', 'sprite'];
function relativeParts(value) {
  if (typeof value !== 'string' || !value || /[\\:%\x00-\x20]/.test(value)) throw Error('Unsafe manifest path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw Error('Unsafe manifest path');
  return parts;
}
async function noLinks(filename) {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw Error('Symbolic links are not export inputs');
  }
}
export async function exportPrivateRuntime({ manifest, roots, output }) {
  if (manifest?.schemaVersion !== 1 || manifest.scope !== 'joined-homestead-private-inventory' || manifest.completeInventory !== true || !Array.isArray(manifest.files) || !Array.isArray(manifest.issues) || manifest.issues.length) throw Error('Complete inventory required');
  const resolvedRoots = {};
  for (const root of sourceRoots) { await noLinks(roots[root]); resolvedRoots[root] = await realpath(roots[root]); }
  const target = path.resolve(output);
  await noLinks(path.dirname(target));
  // Never write into public trees or overlap input roots. Output must be new.
  if (target.split(path.sep).some(part => part.toLowerCase() === 'public')) throw Error('Private output cannot be under public');
  for (const root of Object.values(resolvedRoots)) {
    const rel = path.relative(root, target);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw Error('Output overlaps an input root');
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!sourceRoots.includes(entry.root) || entry.status !== 'present' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid manifest entry');
    relativeParts(entry.path);
    const key = `${entry.root}/${entry.path}`;
    if (seen.has(key.toLowerCase())) throw Error('Duplicate/case-colliding input');
    seen.add(key.toLowerCase());
  }
  await mkdir(target); // EEXIST deliberately refuses rerun over a previous package.
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const parts = relativeParts(entry.path);
    const source = path.join(resolvedRoots[entry.root], ...parts);
    await noLinks(source);
    const info = await lstat(source);
    if (!info.isFile() || info.size !== entry.bytes) throw Error('Input changed since inventory');
    const destination = path.join(target, entry.root, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    const hash = createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
    await pipeline(createReadStream(source), verify, createWriteStream(destination, { flags: 'wx' }));
    if (size !== entry.bytes || hash.digest('hex') !== entry.sha256) throw Error('Input hash mismatch; incomplete output must not be used');
    totalBytes += size;
  }
  // Completion marker written last. Its absence means an interrupted/rejected export.
  const cleanManifest = {
    schemaVersion: manifest.schemaVersion, scope: manifest.scope, completeInventory: true,
    files: manifest.files.map(({ root, path: file, route, role, bytes, sha256, status }) => ({ root, path: file, route, role, bytes, sha256, status })),
    issues: [], readiness: 'self-contained-inputs-only',
  };
  const inventoryBytes = JSON.stringify(cleanManifest, null, 2) + '\n';
  await writeFile(path.join(target, 'inventory.json'), inventoryBytes, { flag: 'wx' });
  const receipt = { schemaVersion: 1, kind: 'private-runtime-input-package', readyToServe: false, files: manifest.files.length, totalBytes,
    inventorySha256: createHash('sha256').update(inventoryBytes).digest('hex'),
    roots: Object.fromEntries(sourceRoots.map(root => [root, `./${root}`])),
    pending: ['Extract deterministic entry HTML/main.js adapters', 'Relocate every absolute route and loader dependency to authenticated version prefix', 'Narrow metadata and remove legacy launch/editor/service-worker exposure', 'Cold-cache browser request coverage and authenticated worker checks'],
  };
  await writeFile(path.join(target, 'PACKAGE-COMPLETE.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {}; const allowed = new Set(['manifest', 'repo-root', 'runtime-root', 'content-root', 'sprite-root', 'output']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], key = flag.slice(2), value = process.argv[i + 1];
    if (!flag.startsWith('--') || !allowed.has(key) || args[key] || !value || value.startsWith('--')) throw Error('Invalid exporter arguments');
    args[key] = value;
  }
  for (const key of allowed) if (!args[key]) throw Error(`Missing --${key}`);
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
  console.log(JSON.stringify(await exportPrivateRuntime({ manifest, roots: Object.fromEntries(sourceRoots.map(root => [root, args[`${root}-root`]])), output: args.output })));
}
