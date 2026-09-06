import assert from "node:assert/strict";
import test from "node:test";
import { FOREIGN_CHAINS } from "../../lib/market/multichain/trading/foreign-chain-registry";
import { allChainPlugins, chainPlugin, chainsMissingL1Coverage } from "../../lib/market/multichain/chain-plugin";

/**
 * External research brief's own framing: "a chain is a plugin row." Built
 * as a derived, read-only view over the existing chain registries (never
 * a second, independent source of chain truth -- see chain-plugin.ts's
 * own header for why hydrationJobSources' real, hard-won completion
 * gating is deliberately NOT replaced by this).
 */
test("every real FOREIGN_CHAINS entry produces exactly one plugin row", () => {
  const plugins = allChainPlugins();
  for (const chain of FOREIGN_CHAINS) {
    const plugin = plugins.find((p) => p.chainSlug === chain.chainSlug);
    assert.ok(plugin, `${chain.chainSlug} must have a real plugin row`);
    assert.equal(plugin!.l1Sources.includes("hypersync"), true, `${chain.chainSlug} must show real HyperSync L1 coverage`);
    assert.equal(plugin!.l2Sources.length > 0, chain.openSeaChain != null, `${chain.chainSlug}'s real OpenSea coverage must match FOREIGN_CHAINS' own openSeaChain field`);
  }
});

test("Robinhood Chain shows real HyperSync L1 coverage (fixed 2026-08-27, was OpenSea-only before)", () => {
  const plugin = chainPlugin("robinhood");
  assert.ok(plugin);
  assert.equal(plugin!.kind, "custom-evm");
  assert.ok(plugin!.l1Sources.includes("hypersync"));
});

test("Solana and Bitcoin correctly show no HyperSync L1 coverage -- real, honest, non-EVM limitation, not a bug", () => {
  const solana = chainPlugin("solana-mainnet");
  const bitcoin = chainPlugin("bitcoin-mainnet");
  assert.ok(solana && bitcoin);
  assert.equal(solana!.l1Sources.includes("hypersync"), false);
  assert.equal(bitcoin!.l1Sources.includes("hypersync"), false);
  assert.deepEqual(solana!.l1Sources, ["helius-das"]);
  assert.deepEqual(bitcoin!.l1Sources, ["unisat"]);
});

test("chainsMissingL1Coverage is empty right now -- the one real gap (Robinhood) was fixed tonight", () => {
  assert.deepEqual(chainsMissingL1Coverage(), []);
});

test("chainPlugin returns null for an unknown chain, never a fabricated entry", () => {
  assert.equal(chainPlugin("not-a-real-chain"), null);
});
