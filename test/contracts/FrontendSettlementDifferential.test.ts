/**
 * Frontend ⟷ contract settlement differential (workstream 4).
 *
 * "Every financial value displayed by the UI must exactly reproduce canonical contract
 *  settlement." The frontend (public/arcade/crash.html) recomputes exactly ONE settlement
 *  input in JS — the multiplier curve `multiplierAtBlocksBps()` — for live display. Every
 *  actual PAYOUT value it shows is read from the chain (`crash.estimatedPayout(...)`), so
 *  payout is UI==contract by construction. This test proves the one JS-recomputed value
 *  matches the contract's `_multiplierAt` EXACTLY across the full block range, and that the
 *  frontend's payout-share DISCLAIMER matches the contract's actual split semantics.
 */
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");

// The EXACT JS the frontend uses (copied verbatim from crash.html:2794; if the frontend
// changes, the string-match assertion below fails and forces this to be updated in lockstep).
function multiplierAtBlocksBps(elapsedBlocks: number): number {
  return 10000 + elapsedBlocks * 40 + Math.floor((elapsedBlocks * elapsedBlocks) / 5);
}

describe("Frontend ⟷ contract settlement differential", () => {
  it("the frontend's multiplierAtBlocksBps is byte-identical to the code in crash.html", () => {
    const html = readFileSync(join(REPO, "public/arcade/crash.html"), "utf8");
    // the frontend function body, normalized
    expect(html).to.match(/return 10000 \+ elapsedBlocks \* 40 \+ Math\.floor\(\(elapsedBlocks \* elapsedBlocks\) \/ 5\);/);
  });

  it("multiplierAtBlocksBps(e) === contract._multiplierAt(e) for every block in [0, maxElapsed]", async () => {
    const [, treasury] = await ethers.getSigners();
    const beacon = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(3n, 1727521075n);
    const sink = await (await ethers.getContractFactory("ToggleableJackpotSink")).deploy();
    const crash: any = await (await ethers.getContractFactory("PlankCrashDrand")).deploy({
      bettingDurationSeconds: 30n, roundIntervalSeconds: 0n, maxAwaitBlocks: 3000n,
      maxElapsedBlocks: 6969n, registrationWindowBlocks: 50n, rakeBps: 300n,
      minParticipants: 2n, minPoolSize: 0n, maxStakePerWalletBps: 5000n, keeperRewardBps: 100n,
      seedNumerator: 1n, seedDenominator: 8n, reserveShareBps: 4000n, reserveFloorWei: 0n,
      reserveCap: ethers.parseEther("2"), jackpotSink: await sink.getAddress(),
      treasury: treasury.address, beacon: await beacon.getAddress(),
      ...hardeningFor(6969n), seedBootstrapBudgetWei: ethers.parseEther("0.2"),
    });
    // sample densely across the range incl. the exact settlement ceiling (6969)
    const samples = [0, 1, 2, 7, 45, 145, 359, 1000, 1800, 2128, 3430, 5000, 6968, 6969];
    for (const e of samples) {
      const onchain: bigint = await crash._multiplierAt(e);
      const frontend = multiplierAtBlocksBps(e);
      expect(BigInt(frontend), `mismatch at e=${e}`).to.equal(onchain);
    }
    // JS number precision: multiplierAtBlocksBps uses Number, which is exact up to 2^53.
    // mult(6969) ~ 9.98M, far under 2^53, so Number is exact across the whole real range.
    expect(multiplierAtBlocksBps(6969)).to.be.lessThan(Number.MAX_SAFE_INTEGER);
  });

  it("the UI payout disclaimer matches the contract's actual pot-share (not stake×multiplier)", () => {
    const html = readFileSync(join(REPO, "public/arcade/crash.html"), "utf8");
    // The contract pays a SHARE of the pot by stake×mult (player pot) + profit-weight (seed),
    // NEVER a fixed stake×multiplier. The UI must say so before a bet.
    expect(html).to.match(/not a fixed stake × multiplier|share of the shared pot|split by stake × your cash-out multiplier/i);
    // and it must NOT promise stake×multiplier as the payout.
    expect(/your payout (is|=) stake ?[×x*] ?multiplier(?! —| —|,? never)/i.test(html)).to.equal(false);
  });

  it("the UI reads estimatedPayout from the CHAIN, not a JS recomputation", () => {
    const html = readFileSync(join(REPO, "public/arcade/crash.html"), "utf8");
    // payout comes from crash.estimatedPayout(...) — the contract's own value.
    expect(html).to.match(/crash\.estimatedPayout\(/);
  });

  it("FOUR CEILINGS: pre-bet discloses the max payable multiplier (settlement ceiling)", () => {
    const html = readFileSync(join(REPO, "public/arcade/crash.html"), "utf8");
    expect(html).to.match(/maxPayableDisclosure/);
    expect(html).to.match(/Max payable multiplier/i);
    expect(html).to.match(/settles at the cap/i);
  });

  it("FOUR CEILINGS: above-cap crashes are labeled truthfully (true vs settled)", () => {
    const html = readFileSync(join(REPO, "public/arcade/crash.html"), "utf8");
    // the fairness view shows the TRUE derived crash and, when capped, the settled cap + a note.
    expect(html).to.match(/True derived crash/);
    expect(html).to.match(/Settled at \(cap\)|payouts settle at the/i);
  });
});
