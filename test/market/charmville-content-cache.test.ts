import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { charmvilleAssetUrl, charmvilleAssetFromSource, CHARMVILLE_CONTENT_REVISION } from "../../lib/charmville/content";

const publicRoot = resolve(process.cwd(), "public");
const bytesAt = (url: string) => readFile(resolve(publicRoot, `.${url}`));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("published cache is complete, content addressed, and preserves supported revisions", async () => {
  const index = JSON.parse(await readFile(resolve(publicRoot, "images/charmville/cache/cache.idx"), "utf8"));
  assert.equal(index.latest, CHARMVILLE_CONTENT_REVISION);
  assert.deepEqual(index.supported, index.revisions.slice(0, 2).map((item: { revision: string }) => item.revision));
  for (const entry of index.revisions) {
    const raw = await bytesAt(entry.url);
    assert.equal(sha(raw), entry.sha256);
    assert.equal(raw.length, entry.bytes);
    const manifest = JSON.parse(raw.toString());
    const { revision, ...body } = manifest;
    assert.equal(sha(Buffer.from(JSON.stringify(body, null, 2) + "\n")), revision);
    const definitions = await bytesAt(manifest.definitions.url);
    assert.equal(sha(definitions), manifest.definitions.sha256);
    assert.equal(definitions.length, manifest.definitions.bytes);
    for (const asset of Object.values(manifest.assets) as { url: string; sha256: string; bytes: number }[]) {
      const bytes = await bytesAt(asset.url);
      assert.equal(sha(bytes), asset.sha256, asset.url);
      assert.equal(bytes.length, asset.bytes, asset.url);
    }
    const defs = JSON.parse(definitions.toString());
    for (const crop of defs.crops) for (const id of Object.values(crop.stages) as string[]) assert.ok(manifest.assets[id]);
    for (const animation of defs.animations) for (const id of animation.directions) assert.ok(manifest.assets[id]);
    for (const item of defs.workshop ?? []) {
      const source = defs.authoring.sources[item.authoringSource];
      const sourceBytes = await bytesAt(source.url);
      assert.equal(sha(sourceBytes), source.sha256);
      assert.equal(sourceBytes.length, source.bytes);
      assert.equal(source.mime, "application/x-blender");
      assert.ok(source.generator && source.author && source.license);
      for (const variant of ["image", "image3x", "model"]) {
        if (!item[variant]) continue;
        const asset = manifest.assets[item[variant]];
        assert.equal(asset.authoringSource, item.authoringSource);
        if (variant === "model") {
          assert.equal(asset.mime, "model/gltf-binary");
          assert.equal(asset.width, undefined);
          const bytes = await bytesAt(asset.url);
          assert.equal(bytes.toString("utf8", 0, 4), "glTF");
          assert.equal(bytes.readUInt32LE(8), bytes.length);
        } else {
          assert.equal(asset.mime, "image/png");
          assert.deepEqual([asset.width, asset.height], item.frameSize.map((size: number) => size * (variant === "image3x" ? 3 : 1)));
        }
      }
    }
  }
});

test("renderer resolves stable IDs and old scene sources to the same pinned bytes", () => {
  assert.equal(charmvilleAssetUrl("crop:stalk:ripe"), charmvilleAssetFromSource("/images/charmville/original/stalk-ripe.png"));
  assert.match(charmvilleAssetUrl("character:walk:0"), /\/cache\/assets\/[a-f0-9]{64}\.webp$/);
  assert.equal(charmvilleAssetFromSource("/images/other.png"), "/images/other.png");
  assert.equal(charmvilleAssetUrl("workshop:cottage:model"), charmvilleAssetFromSource("/images/charmville/workshop/seed-cottage.glb"));
  assert.equal(charmvilleAssetUrl("workshop:blossom:image3x"), charmvilleAssetFromSource("/images/charmville/workshop/blossom-tree@3x.png"));
});
