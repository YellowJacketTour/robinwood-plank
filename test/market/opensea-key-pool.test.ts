import assert from "node:assert/strict";
import test from "node:test";
import { configuredOpenSeaKeyCount } from "../../lib/market/multichain/discovery/opensea-key-pool";

const ORIGINAL = process.env.OPENSEA_API_KEYS;

function restore() {
  if (ORIGINAL === undefined) delete process.env.OPENSEA_API_KEYS;
  else process.env.OPENSEA_API_KEYS = ORIGINAL;
}

test("configuredOpenSeaKeyCount reflects the real pool size mesh-tick's semaphore must scale to", () => {
  try {
    delete process.env.OPENSEA_API_KEYS;
    assert.equal(configuredOpenSeaKeyCount(), 1, "unset OPENSEA_API_KEYS means the single managed/pinned key");

    process.env.OPENSEA_API_KEYS = "a,b,c,d,e,f,g";
    assert.equal(configuredOpenSeaKeyCount(), 7, "must count every distinct configured key");

    process.env.OPENSEA_API_KEYS = "a,a,a";
    assert.equal(configuredOpenSeaKeyCount(), 1, "must dedupe exactly like loadOpenSeaKeyPool does");

    process.env.OPENSEA_API_KEYS = Array.from({ length: 20 }, (_, i) => `key-${i}`).join(",");
    assert.equal(configuredOpenSeaKeyCount(), 10, "must cap at 10, matching loadOpenSeaKeyPool's own slice(0, 10)");

    process.env.OPENSEA_API_KEYS = "   ";
    assert.equal(configuredOpenSeaKeyCount(), 1, "blank/whitespace-only value falls back to the single-key count");
  } finally {
    restore();
  }
});
