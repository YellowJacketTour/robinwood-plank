import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MESH_LANES } from "../../lib/market/multichain/mesh/matrix";

describe("sync mesh matrix", () => {
  it("has unique lane ids", () => {
    const ids = MESH_LANES.map((l) => l.id);
    assert.equal(ids.length, new Set(ids).size);
  });

  it("covers genesis RobinWood and all hub vines", () => {
    const chains = new Set(MESH_LANES.map((l) => l.chainSlug));
    for (const c of [
      "robinhood",
      "eth-mainnet",
      "polygon-mainnet",
      "base-mainnet",
      "arb-mainnet",
      "opt-mainnet",
      "bnb-mainnet",
      "avax-mainnet",
      "solana-mainnet",
      "bitcoin-mainnet",
    ]) {
      assert.ok(chains.has(c), `missing chain ${c}`);
    }
  });

  it("never lists alchemy as a lane source", () => {
    for (const lane of MESH_LANES) {
      assert.notEqual(lane.source, "alchemy-nft");
    }
  });

  it("gives EVM at least two independent stats sources (OS + CG)", () => {
    const eth = MESH_LANES.filter((l) => l.chainSlug === "eth-mainnet").map((l) => l.source);
    assert.ok(eth.includes("opensea-stats"));
    assert.ok(eth.includes("coingecko-nft"));
  });

  it("gives Bitcoin art a path that is not UniSat-only", () => {
    const btc = MESH_LANES.filter((l) => l.chainSlug === "bitcoin-mainnet").map((l) => l.source);
    assert.ok(btc.includes("ordinals-wallet"));
    assert.ok(btc.includes("unisat-collections"));
  });
});
