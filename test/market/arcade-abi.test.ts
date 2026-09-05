import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { ARCADE_ABI_SET, artifactAbi } from "../../scripts/export-arcade-abi.mjs";

/**
 * The arcade wallet client and the dev panels bind ONLY to the current
 * compiled contract set. These pins fail the moment public/arcade/abi/*.json
 * drifts from the hardhat artifacts, or any page reaches for a retired
 * contract (PlankCrashDrand / PlankPowerboard / PlankFuelBooster /
 * PlankProgression) or a retired call (cashOut, revealEntropy, claim).
 */
const arcade = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");
const devPanel = readFileSync(new URL("../../public/arcade/dev-panel.html", import.meta.url), "utf8");
const testnetPanel = readFileSync(new URL("../../public/arcade/dev-panel-testnet.html", import.meta.url), "utf8");

test("public/arcade/abi/*.json equals the compiled artifacts of the current set", () => {
  for (const [name, relative] of ARCADE_ABI_SET) {
    const exported = JSON.parse(readFileSync(new URL(`../../public/arcade/abi/${name}.json`, import.meta.url), "utf8"));
    assert.deepEqual(exported, artifactAbi(relative), `${name}.json drifted from the artifact -- run node scripts/export-arcade-abi.mjs`);
  }
  assert.equal(existsSync(new URL("../../public/arcade/plankcrashv2-abi.json", import.meta.url)), false, "the retired PlankCrashDrand ABI must not exist");
});

test("the arcade wallet client binds to PlankCrash / PlankLottery / PlankBank / PlankRakeRouter / IDrandBeacon only", () => {
  for (const name of ["PlankCrash", "PlankLottery", "PlankBank", "PlankRakeRouter", "IDrandBeacon"]) {
    assert.match(arcade, new RegExp(`"${name}"`), `crash.html loads abi/${name}.json`);
  }
  assert.match(arcade, /fetch\(`abi\/\$\{name\}\.json`, \{ cache: "no-store" \}\)/);
  assert.match(arcade, /abi = ARCADE_ABI\.PlankCrash;/);
  // Current calls the client depends on.
  for (const call of ["crash.placeBet(", "crash.lockRound()", "crash.settleRound()", "crash.refundRound()", "crash.withdraw()", "crash.withdrawToBank(BANK_ADDR)", "crash.seatsOf(", "crash.targetOf(", "crash.owed(", "crash.resultSeed(", "lotteryContract.quote()", "lotteryContract.hitThreshold(", "beaconContract.isRoundAvailable("]) {
    assert.ok(arcade.includes(call), `crash.html calls ${call}`);
  }
  for (const evt of ["filters.RoundSettled()", "filters.SeatSettled(", "filters.BetPlaced()"]) assert.ok(arcade.includes(evt), `crash.html reads ${evt}`);
  // Retired contracts and calls are gone from every on-chain page.
  const retired = /plankcrashv2|PlankCrashDrand|PlankPowerboard|PlankFuelBooster|PlankProgression|\.cashOut\(|cashOutVia|revealEntropy|registerResult|withdrawPayments|setPayoutRedirect|liveMultiplierBps|estimatedPayout|crashMultiplierBps|filters\.RoundCrashed|filters\.CashedOut|filters\.Claimed|guaranteedHitByEpoch|jackpotOddsOneIn|burnFuel\(|roundFuelStats|rankOf\(/;
  for (const [label, source] of [["crash.html", arcade], ["dev-panel.html", devPanel], ["dev-panel-testnet.html", testnetPanel]] as const) {
    const hit = source.match(retired);
    assert.equal(hit, null, `${label} still references a retired contract/call: ${hit?.[0]}`);
  }
  for (const [label, source] of [["dev-panel.html", devPanel], ["dev-panel-testnet.html", testnetPanel]] as const) {
    assert.match(source, /abi\/\$\{name\}\.json/, `${label} loads the exported ABIs`);
    assert.match(source, /crash\.settleRound\(\)/, `${label} settles the current round`);
    assert.match(source, /lottery\.quote\(\)/, `${label} reads the lottery quote`);
  }
});
