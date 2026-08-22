import assert from "node:assert/strict";
import test from "node:test";
import {
  isHexLikeCollectionName,
  sanitizeOpenSeaCollectionName,
  sanitizeOpenSeaImageUrl,
} from "../../lib/market/multichain/discovery/opensea-stats";

test("hex-like OpenSea names are rejected, not stored as titles", () => {
  assert.equal(isHexLikeCollectionName("0xd38a5dd253e9819722f6a22d09dfe994b79fec9f"), true);
  assert.equal(isHexLikeCollectionName("d38a5dd253e9819722f6a22d09dfe994b79fec9f"), true);
  assert.equal(isHexLikeCollectionName("BloodLoop - OpenSea Collaboration"), false);
  assert.equal(sanitizeOpenSeaCollectionName("0x044c24377853442157f18f3517c943aaaa"), null);
  assert.equal(sanitizeOpenSeaCollectionName("BloodLoop - OpenSea Collaboration"), "BloodLoop - OpenSea Collaboration");
  assert.equal(sanitizeOpenSeaCollectionName("  null  "), null);
  assert.equal(sanitizeOpenSeaCollectionName(""), null);
});

test("image URLs must be real http(s), never null-string or relative junk", () => {
  assert.equal(sanitizeOpenSeaImageUrl(null), null);
  assert.equal(sanitizeOpenSeaImageUrl("null"), null);
  assert.equal(sanitizeOpenSeaImageUrl("not-a-url"), null);
  assert.equal(
    sanitizeOpenSeaImageUrl("https://i.seadn.io/gae/example"),
    "https://i.seadn.io/gae/example"
  );
});
