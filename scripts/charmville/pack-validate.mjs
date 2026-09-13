import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packSchema } from './pack-schema.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Evaluates only the keywords used by this fixed schema; never accepts a caller-supplied schema.
function shape(value, schema, at, errors) {
  const fail = message => errors.push(`${at}: ${message}`);
  if ('const' in schema && value !== schema.const) fail(`must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const valid = schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === schema.type;
    if (!valid) { fail(`expected ${schema.type}`); return; }
  }
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) fail('empty string');
    if (schema.maxLength && value.length > schema.maxLength) fail('string too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('invalid format');
  }
  if (typeof value === 'number' && (value < schema.minimum || value > schema.maximum)) fail('number out of bounds');
  if (schema.type === 'array') {
    if (value.length < schema.minItems || value.length > schema.maxItems) fail('array length out of bounds');
    value.forEach((item, i) => shape(item, schema.items, `${at}[${i}]`, errors));
  }
  if (schema.type === 'object') {
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`unknown field ${key}`);
      else shape(value[key], schema.properties[key], `${at}.${key}`, errors);
    }
  }
}
export function validatePack(pack) {
  const errors = [];
  shape(pack, packSchema, '$', errors);
  if (errors.length) return errors;
  const unique = (rows, label) => {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id)) errors.push(`${label}: duplicate id ${row.id}`);
      seen.add(row.id);
    }
  };
  unique(pack.assets, 'assets'); unique(pack.actions, 'actions'); unique(pack.dependencies, 'dependencies');
  for (const dep of pack.dependencies) if (dep.id === pack.id) errors.push('dependencies: self dependency');
  const assets = new Map(pack.assets.map(asset => [asset.id, asset]));
  for (const asset of pack.assets) {
    if (!/^[a-zA-Z0-9_./-]+\.png$/.test(asset.path) || asset.path.startsWith('/') || asset.path.split('/').some(p => !p || p === '.' || p === '..')) errors.push(`asset ${asset.id}: unsafe PNG path`);
    if (asset.rights.status !== 'unreviewed' && (asset.rights.evidence === 'unknown' || asset.rights.license === 'unknown')) errors.push(`asset ${asset.id}: claimed rights require recorded evidence and license`);
  }
  for (const action of pack.actions) {
    for (const [direction, frames] of Object.entries(action.directions)) {
      const at = `${action.id}.${direction}`;
      const duration = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
      if (action.contactMs >= duration || action.contactMs + action.recoveryMs > duration) errors.push(`${at}: contact/recovery outside timeline`);
      frames.forEach((frame, i) => {
        const asset = assets.get(frame.asset);
        if (!asset) { errors.push(`${at}[${i}]: unknown asset ${frame.asset}`); return; }
        const { region, origin, grip, collision } = frame;
        if (region.x + region.width > asset.width || region.y + region.height > asset.height) errors.push(`${at}[${i}]: source frame outside atlas`);
        for (const [name, point] of Object.entries({ origin, grip })) if (point.x >= region.width || point.y >= region.height) errors.push(`${at}[${i}]: ${name} outside frame`);
        if (collision.x + collision.width > region.width || collision.y + collision.height > region.height) errors.push(`${at}[${i}]: collision outside frame`);
      });
    }
  }
  return errors;
}

export async function verifyPackFiles(pack, root) {
  const errors = validatePack(pack);
  if (errors.length) return errors;
  const realRoot = await realpath(root);
  for (const asset of pack.assets) {
    try {
      const file = await realpath(path.resolve(realRoot, asset.path));
      const relative = path.relative(realRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('asset escapes pack root');
      const bytes = await readFile(file);
      if (sha256(bytes) !== asset.sha256) errors.push(`${asset.id}: SHA-256 mismatch`);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') errors.push(`${asset.id}: missing PNG header`);
      else if (bytes.readUInt32BE(16) !== asset.width || bytes.readUInt32BE(20) !== asset.height) errors.push(`${asset.id}: PNG dimensions differ from manifest`);
    } catch (error) { errors.push(`${asset.id}: ${error.message}`); }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--schema') console.log(JSON.stringify(packSchema, null, 2));
    else {
      if (args.length < 1 || args.length > 2) throw new Error('Usage: node pack-validate.mjs manifest.json [asset-root] | --schema');
      const bytes = await readFile(args[0]);
      const pack = JSON.parse(bytes);
      const errors = args[1] ? await verifyPackFiles(pack, args[1]) : validatePack(pack);
      console.log(JSON.stringify({ ok: errors.length === 0, manifestSha256: sha256(bytes), assetsVerified: !!args[1], errors }, null, 2));
      if (errors.length) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
