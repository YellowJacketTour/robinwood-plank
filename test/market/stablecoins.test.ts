import assert from "node:assert/strict";
import test from "node:test";
import { findStablecoin, STABLECOINS_BY_CHAIN } from "../../lib/market/multichain/trading/stablecoins";

// Real chain IDs this app trades on (foreign-chain-registry.ts).
const ETHEREUM = 1;
const BASE = 8453;
const ARBITRUM = 42161;
const OPTIMISM = 10;
const POLYGON = 137;
const BNB = 56;
const AVALANCHE = 43114;

test("every chain this app trades on has at least one real stablecoin entry", () => {
  for (const chainId of [ETHEREUM, BASE, ARBITRUM, OPTIMISM, POLYGON, BNB, AVALANCHE]) {
    const entries = STABLECOINS_BY_CHAIN[chainId];
    assert.ok(entries && entries.length > 0, `chain ${chainId} has no stablecoin entries`);
  }
});

test("BNB Chain's USDT and USDC are BOTH 18 decimals -- the real, live-verified exception to the 6-decimal norm every other chain uses (see stablecoins.ts's own header)", () => {
  const usdt = findStablecoin(BNB, "USDT");
  const usdc = findStablecoin(BNB, "USDC");
  assert.equal(usdt?.decimals, 18);
  assert.equal(usdc?.decimals, 18);
});

test("every non-BNB chain's stablecoins are 6 decimals -- the standard USDC/USDT convention", () => {
  for (const chainId of [ETHEREUM, BASE, ARBITRUM, OPTIMISM, POLYGON, AVALANCHE]) {
    for (const entry of STABLECOINS_BY_CHAIN[chainId]) {
      assert.equal(entry.decimals, 6, `chain ${chainId} ${entry.symbol} should be 6 decimals, got ${entry.decimals}`);
    }
  }
});

test("findStablecoin returns null for a real chain with no entry for that symbol, never throws", () => {
  // Base only has USDC in this registry, no USDT entry.
  assert.equal(findStablecoin(BASE, "USDT"), null);
});

test("findStablecoin returns null for a chain this app doesn't route stablecoins on at all (e.g. Solana has no chainId in this EVM-only registry)", () => {
  assert.equal(findStablecoin(999999, "USDC"), null);
});

test("every stablecoin address is a real, well-formed 0x-prefixed 40-hex-char EVM address, not a placeholder", () => {
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  for (const [chainId, entries] of Object.entries(STABLECOINS_BY_CHAIN)) {
    for (const entry of entries) {
      assert.ok(
        addressPattern.test(entry.address),
        `chain ${chainId} ${entry.symbol} address "${entry.address}" is not a well-formed EVM address`
      );
    }
  }
});

test("no two stablecoin addresses collide across different chains (a real address MUST differ per-chain since these are separate deployments, never a shared/global token)", () => {
  const seen = new Map<string, string>();
  for (const [chainId, entries] of Object.entries(STABLECOINS_BY_CHAIN)) {
    for (const entry of entries) {
      const key = entry.address.toLowerCase();
      const label = `${chainId}:${entry.symbol}`;
      const existing = seen.get(key);
      // Same symbol reusing an address across DIFFERENT chains would mean
      // this registry accidentally copy-pasted one chain's deployment
      // onto another -- a real, fund-losing bug (paying "USDC on Base"
      // with an address that's actually Ethereum's USDC contract, which
      // doesn't exist as a real contract on Base).
      assert.ok(!existing, `duplicate address ${entry.address} used by both ${existing} and ${label}`);
      seen.set(key, label);
    }
  }
});

test("no chain lists the same symbol twice (USDC and USDT should each appear at most once per chain)", () => {
  for (const [chainId, entries] of Object.entries(STABLECOINS_BY_CHAIN)) {
    const symbols = entries.map((e) => e.symbol);
    const unique = new Set(symbols);
    assert.equal(symbols.length, unique.size, `chain ${chainId} lists a symbol more than once: ${symbols.join(",")}`);
  }
});
