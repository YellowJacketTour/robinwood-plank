import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";

/**
 * PlankFuelBooster conservation + cap fuzz. Randomized burns of varying
 * sizes, interleaved with round advances (so the per-round cap's reset
 * boundary gets genuinely exercised, not just tested at one clean edge),
 * checking after EVERY step that:
 *   1. The booster's real ETH balance exactly equals boostPool (no stray
 *      ETH, no insolvency -- fund() and the boost payout inside burnFuel
 *      are the only two ETH movements, so this must be exact).
 *   2. totalPlankBurned exactly equals the running sum of every successful
 *      burnFuel's plankAmount (the burn always happens in full, even when
 *      the boost itself is capped -- this is the "burn unconditional,
 *      boost capped" design, verified as bookkeeping-exact here).
 *   3. The round's cumulative boost (from roundFuelStats) never exceeds
 *      maxBoostPerRoundWei, across genuinely random round-boundary timing.
 */
describe("PlankFuelBooster -- conservation + cap invariants under randomized burns", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const WINDOW = 60n;
  const MAX_STALE = 300n; // must be <= WINDOW * 8 (the oracle's own MAX_STALENESS_MULTIPLE ceiling)
  const MAX_PER_BURN = ethers.parseEther("0.05");
  const MAX_PER_ROUND = ethers.parseEther("0.15");

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function deploy() {
    const [deployer, alice, bob, carol, sponsor] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const pair: any = await (
      await ethers.getContractFactory("MockV2Pair")
    ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000"));
    const oracle: any = await (
      await ethers.getContractFactory("PlankV2TwapOracle")
    ).deploy(await pair.getAddress(), WINDOW, MAX_STALE, 1n);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 6,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 40,
      maxElapsedBlocks: 20,
      registrationWindowBlocks: 5,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 10000n,
      keeperRewardBps: 1n, // hardening (c): must be > 0
      seedNumerator: 1n,
      seedDenominator: 8n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: deployer.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(20), // Phase 3 hardening fields (test defaults)
    });

    const booster: any = await (
      await ethers.getContractFactory("PlankFuelBooster")
    ).deploy(await plank.getAddress(), await oracle.getAddress(), await crash.getAddress(), MAX_PER_BURN, MAX_PER_ROUND);

    for (const p of [alice, bob, carol]) await plank.mint(p.address, ethers.parseEther("100000"));

    await networkHelpers.time.increase(Number(WINDOW) + 1);
    await oracle.update();

    return { crash, booster, plank, oracle, deployer, alice, bob, carol, sponsor };
  }

  async function runFuzz(seed: number, steps: number) {
    const { crash, booster, plank, oracle, alice, bob, carol, sponsor } = await deploy();
    const boosterAddr = await booster.getAddress();
    const rand = prng(seed);
    const players = [alice, bob, carol];
    const pick = (arr: any[]) => arr[Math.floor(rand() * arr.length)];

    let totalFunded = 0n;
    let sumOfSuccessfulBurnAmounts = 0n;

    async function assertInvariants(tag: string) {
      const bal = await ethers.provider.getBalance(boosterAddr);
      const pool = await booster.boostPool();
      expect(bal, `booster balance != boostPool after ${tag}`).to.equal(pool);
      expect(pool + (await booster.totalEthBoosted())).to.equal(totalFunded, `pool+boosted != totalFunded after ${tag}`);
      expect(await booster.totalPlankBurned(), `totalPlankBurned mismatch after ${tag}`).to.equal(sumOfSuccessfulBurnAmounts);
      const [, , ethBoostedThisRound, capWei] = await booster.roundFuelStats();
      expect(ethBoostedThisRound, `round cap exceeded after ${tag}`).to.be.lte(capWei);
    }

    for (let i = 0; i < steps; i++) {
      // Keep the oracle fresh every ~6 ops (well under its 300s staleness
      // ceiling given the small per-op time advances elsewhere) so burns
      // don't spuriously start reverting mid-fuzz for an unrelated reason.
      if (i % 6 === 0) {
        await networkHelpers.time.increase(Number(WINDOW) + 1);
        await oracle.update().catch(() => {});
      }
      const op = Math.floor(rand() * 4);
      try {
        if (op === 0) {
          const amt = ethers.parseEther(pick(["0.01", "0.1", "1", "5"]));
          await booster.connect(sponsor).fund({ value: amt });
          totalFunded += amt;
        } else if (op === 1) {
          const p = pick(players);
          const plankAmt = ethers.parseEther(pick(["1", "50", "500", "10000"]));
          await plank.connect(p).approve(boosterAddr, plankAmt);
          const tx = await booster.connect(p).burnFuel(plankAmt);
          await tx.wait();
          sumOfSuccessfulBurnAmounts += plankAmt;
        } else if (op === 2) {
          // advance/void a round to genuinely exercise the cap's reset boundary
          const id = await crash.currentRoundId();
          const r = await crash.rounds(id);
          if (Number(r.phase) === 0) {
            await networkHelpers.time.increase(7);
            await crash.lockRound().catch(() => {});
          }
        } else {
          // a bet or two so a locked round can actually proceed sometimes
          const p1 = pick(players);
          const p2 = pick(players.filter((x) => x !== p1)) || players[0];
          await crash.connect(p1).placeBet(0n, { value: ethers.parseEther("0.02") }).catch(() => {});
          await crash.connect(p2).placeBet(0n, { value: ethers.parseEther("0.02") }).catch(() => {});
        }
      } catch (_) {
        // a revert (e.g. cap hit, oracle stale) is fine -- nothing should
        // have moved, verified by the invariant check below regardless.
      }
      await assertInvariants(`step ${i} (op ${op})`);
    }
    await assertInvariants("final");
  }

  it("holds conservation + cap invariants over 120 random ops (seed 1)", async () => {
    await runFuzz(1, 120);
  });
  it("holds conservation + cap invariants over 120 random ops (seed 777)", async () => {
    await runFuzz(777, 120);
  });
  it("holds conservation + cap invariants over 120 random ops (seed 24601)", async () => {
    await runFuzz(24601, 120);
  });
});
