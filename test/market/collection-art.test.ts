import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  imageSrcFallbacks,
  preferHighestResImageUrl,
  isRenderableArtUrl,
} from "../../lib/market/collection-art";

describe("collection art URLs", () => {
  it("keeps RobinWood same-origin logo (the hub home row)", () => {
    const src = "/images/plank-logo.webp";
    assert.equal(isRenderableArtUrl(src), true);
    assert.deepEqual(imageSrcFallbacks(src), [src]);
    assert.equal(preferHighestResImageUrl(src), src);
  });

  it("keeps already-proxied /api/ipfs paths", () => {
    const src = "/api/ipfs/image?uri=https://example.com/a.png";
    assert.deepEqual(imageSrcFallbacks(src), [src]);
  });

  it("keeps ipfs:// CIDs", () => {
    const src = "ipfs://QmTest/1.png";
    assert.deepEqual(imageSrcFallbacks(src), [src]);
  });

  it("still prefers CoinGecko /large/ over /small/", () => {
    const src = "https://coin-images.coingecko.com/nft_contracts/images/3683/small/wizards.png";
    const list = imageSrcFallbacks(src);
    assert.ok(list[0]?.includes("/large/"));
    assert.ok(list.includes(src));
  });

  it("rejects poisoned strings", () => {
    assert.deepEqual(imageSrcFallbacks("null"), []);
    assert.deepEqual(imageSrcFallbacks(""), []);
    assert.equal(preferHighestResImageUrl("undefined"), null);
  });
});
