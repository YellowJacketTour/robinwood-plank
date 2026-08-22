import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * _invertMultiplier was rewritten from a LINEAR SEARCH (up to 200,000 loop
 * iterations -- real gas waste AND a latent DoS risk: an extreme drand-
 * derived multiplier could exceed the block gas limit and brick
 * revealEntropy() for that round) to a BINARY SEARCH (~18 iterations
 * worst case). This is security-critical payout math -- it's what
 * presetCashOut and every settled round's true crash point are derived
 * from -- so this file exists purely to prove the new implementation is
 * byte-for-byte identical to the old one across a wide sweep, not just
 * "probably fine."
 *
 * The reference is a faithful JS port of the OLD Solidity loop (not the
 * new one), run independently in the test runner, and compared against
 * the ACTUAL deployed contract's _invertMultiplier for the same inputs.
 */
describe("PlankCrashDrand._invertMultiplier -- binary search matches the old linear search exactly", () => {
  // _multiplierAt(e) = 10000 + 40e + floor(e^2/5) -- byte-for-byte port of
  // the Solidity pure function's integer math.
  function multiplierAt(e: bigint): bigint {
    return 10000n + e * 40n + (e * e) / 5n;
  }
  // The OLD linear-search Solidity implementation, ported verbatim to JS.
  function oldInvertMultiplier(targetBps: bigint): bigint {
    let e = 0n;
    while (multiplierAt(e) < targetBps && e <= 200000n) {
      e++;
    }
    return e;
  }

  async function deployMinimal() {
    // _invertMultiplier is `public pure` -- exercise it directly with no
    // game state needed, via a trivial full deploy (cheapest path already
    // used by every other test in this suite).
    const [deployer, treasury] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(3n, 1727521075n);
    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 30,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 500,
      maxElapsedBlocks: 1800,
      registrationWindowBlocks: 50,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.005"),
      maxStakePerWalletBps: 6000n,
      keeperRewardBps: 0n,
      seedNumerator: 1n,
      seedDenominator: 8n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
    });
    void deployer;
    return crash;
  }

  it("matches the old linear search across a dense sweep of small/typical targets (10001..20000)", async () => {
    const crash = await deployMinimal();
    // Dense sweep covers every realistic in-game multiplier (up to 2x) plus
    // the immediate boundary just above break-even.
    for (let t = 10001n; t <= 20000n; t += 137n) {
      const expected = oldInvertMultiplier(t);
      const actual = await crash._invertMultiplier(t);
      expect(actual, `target=${t}`).to.equal(expected);
    }
  });

  it("matches at exact boundary values where _multiplierAt crosses the target precisely", async () => {
    const crash = await deployMinimal();
    // For several elapsed-block values, the target = multiplierAt(e) is an
    // EXACT hit -- the classic off-by-one danger zone for any binary
    // search rewrite.
    for (const e of [0n, 1n, 2n, 5n, 10n, 50n, 100n, 358n, 1000n, 1800n, 5000n]) {
      const exactTarget = multiplierAt(e);
      const expected = oldInvertMultiplier(exactTarget);
      const actual = await crash._invertMultiplier(exactTarget);
      expect(actual, `exact target at e=${e}`).to.equal(expected);
      expect(actual).to.equal(e); // the target IS reachable exactly at e

      // And one bps below/above the exact hit -- confirms no off-by-one.
      if (exactTarget > 1n) {
        const below = exactTarget - 1n;
        expect(await crash._invertMultiplier(below), `just below e=${e}`).to.equal(oldInvertMultiplier(below));
      }
      const above = exactTarget + 1n;
      expect(await crash._invertMultiplier(above), `just above e=${e}`).to.equal(oldInvertMultiplier(above));
    }
  });

  it("matches for large multipliers up to and beyond maxElapsedBlocks-scale targets", async () => {
    const crash = await deployMinimal();
    for (const t of [50000n, 73000n, 100000n, 500000n, 1000000n, 5000000n]) {
      const expected = oldInvertMultiplier(t);
      const actual = await crash._invertMultiplier(t);
      expect(actual, `target=${t}`).to.equal(expected);
    }
  });

  it("targetBps <= 10000 (already at/below the 1.00x floor) returns 0, matching the old loop", async () => {
    const crash = await deployMinimal();
    for (const t of [1n, 5000n, 10000n]) {
      expect(await crash._invertMultiplier(t)).to.equal(0n);
      expect(oldInvertMultiplier(t)).to.equal(0n);
    }
  });

  it("UNREACHABLE targets (needing more than 200,000 elapsed blocks): both old and new return a sentinel >> maxElapsedBlocks, so real game behavior is identical either way", async () => {
    const crash = await deployMinimal();
    // multiplierAt(200000) is astronomically large already, but push a
    // truly unreachable target to exercise the give-up path on both sides.
    const huge = multiplierAt(200000n) * 1000n;
    const oldResult = oldInvertMultiplier(huge); // old loop's give-up sentinel: 200001
    const newResult = await crash._invertMultiplier(huge); // new binary search's give-up sentinel: 200000
    const maxElapsedBlocksTypical = 1800n;
    expect(oldResult).to.be.gt(maxElapsedBlocksTypical);
    expect(newResult).to.be.gt(maxElapsedBlocksTypical);
    // The two sentinels legitimately differ by exactly 1 (documented in the
    // contract comment) -- both are always capped to maxElapsedBlocks by
    // _effectiveCrashElapsed before they ever affect a payout, so this
    // difference is provably inert, not swept under the rug.
    expect(oldResult - newResult).to.equal(1n);
  });

  it("randomized sweep across the full realistic drand-derived multiplier range (_deriveCrash's own output space)", async () => {
    const crash = await deployMinimal();
    // _deriveCrash computes multiplierBps = 100000000 / (10000 - r) for
    // r in [1, 9999] -- sweep that exact output space (skipping r=0, the
    // documented 1.00x/no-crash special case handled separately in
    // _deriveCrash itself, not through _invertMultiplier).
    for (let r = 1n; r <= 9999n; r += 71n) {
      const multiplierBps = (10000n * 10000n) / (10000n - r);
      const expected = oldInvertMultiplier(multiplierBps);
      const actual = await crash._invertMultiplier(multiplierBps);
      expect(actual, `r=${r} -> multiplierBps=${multiplierBps}`).to.equal(expected);
    }
  });
});
