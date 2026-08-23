import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLECTION_SURFACES, collectionSurface } from "../../lib/market/multichain/collection-surface";
import { catalogArtExtras } from "../../lib/market/multichain/token-art-templates";

describe("collection surface", () => {
  it("covers every hub vine", () => {
    for (const c of [
      "eth-mainnet",
      "polygon-mainnet",
      "base-mainnet",
      "arb-mainnet",
      "opt-mainnet",
      "bnb-mainnet",
      "avax-mainnet",
      "solana-mainnet",
      "bitcoin-mainnet",
      "robinhood",
    ]) {
      assert.ok(COLLECTION_SURFACES[c], c);
      assert.ok(collectionSurface(c).bookPageSize >= 50);
    }
  });

  it("does not impose RobinWood's supply on every Robinhood collection", () => {
    assert.equal("catalogCap" in collectionSurface("robinhood"), false);
  });

  it("gives Milady a proven extra and unknown EVM none", () => {
    const milady = catalogArtExtras(
      "eth-mainnet",
      "0x5Af0D9827E0c53E31634944c487d43a2b04f8e38",
      "12"
    );
    assert.ok(milady[0]?.includes("miladymaker.net/milady/12.png"));
    assert.deepEqual(catalogArtExtras("eth-mainnet", "0x0000000000000000000000000000000000000001", "1"), []);
  });

  it("gives Bitcoin inscription content extras", () => {
    const id = `${"ab".repeat(32)}i0`;
    const extras = catalogArtExtras("bitcoin-mainnet", id, id);
    assert.ok(extras.some((u) => u.includes("ordinals.com/content/")));
  });
});
