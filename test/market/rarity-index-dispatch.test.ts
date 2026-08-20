import assert from "node:assert/strict";
import test from "node:test";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { itemCeiling, rarityIndexBackend } from "@/lib/market/multichain/rarity-index-runner";

test("Solana always uses Helius grouping, never OpenSea", () => {
  assert.equal(rarityIndexBackend("solana-mainnet", "MadLadsNftxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "helius");
  assert.equal(rarityIndexBackend("solana-mainnet", "0x1234567890123456789012345678901234567890"), "helius");
});

test("Bitcoin always uses UniSat activity walk, never OpenSea", () => {
  assert.equal(rarityIndexBackend("bitcoin-mainnet", "bitcoin-frogs"), "unisat");
  assert.equal(rarityIndexBackend("bitcoin-mainnet", "0x1234567890123456789012345678901234567890"), "unisat");
});

test("Avalanche and every OpenSea EVM chain share the slug/contract backends", () => {
  assert.equal(foreignChainByChainSlug("avax-mainnet")?.openSeaChain, "avalanche");
  for (const chain of ["avax-mainnet", "eth-mainnet", "base-mainnet", "polygon-mainnet", "arb-mainnet", "opt-mainnet", "bnb-mainnet"]) {
    assert.equal(rarityIndexBackend(chain, "some-slug"), "opensea-slug");
    assert.equal(rarityIndexBackend(chain, "0x1234567890123456789012345678901234567890"), "opensea-contract");
  }
});

test("itemCeiling never walks unbounded 10k+ collections on first pass", () => {
  assert.equal(itemCeiling(null), 1000);
  assert.equal(itemCeiling(10), 10);
  assert.equal(itemCeiling(500), 1000);
  assert.equal(itemCeiling(5000), 2000);
  assert.equal(itemCeiling(100_000), 5000);
});
