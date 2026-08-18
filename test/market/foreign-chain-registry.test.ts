import assert from "node:assert/strict";
import test from "node:test";
import {
  FOREIGN_CHAINS,
  foreignChainByChainSlug,
  foreignAcrossReceiverAddress,
  foreignDeBridgeExecutorAddress,
  foreignFeeRouterAddress,
  chainBrandColor,
  chainGlyph,
  chainDisplayName,
} from "../../lib/market/multichain/trading/foreign-chain-registry";

test("foreignChainByChainSlug returns null (never throws) for an unknown chain", () => {
  assert.equal(foreignChainByChainSlug("not-a-real-chain"), null);
});

test("every real foreign chain resolves by its own slug", () => {
  for (const chain of FOREIGN_CHAINS) {
    assert.equal(foreignChainByChainSlug(chain.chainSlug)?.chainSlug, chain.chainSlug);
  }
});

test("avax-mainnet has no Across receiver address, by design -- Across has no Avalanche deployment at all (see the registry's own header)", () => {
  assert.equal(foreignAcrossReceiverAddress("avax-mainnet"), null);
});

test("no chain has a deployed Across receiver address yet -- this is the real, current state (contracts are written/tested but undeployed everywhere); this test is a canary that will correctly start failing the moment a real deploy happens, which is the point", () => {
  for (const chain of FOREIGN_CHAINS) {
    assert.equal(
      foreignAcrossReceiverAddress(chain.chainSlug),
      null,
      `${chain.chainSlug} unexpectedly has a non-null Across receiver -- if this is a REAL deploy, update this test to assert the real address instead of null`
    );
  }
});

test("only bnb-mainnet is a real deBridge origin -- the deBridge path exists specifically because Across doesn't route BNB Chain", () => {
  // deBridge executor addresses are keyed by DESTINATION chain (every chain
  // except bnb-mainnet itself, since BNB is the one chain that's always the
  // ORIGIN for this path -- see debridge-quote.ts's own header).
  assert.equal(foreignDeBridgeExecutorAddress("bnb-mainnet"), null, "bnb-mainnet should not appear as a deBridge DESTINATION");
});

test("foreignAcrossReceiverAddress and foreignDeBridgeExecutorAddress never throw for a nonsense chain slug -- both fail closed to null", () => {
  assert.equal(foreignAcrossReceiverAddress("nonsense"), null);
  assert.equal(foreignDeBridgeExecutorAddress("nonsense"), null);
  assert.equal(foreignFeeRouterAddress("nonsense"), null);
});

test("every real foreign chain has a non-empty brand color and glyph, so the UI never silently renders a blank chain badge", () => {
  for (const chain of FOREIGN_CHAINS) {
    const color = chainBrandColor(chain.chainSlug);
    const glyph = chainGlyph(chain.chainSlug);
    assert.ok(color && color.length > 0, `${chain.chainSlug} has no brand color`);
    assert.ok(glyph && glyph.length > 0, `${chain.chainSlug} has no glyph`);
  }
});

test("chainDisplayName never returns an empty string for a real chain", () => {
  for (const chain of FOREIGN_CHAINS) {
    assert.ok(chainDisplayName(chain.chainSlug).length > 0);
  }
});

test("chainDisplayName falls back to something (not empty/undefined) for an unknown slug rather than throwing", () => {
  assert.ok(chainDisplayName("totally-unknown-chain").length > 0);
});
