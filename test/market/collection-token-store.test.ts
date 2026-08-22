import assert from "node:assert/strict";
import test from "node:test";
import { decodeTokenCursor, encodeTokenCursor } from "../../lib/market/multichain/collection-token-store";

test("collection token cursors round-trip opaque token identifiers", () => {
  for (const id of ["42", "0xabc/def+ghi", "inscription:i0", "mint-unicode-ü"]) {
    const cursor = encodeTokenCursor(id);
    assert.equal(decodeTokenCursor(cursor), id);
    assert.equal(cursor.includes(id), false);
  }
});

test("collection token cursor rejects malformed and non-canonical values", () => {
  assert.equal(decodeTokenCursor(null), null);
  assert.equal(decodeTokenCursor(""), null);
  assert.equal(decodeTokenCursor("%%%not-base64%%%"), null);
  assert.equal(decodeTokenCursor("YQ=="), null);
});
