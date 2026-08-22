import assert from "node:assert/strict";
import test from "node:test";
import { resolveOriginalMediaUrl, withImageWidth, withOriginalMedia } from "../../lib/ipfs";

// Real, confirmed live 2026-08-19: Alchemy's own openSeaMetadata pass-
// through returns the literal 4-character string "null" for some
// collections' imageUrl (verified via a direct getContractMetadata call),
// not a real JSON null. That string is truthy, so a plain `!url` check
// never caught it, and it sailed straight into Next's <Image src=...>,
// throwing "invalid src prop" the moment a user clicked into an affected
// collection. These tests lock in withImageWidth's sanitization of that
// exact poison, plus the adjacent "undefined"/whitespace-only cases the
// same upstream bug class can plausibly also produce.

test("withImageWidth returns empty string for the literal string 'null' -- the real, confirmed upstream poison value", () => {
  assert.equal(withImageWidth("null", 256), "");
  assert.equal(withImageWidth("NULL", 256), "");
  assert.equal(withImageWidth("  null  ", 256), "");
});

test("withImageWidth returns empty string for 'undefined' and whitespace-only, the same poison class", () => {
  assert.equal(withImageWidth("undefined", 256), "");
  assert.equal(withImageWidth("   ", 256), "");
});

test("withImageWidth still returns a real URL unchanged when given one", () => {
  const real = "https://i2c.seadn.io/base/abc/def.png";
  assert.equal(withImageWidth(real, 256), real);
});

test("withImageWidth returns empty string (never throws) for null/undefined input, unchanged from before this fix", () => {
  assert.equal(withImageWidth(null, 256), "");
  assert.equal(withImageWidth(undefined, 256), "");
});

test("width thumbnails use the current poster cache generation", () => {
  const proxied = "/api/ipfs/image?uri=https%3A%2F%2Fipfs.io%2Fipfs%2Fabc";
  assert.equal(withImageWidth(proxied, 512), `${proxied}&w=512&cv=3`);
});

test("withOriginalMedia removes poster sizing for a focused animated detail", () => {
  const poster = "/api/ipfs/image?uri=https%3A%2F%2Fipfs.io%2Fipfs%2Fabc&w=512&cv=2";
  assert.equal(
    withOriginalMedia(poster),
    "/api/ipfs/image?uri=https%3A%2F%2Fipfs.io%2Fipfs%2Fabc&cv=3"
  );
  assert.equal(withOriginalMedia("null"), "");
  assert.equal(withOriginalMedia("https://cdn.example/art.gif"), "https://cdn.example/art.gif");
});

test("resolveOriginalMediaUrl preserves HTTP motion and unwraps a same-origin poster proxy", () => {
  assert.equal(resolveOriginalMediaUrl("ipfs://bafy/video.mp4"), "https://gateway.pinata.cloud/ipfs/bafy/video.mp4");
  assert.equal(
    resolveOriginalMediaUrl("/api/ipfs/image?uri=https%3A%2F%2Farweave.net%2Ftx&w=512&cv=3"),
    "https://arweave.net/tx"
  );
  assert.equal(resolveOriginalMediaUrl("undefined"), "");
});
