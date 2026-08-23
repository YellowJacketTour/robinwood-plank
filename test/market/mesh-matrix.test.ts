import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MESH_LANES } from "../../lib/market/multichain/mesh/matrix";
import { sourceJailKey } from "../../lib/market/multichain/mesh/jail";

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
    assert.ok(eth.includes("cryptopunks-native"));
    assert.ok(eth.includes("coingecko-nft"));
  });

  it("runs independent live and genesis fill lanes on every EVM chain", () => {
    for (const chain of [
      "eth-mainnet", "polygon-mainnet", "arb-mainnet", "base-mainnet",
      "opt-mainnet", "bnb-mainnet", "avax-mainnet", "zksync-mainnet",
    ]) {
      const sources = MESH_LANES.filter((lane) => lane.chainSlug === chain).map((lane) => lane.source);
      assert.ok(sources.includes("hypersync-discovery"), `missing live discovery on ${chain}`);
      assert.ok(sources.includes("hypersync-backfill"), `missing genesis discovery on ${chain}`);
      assert.ok(sources.includes("seaport-fills"), `missing live fills on ${chain}`);
      assert.ok(sources.includes("seaport-fills-genesis"), `missing genesis fills on ${chain}`);
      assert.ok(sources.includes("evm-metadata"), `missing first-party metadata enrichment on ${chain}`);
    }
  });

  it("keeps Robinhood live discovery independent from its genesis walk", () => {
    const sources = MESH_LANES.filter((lane) => lane.chainSlug === "robinhood").map((lane) => lane.source);
    assert.ok(sources.includes("robinhood-discovery"));
    assert.ok(sources.includes("robinhood-backfill"));
  });

  it("gives Bitcoin art a path that is not UniSat-only", () => {
    const btc = MESH_LANES.filter((l) => l.chainSlug === "bitcoin-mainnet").map((l) => l.source);
    assert.ok(btc.includes("ordinals-wallet"));
    assert.ok(btc.includes("unisat-collections"));
  });

  it("jails 429 per source×chain, not the whole vendor", () => {
    assert.equal(sourceJailKey("opensea-stats", "eth-mainnet"), "plank:market:source-jail-until:opensea-stats:eth-mainnet");
    assert.notEqual(sourceJailKey("opensea-stats", "eth-mainnet"), sourceJailKey("opensea-stats", "opt-mainnet"));
    assert.equal(sourceJailKey("opensea-stats"), "plank:market:source-jail-until:opensea-stats");
  });
});
