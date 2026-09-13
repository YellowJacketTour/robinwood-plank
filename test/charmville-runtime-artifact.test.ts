import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openRuntimeArtifact, RuntimeArtifactError } from '../lib/charmville/runtime-artifact';

test('protected artifact primitives: allowlist, integrity, HEAD and unsafe inputs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'charm-artifact-'));
  try {
    await writeFile(path.join(root, 'zplayer.wasm'), 'wasm-fixture');
    const entry = { root: 'runtime', path: 'zplayer.wasm', route: '/zplayer.wasm', role: 'served', status: 'present', bytes: 12, sha256: createHash('sha256').update('wasm-fixture').digest('hex') };
    // Derive byte size independently so fixture edits cannot silently change intent.
    entry.bytes = Buffer.byteLength('wasm-fixture');
    const manifest = { schemaVersion: 1, scope: 'joined-homestead-private-inventory', completeInventory: true, issues: [], files: [entry] };
    const input = { roots: { repo: root, runtime: root, content: root, sprite: root }, manifest, configuredRelease: 'test-1', requestedRelease: 'test-1', route: '/zplayer.wasm', method: 'GET' };
    const rejects = (promise: Promise<unknown>, status: number) => assert.rejects(promise, error => error instanceof RuntimeArtifactError && error.status === status);
    await t.test('GET streams exact bytes, correct WASM MIME and private no-store', async () => {
      const result = await openRuntimeArtifact(input);
      const chunks = []; for await (const chunk of result.body!) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'wasm-fixture');
      assert.equal(result.headers['Content-Type'], 'application/wasm');
      assert.equal(result.headers['Cache-Control'], 'private, no-store');
    });
    await t.test('HEAD returns metadata with no stream', async () => {
      const result = await openRuntimeArtifact({ ...input, method: 'HEAD' });
      assert.equal(result.body, null); assert.equal(result.headers['Content-Length'], '12');
    });
    await t.test('wrong release, unsupported method and encoded/traversal requests cannot resolve', async () => {
      await rejects(openRuntimeArtifact({ ...input, requestedRelease: 'other' }), 404);
      await rejects(openRuntimeArtifact({ ...input, method: 'POST' }), 405);
      for (const route of ['/../zplayer.wasm', '/%2e%2e/zplayer.wasm', '/secret.env']) await rejects(openRuntimeArtifact({ ...input, route }), 404);
    });
    await t.test('duplicate routes and manifest escape fail closed', async () => {
      await rejects(openRuntimeArtifact({ ...input, manifest: { ...manifest, files: [entry, entry] } }), 503);
      await rejects(openRuntimeArtifact({ ...input, manifest: { ...manifest, files: [{ ...entry, path: '../secret' }] } }), 503);
      await rejects(openRuntimeArtifact({ ...input, manifest: { ...manifest, completeInventory: false } }), 503);
    });
    await t.test('same-length modified bytes fail SHA integrity', async () => {
      await writeFile(path.join(root, 'zplayer.wasm'), 'xxxx-fixture');
      await rejects(openRuntimeArtifact(input), 503);
      await writeFile(path.join(root, 'zplayer.wasm'), 'wasm-fixture');
    });
    await t.test('directory symlink or junction is rejected even when target remains inside root', async () => {
      await mkdir(path.join(root, 'actual'));
      await writeFile(path.join(root, 'actual', 'zplayer.wasm'), 'wasm-fixture');
      await symlink(path.join(root, 'actual'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      await rejects(openRuntimeArtifact({ ...input, manifest: { ...manifest, files: [{ ...entry, path: 'linked/zplayer.wasm' }] } }), 503);
    });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('charm-artifact-'));
    await rm(root, { recursive: true, force: true });
  }
});
