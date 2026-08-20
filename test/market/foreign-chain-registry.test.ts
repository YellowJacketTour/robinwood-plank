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
  nativeCurrencySymbol,
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

// nativeCurrencySymbol -- extracted from the two ternaries that used to be
// duplicated in MultichainCollectionView.tsx (ForeignOfferForm's
// currencySymbol prop and ForeignOfferConfirm's), so this is the real,
// copied-not-invented mapping.
test("nativeCurrencySymbol returns SOL whenever isSolana is true, regardless of chainSlug", () => {
  assert.equal(nativeCurrencySymbol("solana-mainnet", true), "SOL");
  assert.equal(nativeCurrencySymbol("eth-mainnet", true), "SOL");
});

test("nativeCurrencySymbol returns the real per-chain wrapped-gas symbol for BNB Chain and Avalanche", () => {
  assert.equal(nativeCurrencySymbol("bnb-mainnet", false), "WBNB");
  assert.equal(nativeCurrencySymbol("avax-mainnet", false), "WAVAX");
});

test("nativeCurrencySymbol defaults to WETH for every other EVM chain (matches the original duplicated ternaries' default)", () => {
  assert.equal(nativeCurrencySymbol("eth-mainnet", false), "WETH");
  assert.equal(nativeCurrencySymbol("polygon-mainnet", false), "WETH");
  assert.equal(nativeCurrencySymbol("base-mainnet", false), "WETH");
  assert.equal(nativeCurrencySymbol("totally-unknown-chain", false), "WETH");
});

test("nativeCurrencySymbol returns BTC when isBitcoin is true -- real bug found live 2026-08-19: MultichainCollectionView never passed isBitcoin through despite computing it, so every Bitcoin Ordinals collection's floor/best-offer/volume/highest-sale fell through to the WETH default", () => {
  assert.equal(nativeCurrencySymbol("bitcoin-mainnet", false, true), "BTC");
  assert.equal(nativeCurrencySymbol("bitcoin-testnet4", false, true), "BTC");
});

test("nativeCurrencySymbol prioritizes isSolana over isBitcoin if a caller somehow passes both true (isSolana checked first)", () => {
  assert.equal(nativeCurrencySymbol("solana-mainnet", true, true), "SOL");
});
