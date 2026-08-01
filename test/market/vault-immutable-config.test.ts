import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

/**
 * mintFeeBps, redeemFeeBps and targetPremiumBps are `immutable` in
 * contracts/MarketplankVault.sol (legacy, share-fee vaults); mintFeeWei,
 * redeemFeeWei, targetPremiumWei and swapFeeBps are `immutable` in
 * contracts/MarketplankVaultV3.sol (current-generation, eth-fee vaults) —
 * constructor-set, no setter, either way. The vault SSE stream ticks every 8s,
 * which is longer than the 5s rpc-cache TTL, so re-reading them meant paying
 * CU forever for numbers that are physically incapable of changing. This is
 * the mistake CONTRIBUTING.md records against MintPanel; these tests stop it
 * coming back a third time, for both fee models.
 */

const legacyContractUrl = new URL("../../contracts/MarketplankVault.sol", import.meta.url);
const v3ContractUrl = new URL("../../contracts/MarketplankVaultV3.sol", import.meta.url);
const statsUrl = new URL("../../lib/market/vault-stats.ts", import.meta.url);

/** readCoreVaultState brackets its two per-model live batches with these
 *  sentinel comments (see lib/market/vault-stats.ts) specifically so this
 *  test doesn't have to hand-roll brace matching over TypeScript source —
 *  the function's own return-type annotation is an inline object literal
 *  (`Promise<{ ... }>`), which defeats naive "find the next line starting
 *  with '}'" slicing. */
function liveBatchBody(source: string): string {
  const start = source.indexOf("LIVE_BATCH_START");
  const end = source.indexOf("LIVE_BATCH_END");
  if (start < 0 || end < 0) throw new Error("could not locate readCoreVaultState's live batch markers");
  return source.slice(start, end);
}

/** getImmutableVaultConfig / getImmutableVaultV3Config both return a plain
 *  named type (no inline object-literal return type), so their bodies are
 *  a plain function-name-to-function-name slice. */
function functionBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`);
  if (start < 0 || end < 0) throw new Error(`could not locate ${name}..${nextName}`);
  return source.slice(start, end);
}

test("legacy fee/premium getters really are immutable on-chain, with no setter", async () => {
  const sol = await fs.readFile(legacyContractUrl, "utf8");
  for (const name of ["mintFeeBps", "redeemFeeBps", "targetPremiumBps"]) {
    assert.match(
      sol,
      new RegExp(`immutable\\s+${name}\\b`),
      `${name} must be declared immutable — the caching below depends on it`
    );
    assert.ok(
      !new RegExp(`function\\s+set${name[0].toUpperCase()}${name.slice(1)}`, "i").test(sol),
      `${name} must have no setter`
    );
  }
});

test("V3 fee/premium/swap-fee getters really are immutable on-chain, with no setter", async () => {
  const sol = await fs.readFile(v3ContractUrl, "utf8");
  for (const name of ["mintFeeWei", "redeemFeeWei", "targetPremiumWei", "swapFeeBps"]) {
    assert.match(
      sol,
      new RegExp(`immutable\\s+${name}\\b`),
      `${name} must be declared immutable — the caching below depends on it`
    );
    assert.ok(
      !new RegExp(`function\\s+set${name[0].toUpperCase()}${name.slice(1)}`, "i").test(sol),
      `${name} must have no setter`
    );
  }
});

test("readCoreVaultState (both models) reads only values that can change", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const body = liveBatchBody(source);
  for (const mutable of ["ethReserve", "balanceOf", "shareReserve", "heldTokenCount", "poolOpen"]) {
    assert.ok(body.includes(mutable), `${mutable} genuinely changes and must stay in the batch`);
  }
  for (const immutableGetter of [
    "mintFeeBps",
    "redeemFeeBps",
    "targetPremiumBps",
    "mintFeeWei",
    "redeemFeeWei",
    "targetPremiumWei",
    "swapFeeBps",
  ]) {
    assert.ok(
      !body.includes(immutableGetter),
      `${immutableGetter} is immutable and must not be re-read on every refresh`
    );
  }
});

test("readCoreVaultState issues exactly four calls per branch (legacy + V3)", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const body = liveBatchBody(source);
  const calls = body.match(/encodeFunctionData\(/g) ?? [];
  assert.equal(calls.length, 8, "four mutable getters per model, two models, per refresh");
});

test("immutable getters live only in the two config-cache functions", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const legacyBody = functionBody(source, "getImmutableVaultConfig", "clearImmutableVaultConfigCache");
  for (const name of ["mintFeeBps", "redeemFeeBps", "targetPremiumBps"]) {
    assert.ok(legacyBody.includes(name), `${name} must be read by getImmutableVaultConfig`);
  }
  const v3Start = source.indexOf("async function getImmutableVaultV3Config(");
  const v3End = source.indexOf("/** Test/ops hook");
  assert.ok(v3Start >= 0 && v3End > v3Start, "could not locate getImmutableVaultV3Config");
  const v3Body = source.slice(v3Start, v3End);
  for (const name of ["mintFeeWei", "redeemFeeWei", "targetPremiumWei", "swapFeeBps"]) {
    assert.ok(v3Body.includes(name), `${name} must be read by getImmutableVaultV3Config`);
  }
});
