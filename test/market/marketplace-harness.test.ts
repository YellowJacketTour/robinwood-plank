import assert from "node:assert/strict";
import test from "node:test";
import { rarityIndexBackend } from "@/lib/market/multichain/rarity-index-runner";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import {
  BITCOIN_CHAIN_SLUG,
  ROBINHOOD_CHAIN_SLUG,
  SOLANA_CHAIN_SLUG,
  isBitcoinChainSlug,
  isNonEvmChainSlug,
  isRobinhoodChainSlug,
  isSolanaChainSlug,
} from "@/lib/market/multichain/trading/non-evm-chains";
import { isCrossChainBuyable } from "@/lib/market/types";
import { looksLikeSolanaPubkey } from "@/lib/market/multichain/solana-pubkey";

/** One table: every live chain slug this marketplace recognizes. */
const EVM_OPENSEA = ["eth-mainnet", "avax-mainnet", "base-mainnet", "polygon-mainnet", "arb-mainnet", "opt-mainnet", "bnb-mainnet"] as const;

test("harness: rarity enumerator per chain family", () => {
  assert.equal(rarityIndexBackend(SOLANA_CHAIN_SLUG, "claynosaurz"), "helius");
  assert.equal(rarityIndexBackend(BITCOIN_CHAIN_SLUG, "bitcoin-frogs"), "unisat");
  for (const chain of EVM_OPENSEA) {
    assert.equal(foreignChainByChainSlug(chain)?.openSeaChain != null, true);
    assert.equal(rarityIndexBackend(chain, "slug"), "opensea-slug");
  }
  assert.equal(foreignChainByChainSlug("zksync-mainnet")?.openSeaChain ?? null, null);
});

test("harness: chain slug identity is not invented", () => {
  assert.equal(isSolanaChainSlug("solana-mainnet"), true);
  assert.equal(isBitcoinChainSlug("bitcoin-mainnet"), true);
  assert.equal(isRobinhoodChainSlug(ROBINHOOD_CHAIN_SLUG), true);
  assert.equal(isNonEvmChainSlug("eth-mainnet"), false);
  assert.equal(looksLikeSolanaPubkey("Claynosaurz"), false);
});

test("harness: buy is fail-closed without venue + foreign order hash", () => {
  assert.equal(isCrossChainBuyable({ venue: "magiceden", foreignChainSlug: SOLANA_CHAIN_SLUG }), false);
  assert.equal(
    isCrossChainBuyable({
      venue: "magiceden",
      foreignChainSlug: SOLANA_CHAIN_SLUG,
      foreignOrderHash: "Dq4vxvvxMBJaZAKoBDrVuG9FCLfQXGe59PYVX2XdpcJm",
    }),
    true
  );
});
