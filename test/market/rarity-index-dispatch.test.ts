import assert from "node:assert/strict";
import test from "node:test";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { rarityIndexBackend } from "@/lib/market/multichain/rarity-index-runner";

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
