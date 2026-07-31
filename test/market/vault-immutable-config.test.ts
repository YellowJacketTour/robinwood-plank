import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

/**
 * mintFeeBps, redeemFeeBps and targetPremiumBps are `immutable` in
 * contracts/MarketplankVault.sol — constructor-set, no setter. The vault SSE
 * stream ticks every 8s, which is longer than the 5s rpc-cache TTL, so re-reading
 * them meant paying 3 x 26 CU forever for three numbers that are physically
 * incapable of changing. This is the mistake CONTRIBUTING.md records against
 * MintPanel; these tests stop it coming back a third time.
 */

const contractUrl = new URL("../../contracts/MarketplankVault.sol", import.meta.url);
const statsUrl = new URL("../../lib/market/vault-stats.ts", import.meta.url);

/**
 * The getters re-read on every stats refresh, as source text. Sliced rather
 * than regexed to the first "]", because encodeFunctionData("balanceOf",
 * [vault]) contains one.
 */
function liveBatchBody(source: string): string {
  const start = source.indexOf("ethCallMany([", source.indexOf("const [coreHexes,"));
  const end = source.indexOf("getImmutableVaultConfig(vault)", start);
  if (start < 0 || end < 0) throw new Error("could not locate the per-refresh batch");
  return source.slice(start, end);
}

test("the fee and premium getters really are immutable on-chain", async () => {
  const sol = await fs.readFile(contractUrl, "utf8");
  for (const name of ["mintFeeBps", "redeemFeeBps", "targetPremiumBps"]) {
    assert.match(
      sol,
      new RegExp(`immutable\\s+${name}\\b`),
      `${name} must be declared immutable — the caching below depends on it`
    );
    // A setter would invalidate process-lifetime caching outright.
    assert.ok(
      !new RegExp(`function\\s+set${name[0].toUpperCase()}${name.slice(1)}`, "i").test(sol),
      `${name} must have no setter`
    );
  }
});

test("the live stats batch reads only values that can change", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const body = liveBatchBody(source);
  for (const mutable of ["ethReserve", "balanceOf", "heldTokenCount", "poolOpen"]) {
    assert.ok(body.includes(mutable), `${mutable} genuinely changes and must stay in the batch`);
  }
  for (const immutableGetter of ["mintFeeBps", "redeemFeeBps", "targetPremiumBps"]) {
    assert.ok(
      !body.includes(immutableGetter),
      `${immutableGetter} is immutable and must not be re-read on every refresh`
    );
  }
});

test("the per-refresh batch dropped from seven calls to four", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const calls = liveBatchBody(source).match(/encodeFunctionData\(/g) ?? [];
  assert.equal(calls.length, 4, "four mutable getters per refresh, down from seven");
});
