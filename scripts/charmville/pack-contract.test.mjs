import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePack, verifyPackFiles, sha256 } from './pack-validate.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture() {
  const frame = { asset: 'test.pixel', region: { x: 0, y: 0, width: 1, height: 1 }, durationMs: 100,
    origin: { x: 0, y: 0 }, grip: { x: 0, y: 0 }, collision: { x: 0, y: 0, width: 1, height: 1 }, flipX: false, flipY: false };
  return {
    schemaVersion: 1, id: 'test.pack', version: '1.0.0', authors: ['Validation fixture; not gameplay art'], dependencies: [],
    assets: [{ id: 'test.pixel', path: 'pixel.png', sha256: sha256(pixel), width: 1, height: 1,
      provenance: { source: 'test fixture', revision: '1', sourcePath: 'pixel.png', attribution: 'Test-only pixel' },
      rights: { status: 'unreviewed', license: 'unknown', evidence: 'unknown' } }],
    actions: [{ id: 'test.action', meaning: 'Schema exercise only', itemDefinition: 'test.item', authority: 'server-contact',
      contactMs: 50, recoveryMs: 50, interruptPolicy: 'cancel-before-contact',
      directions: Object.fromEntries(['up', 'down', 'left', 'right'].map(d => [d, [structuredClone(frame)]])) }],
  };
}
test('complete four-direction test pack accepted without pretending rights review', () => assert.deepEqual(validatePack(fixture()), []));
const invalidCases = {
  'missing direction': p => delete p.actions[0].directions.left,
  'unknown direction': p => p.actions[0].directions.north = p.actions[0].directions.up,
  'frame spills past atlas': p => p.actions[0].directions.up[0].region.x = 1,
  'grip spills past frame': p => p.actions[0].directions.up[0].grip.x = 1,
  'collision spills past frame': p => p.actions[0].directions.up[0].collision.width = 2,
  'unknown asset': p => p.actions[0].directions.up[0].asset = 'missing',
  'zero frame time': p => p.actions[0].directions.up[0].durationMs = 0,
  'contact after animation': p => p.actions[0].contactMs = 100,
  'recovery after animation': p => p.actions[0].recoveryMs = 51,
  'floating revision': p => p.version = 'latest',
  'dependency not pinned': p => p.dependencies.push({ id: 'other', version: '^1.0.0', manifestSha256: 'a'.repeat(64) }),
  'self dependency': p => p.dependencies.push({ id: p.id, version: '1.0.0', manifestSha256: 'a'.repeat(64) }),
  'path traversal': p => p.assets[0].path = '../pixel.png',
  'windows path': p => p.assets[0].path = 'C:/pixel.png',
  'unsubstantiated rights': p => p.assets[0].rights.status = 'licensed',
  'duplicate asset': p => p.assets.push(structuredClone(p.assets[0])),
  'executable hook': p => p.actions[0].onContact = 'mint(100)',
  'client economic authority': p => p.actions[0].authority = 'client',
};
for (const [name, mutate] of Object.entries(invalidCases)) test(`rejects ${name}`, () => {
  const pack = fixture(); mutate(pack); assert.ok(validatePack(pack).length > 0);
});
test('asset verification binds bytes and actual PNG dimensions to manifest', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'charmville-pack-'));
  try {
    await writeFile(path.join(dir, 'pixel.png'), pixel);
    const pack = fixture();
    assert.deepEqual(await verifyPackFiles(pack, dir), []);
    pack.assets[0].width = 2;
    assert.match((await verifyPackFiles(pack, dir)).join('\n'), /dimensions differ/);
    pack.assets[0].width = 1;
    await writeFile(path.join(dir, 'pixel.png'), Buffer.from('changed'));
    assert.match((await verifyPackFiles(pack, dir)).join('\n'), /SHA-256 mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
