import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportPrivateRuntime } from './export-private-runtime.mjs';

test('private input export verifies bytes and refuses unsafe or partial packages', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'charm-export-'));
  try {
    const input = path.join(temp, 'input'); await mkdir(input);
    await writeFile(path.join(input, 'main.js'), 'fixture');
    const roots = Object.fromEntries(['repo', 'runtime', 'content', 'sprite'].map(root => [root, input]));
    const file = { root: 'runtime', path: 'main.js', route: '/main.js', role: 'served', status: 'present', bytes: 7, sha256: createHash('sha256').update('fixture').digest('hex') };
    const manifest = { schemaVersion: 1, scope: 'joined-homestead-private-inventory', completeInventory: true, issues: [], files: [file] };
    const output = path.join(temp, 'export');
    const result = await exportPrivateRuntime({ manifest, roots, output });
    assert.equal(result.readyToServe, false);
    assert.equal(await readFile(path.join(output, 'runtime/main.js'), 'utf8'), 'fixture');
    await access(path.join(output, 'PACKAGE-COMPLETE.json'));
    await assert.rejects(exportPrivateRuntime({ manifest, roots, output }), { code: 'EEXIST' });
    await assert.rejects(exportPrivateRuntime({ manifest, roots, output: path.join(input, 'nested') }), /overlaps/);
    await assert.rejects(exportPrivateRuntime({ manifest, roots, output: path.join(temp, 'public') }), /public/);
    await assert.rejects(exportPrivateRuntime({ manifest: { ...manifest, files: [{ ...file, path: '../secret' }] }, roots, output: path.join(temp, 'unsafe') }), /Unsafe/);
    await writeFile(path.join(input, 'main.js'), 'changed');
    const bad = path.join(temp, 'bad');
    await assert.rejects(exportPrivateRuntime({ manifest, roots, output: bad }), /hash mismatch/);
    await assert.rejects(access(path.join(bad, 'PACKAGE-COMPLETE.json')), { code: 'ENOENT' });
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith('charm-export-'));
    await rm(temp, { recursive: true, force: true });
  }
});
