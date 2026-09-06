import assert from "node:assert/strict";
import test from "node:test";
import { CHAIN_MANIFESTS, chainManifest, deriveEvmChainIds, openSeaEvmSlugs, hypersyncEvmSlugs, coingeckoSlugs } from "../../lib/market/multichain/chains/manifest";
import { FOREIGN_CHAINS, chainDisplayName, chainBrandColor, chainGlyph, foreignOfferCurrency } from "../../lib/market/multichain/trading/foreign-chain-registry";
import { EVM_CHAIN_ID } from "../../lib/market/multichain/discovery/evm-log-scan";
import { ALCHEMY_NETWORK_SUBDOMAIN } from "../../lib/market/multichain/adapters/alchemy-network";
import { MESH_LANES } from "../../lib/market/multichain/mesh/matrix";
import { allChainPlugins } from "../../lib/market/multichain/chain-plugin";
import { CHAIN_VINES } from "../../lib/market/multichain/chain-vines";

/**
 * "Adding a chain must be one file plus a test." These assertions fail the
 * moment a registry is hand-edited to include a chain the manifest does
 * not know (manual wiring), or the manifest gains a chain a registry
 * silently drops.
 */

const slugs = new Set(CHAIN_MANIFESTS.map((m) => m.chainSlug));

test("manifest slugs are unique and every manifest is internally consistent", () => {
  assert.equal(slugs.size, CHAIN_MANIFESTS.length);
  for (const m of CHAIN_MANIFESTS) {
    if (m.kind === "evm" || m.kind === "custom-evm") assert.ok(m.chainId != null, `${m.chainSlug} EVM chain needs a chainId`);
    else assert.equal(m.chainId, null);
    if (m.foreignSeaportTrading) assert.ok(m.seaport && m.chainId != null, `${m.chainSlug} foreign trading needs Seaport + chainId`);
    if (m.hypersync) assert.ok(m.chainId != null, `${m.chainSlug} HyperSync is EVM-only`);
    assert.match(m.brandColor, /^#[0-9a-fA-F]{6}$/);
  }
});

test("FOREIGN_CHAINS is exactly the manifest's foreign-trading set (no manual wiring)", () => {
  const expected = CHAIN_MANIFESTS.filter((m) => m.foreignSeaportTrading).map((m) => m.chainSlug).sort();
  assert.deepEqual(FOREIGN_CHAINS.map((c) => c.chainSlug).sort(), expected);
  for (const c of FOREIGN_CHAINS) {
    const m = chainManifest(c.chainSlug)!;
    assert.equal(c.chainId, m.chainId);
    assert.equal(c.openSeaChain, m.openSeaChain);
    assert.equal(c.nativeCurrencySymbol, m.nativeCurrencySymbol);
  }
});

test("EVM_CHAIN_ID is exactly the manifest's EVM set", () => {
  assert.deepEqual(EVM_CHAIN_ID, deriveEvmChainIds());
});

test("ALCHEMY_NETWORK_SUBDOMAIN lists exactly the manifest chains that declare an Alchemy subdomain", () => {
  const expected = Object.fromEntries(CHAIN_MANIFESTS.filter((m) => m.alchemySubdomain).map((m) => [m.chainSlug, m.alchemySubdomain]));
  assert.deepEqual(ALCHEMY_NETWORK_SUBDOMAIN, expected);
});

test("display name, brand color, glyph and offer currency come from the manifest", () => {
  for (const m of CHAIN_MANIFESTS) {
    assert.equal(chainDisplayName(m.chainSlug), m.displayName);
    assert.equal(chainBrandColor(m.chainSlug), m.brandColor);
    assert.equal(chainGlyph(m.chainSlug), m.glyph);
    assert.equal(foreignOfferCurrency(m.chainSlug), m.offerCurrencyAddress);
  }
  assert.equal(chainDisplayName("solana"), "Solana", "bare alias still resolves");
});

test("every mesh lane's chain is a manifest chain, and manifest-derived lane sets match the matrix", () => {
  for (const lane of MESH_LANES) assert.ok(slugs.has(lane.chainSlug), `lane ${lane.id} names a chain missing from the manifest`);
  const laneChains = (source: string) => [...new Set(MESH_LANES.filter((l) => l.source === source).map((l) => l.chainSlug))].sort();
  assert.deepEqual(laneChains("opensea-stats").filter((c) => c !== "robinhood"), openSeaEvmSlugs().sort());
  assert.deepEqual(laneChains("hypersync-discovery"), hypersyncEvmSlugs().sort());
  assert.deepEqual(laneChains("coingecko-nft"), coingeckoSlugs().sort());
});

test("chain-plugin and chain-vines cover every manifest chain and nothing else", () => {
  assert.deepEqual(allChainPlugins().map((p) => p.chainSlug).sort(), [...slugs].sort());
  for (const v of CHAIN_VINES) assert.ok(slugs.has(v.chainSlug), `vine ${v.chainSlug} is not in the manifest`);
  for (const s of slugs) assert.ok(CHAIN_VINES.some((v) => v.chainSlug === s), `manifest chain ${s} has no vine`);
});
