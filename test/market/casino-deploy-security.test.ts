import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, root), "utf8");
}

test("production casino deployment is chain-pinned and validates venue identity", async () => {
  const deploy = await source("scripts/deploy-casino.ts");

  assert.match(deploy, /net\.chainId !== 4663n/);
  assert.match(deploy, /provider\.getCode\(address\)/);
  assert.match(deploy, /pair\.token0\(\)/);
  assert.match(deploy, /pair\.token1\(\)/);
  assert.match(deploy, /pair\.factory\(\)/);
  assert.match(deploy, /router\.factory\(\)/);
  assert.match(deploy, /router\.WETH\(\)/);
  assert.match(deploy, /Pair\/router factory mismatch/);
  assert.match(deploy, /Router WETH mismatch/);
});

test("production allocation defaults remain 40 burn / 40 Powerboard / 20 founder", async () => {
  const deploy = await source("scripts/deploy-casino.ts");

  assert.match(deploy, /envBig\("CASINO_BURN_BPS", 4000n\)/);
  assert.match(deploy, /envBig\("CASINO_AIRDROP_BPS", 4000n\)/);
  assert.match(deploy, /remainder \(20% of routed rake\)/);
});

test("production TWAP liquidity floor has no permissive generic default", async () => {
  const deploy = await source("scripts/deploy-casino.ts");

  assert.match(deploy, /CASINO_TWAP_MIN_RESERVE_WEI is required/);
  assert.match(deploy, /TWAP_MIN_RESERVE_WEI must be positive/);
  assert.doesNotMatch(deploy, /envBig\("CASINO_TWAP_MIN_RESERVE_WEI"/);
});

test("local and testnet fixtures mirror the ratified routed-rake ordering", async () => {
  for (const path of ["scripts/local-casino-setup.ts", "scripts/testnet-casino-setup.ts"]) {
    const fixture = await source(path);
    assert.match(fixture, /BURN_BPS = 4000n/);
    assert.match(fixture, /AIRDROP_BPS = 4000n/);
  }
});
