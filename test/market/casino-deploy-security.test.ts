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

test("production deploys exactly the canonical CCS-2L set and nothing retired", async () => {
  const deploy = await source("scripts/deploy-casino.ts");
  for (const name of ["PlankV2TwapOracle", "PlankBurnEngine", "PlankLottery", "PlankRakeRouter", "PlankCrash", "PlankBank"]) {
    assert.match(deploy, new RegExp(`getContractFactory\\("${name}"\\)`), `deploys ${name}`);
  }
  for (const retired of ["PlankCrashDrand", "PlankPowerboard", "PlankRakeDistributor", "PlankFuelBooster", "PlankProgression", "singlePayoutCapBps"]) {
    assert.doesNotMatch(deploy, new RegExp(retired), `must not reference ${retired}`);
  }
});

test("the 40/40/20 split of NET rake is router bytecode, not a deploy parameter", async () => {
  const router = await source("contracts/PlankRakeRouter.sol");
  assert.match(router, /uint256 public constant BURN_BPS = 4_000;/);
  assert.match(router, /uint256 public constant COMMUNITY_BPS = 4_000;/);
  assert.match(router, /founders = net - burnAmount - community;/);
  const deploy = await source("scripts/deploy-casino.ts");
  assert.doesNotMatch(deploy, /CASINO_BURN_BPS|CASINO_AIRDROP_BPS/);
  assert.match(deploy, /envBig\("CASINO_COMMUNITY_LOTTERY_BPS", 6500n\)/);
});

test("ratified settlement and lottery parameters are the deploy defaults", async () => {
  const deploy = await source("scripts/deploy-casino.ts");
  assert.match(deploy, /envBig\("CASINO_CCS2L_FLOOR_BPS", 7500n\)/);
  assert.match(deploy, /envBig\("CASINO_CCS2L_HOUSE_CAP_BPS", 1000n\)/);
  assert.match(deploy, /envBig\("CASINO_RAKE_BPS", 450n\)/);
  assert.match(deploy, /envBig\("CASINO_RAKE_FLOOR_BPS", 250n\)/);
  // v2 actuarial identity (RESEARCH-game-theory-lottery-seed-resolution-2026-09-05):
  // house risks <= half the round's rake; the pool keeps >= half of every
  // contribution (kappa = 2); the flat ceiling is 1/16; NO forced hit exists.
  assert.match(deploy, /envBig\("CASINO_CCS2L_HOUSE_RAKE_CAP_BPS", 5000n\)/);
  assert.match(deploy, /envBig\("CASINO_LOTTERY_ODDS_ONE_IN", 16n\)/);
  assert.match(deploy, /envBig\("CASINO_LOTTERY_KAPPA_BPS", 20_000n\)/);
  assert.match(deploy, /LOTTERY_CONTRIBUTION_BPS = \(4000n \* COMMUNITY_LOTTERY_BPS\) \/ 10_000n/);
  assert.doesNotMatch(deploy, /MUST_HIT_BY|mustHitBy/);
  assert.match(deploy, /envBig\("CASINO_CARVE_MIN_BPS", 1000n\)/);
  assert.match(deploy, /envBig\("CASINO_CARVE_MAX_BPS", 3000n\)/);
  assert.match(deploy, /envBig\("CASINO_CARVE_HALF_SATURATION_WEI", 250_000n \* CREDIT\)/);
  assert.match(deploy, /CASINO_MAX_MULTIPLIER_BPS is unset/);
});

test("production TWAP liquidity floor has no permissive generic default", async () => {
  const deploy = await source("scripts/deploy-casino.ts");

  assert.match(deploy, /CASINO_TWAP_MIN_RESERVE_WEI is required/);
  assert.match(deploy, /TWAP_MIN_RESERVE_WEI must be positive/);
  assert.doesNotMatch(deploy, /envBig\("CASINO_TWAP_MIN_RESERVE_WEI"/);
});

test("local and testnet fixtures deploy the same canonical set with the ratified community subdivision", async () => {
  for (const path of ["scripts/local-casino-setup.ts", "scripts/testnet-casino-setup.ts"]) {
    const fixture = await source(path);
    assert.match(fixture, /COMMUNITY_LOTTERY_BPS = 6500n/);
    for (const name of ["PlankLottery", "PlankRakeRouter", "PlankCrash", "PlankBank"]) {
      assert.match(fixture, new RegExp(`getContractFactory\\("${name}"\\)`), `${path} deploys ${name}`);
    }
    assert.doesNotMatch(fixture, /PlankCrashDrand|PlankPowerboard|PlankRakeDistributor|PlankProgression|PlankFuelBooster/);
  }
});
