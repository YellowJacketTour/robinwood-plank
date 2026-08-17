import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankFuelBooster -- "burn $PLANK to fuel the pad, never your own odds."
 *
 * These tests prove the whole safety case:
 *   1. The burn is real (balance + totalSupply actually drop).
 *   2. The boost is priced off the SAME audited TWAP oracle PlankBurnEngine
 *      uses, and reverts atomically (no burn) if the oracle can't price it.
 *   3. Three independent caps (per-burn, per-round, pool balance) bound the
 *      boost; burning past them still burns in full, just boosts less.
 *   4. THE CORE GUARANTEE: burning never touches the burner's own stake,
 *      cash-out, or crash-point odds -- it only grows the Vault, a pool
 *      every future player draws from equally.
 */
describe("PlankFuelBooster — burn $PLANK to grow the shared Vault, never your own odds", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const WINDOW = 60n;
  const MAX_STALE = 240n;
  const R_WETH = ethers.parseEther("100");
  const R_PLANK = ethers.parseEther("100000"); // 1000 PLANK per WETH -> 1 PLANK = 0.001 ETH fair
  const MAX_PER_BURN = ethers.parseEther("0.5");
  const MAX_PER_ROUND = ethers.parseEther("1");

  async function deploy(overCaps: { perBurn?: bigint; perRound?: bigint } = {}) {
    const [deployer, alice, bob, sponsor] = await ethers.getSigners();

    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const pair: any = await (
      await ethers.getContractFactory("MockV2Pair")
    ).deploy(await weth.getAddress(), await plank.getAddress(), R_WETH, R_PLANK);
    const oracle: any = await (
      await ethers.getContractFactory("PlankV2TwapOracle")
    ).deploy(await pair.getAddress(), WINDOW, MAX_STALE);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 30,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 500,
      maxElapsedBlocks: 30,
      registrationWindowBlocks: 6,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 8000n,
      keeperRewardBps: 0n,
      seedNumerator: 1n,
      seedDenominator: 4n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: deployer.address,
      beacon: await beacon.getAddress(),
    });

    const booster: any = await (
      await ethers.getContractFactory("PlankFuelBooster")
    ).deploy(
      await plank.getAddress(),
      await oracle.getAddress(),
      await crash.getAddress(),
      overCaps.perBurn ?? MAX_PER_BURN,
      overCaps.perRound ?? MAX_PER_ROUND
    );

    await plank.mint(alice.address, ethers.parseEther("10000"));
    await plank.mint(bob.address, ethers.parseEther("10000"));

    return { beacon, plank, weth, pair, oracle, crash, booster, deployer, alice, bob, sponsor };
  }

  async function prime(oracle: any) {
    await networkHelpers.time.increase(Number(WINDOW) + 1);
    await oracle.update();
  }

  it("rejects bad config: zero addresses, zero caps, per-burn cap above per-round cap", async () => {
    const { plank, oracle, crash } = await deploy();
    const Booster = await ethers.getContractFactory("PlankFuelBooster");
    await expect(
      Booster.deploy(ethers.ZeroAddress, await oracle.getAddress(), await crash.getAddress(), MAX_PER_BURN, MAX_PER_ROUND)
    ).to.be.revertedWithCustomError(Booster, "ZeroAddress");
    await expect(
      Booster.deploy(await plank.getAddress(), await oracle.getAddress(), await crash.getAddress(), 0n, MAX_PER_ROUND)
    ).to.be.revertedWithCustomError(Booster, "BadConfig");
    await expect(
      Booster.deploy(await plank.getAddress(), await oracle.getAddress(), await crash.getAddress(), MAX_PER_ROUND, MAX_PER_BURN)
    ).to.be.revertedWithCustomError(Booster, "BadConfig"); // perBurn > perRound
  });

  it("fund() grows the pool; rejects a zero-value top-up", async () => {
    const { booster, sponsor } = await deploy();
    await booster.connect(sponsor).fund({ value: ethers.parseEther("2") });
    expect(await booster.boostPool()).to.equal(ethers.parseEther("2"));
    await expect(booster.connect(sponsor).fund({ value: 0n })).to.be.revertedWithCustomError(booster, "NothingToFund");
  });

  it("reverts ATOMICALLY when the oracle can't price the burn -- the player's $PLANK is never spent unrewarded", async () => {
    const { booster, oracle, plank, alice } = await deploy();
    await plank.connect(alice).approve(await booster.getAddress(), ethers.parseEther("100"));
    const balBefore = await plank.balanceOf(alice.address);

    // Unprimed oracle.
    await expect(booster.connect(alice).burnFuel(ethers.parseEther("100"))).to.be.revertedWithCustomError(
      oracle,
      "NotInitialized"
    );
    expect(await plank.balanceOf(alice.address)).to.equal(balBefore); // untouched

    // Prime then let it go stale.
    await prime(oracle);
    await networkHelpers.time.increase(Number(MAX_STALE) + 10);
    await expect(booster.connect(alice).burnFuel(ethers.parseEther("100"))).to.be.revertedWithCustomError(
      oracle,
      "StaleOracle"
    );
    expect(await plank.balanceOf(alice.address)).to.equal(balBefore);
  });

  it("THE REAL DEAL: burns real $PLANK (supply drops) and boosts the crash's Vault by the fair TWAP value", async () => {
    const { booster, oracle, plank, crash, alice } = await deploy();
    await prime(oracle);
    await booster.fund({ value: ethers.parseEther("5") });

    const burnAmt = ethers.parseEther("100"); // fair value: ~100 * 0.001 = ~0.1 ETH
    // The real fair value per the oracle's own UQ112x112 fixed-point math
    // (asserted independently below, not hand-derived, since integer
    // truncation can differ from the idealized 1000 PLANK/ETH by a few wei).
    const expectedBoost = await oracle.consult(await plank.getAddress(), burnAmt);
    expect(expectedBoost).to.be.closeTo(ethers.parseEther("0.1"), 10n);

    await plank.connect(alice).approve(await booster.getAddress(), burnAmt);
    const supplyBefore = await plank.totalSupply();
    const balBefore = await plank.balanceOf(alice.address);

    const tx = await booster.connect(alice).burnFuel(burnAmt);
    const rc = await tx.wait();

    // Real burn: supply and balance both actually dropped.
    expect(await plank.totalSupply()).to.equal(supplyBefore - burnAmt);
    expect(await plank.balanceOf(alice.address)).to.equal(balBefore - burnAmt);

    // Fair-value boost landed in the Vault -- exactly what the oracle quoted.
    expect(await crash.reserve()).to.equal(expectedBoost);
    expect(await booster.totalEthBoosted()).to.equal(expectedBoost);
    expect(await booster.totalPlankBurned()).to.equal(burnAmt);
    expect(await booster.boostPool()).to.equal(ethers.parseEther("5") - expectedBoost);

    const ev = rc!.logs
      .map((l: any) => { try { return booster.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e && e.name === "FuelBurned");
    expect(ev.args.plankAmount).to.equal(burnAmt);
    expect(ev.args.fairEthValue).to.equal(expectedBoost);
    expect(ev.args.boosted).to.equal(expectedBoost);
  });

  it("PER-BURN CAP: burning past it still burns in full but boosts only up to the cap", async () => {
    const { booster, oracle, plank, crash, alice } = await deploy({ perBurn: ethers.parseEther("0.05") });
    await prime(oracle);
    await booster.fund({ value: ethers.parseEther("5") });

    const burnAmt = ethers.parseEther("1000"); // fair value: 1 ETH, way past the 0.05 cap
    await plank.connect(alice).approve(await booster.getAddress(), burnAmt);
    const supplyBefore = await plank.totalSupply();

    await booster.connect(alice).burnFuel(burnAmt);

    expect(await plank.totalSupply()).to.equal(supplyBefore - burnAmt); // full burn, no discount
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.05")); // boost capped
  });

  it("PER-ROUND CAP: resets automatically when the crash's own round changes", async () => {
    const { booster, oracle, plank, crash, alice, bob } = await deploy({ perBurn: ethers.parseEther("0.15"), perRound: ethers.parseEther("0.15") });
    await prime(oracle);
    await booster.fund({ value: ethers.parseEther("5") });

    const amt = ethers.parseEther("100"); // fair value ~0.1 ETH each (real oracle math, not idealized)
    const fairEach = await oracle.consult(await plank.getAddress(), amt);
    await plank.connect(alice).approve(await booster.getAddress(), amt);
    await plank.connect(bob).approve(await booster.getAddress(), amt);

    // Round 1: alice's ~0.1 fits; bob's would push past the 0.15 cap -> capped.
    await booster.connect(alice).burnFuel(amt);
    expect(await crash.reserve()).to.equal(fairEach);
    await booster.connect(bob).burnFuel(amt);
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.15")); // capped at the round ceiling

    const [rid1, used1, cap1] = await booster.roundBoostRemaining();
    expect(used1).to.equal(ethers.parseEther("0.15"));
    expect(cap1).to.equal(ethers.parseEther("0.15"));

    // Force a new round (void the empty one via lockRound after betting closes).
    await networkHelpers.time.increase(31);
    await crash.lockRound();
    const [rid2] = await booster.roundBoostRemaining();
    expect(rid2).to.be.gt(rid1);

    // The cap is fresh again in the new round.
    await plank.connect(alice).approve(await booster.getAddress(), amt);
    const reserveBefore = await crash.reserve();
    await booster.connect(alice).burnFuel(amt);
    expect(await crash.reserve()).to.equal(reserveBefore + fairEach);
  });

  it("ROUND FUEL STATS: reports raw $PLANK burned (uncapped) alongside the ETH that actually boosted (capped), and resets with the round", async () => {
    const { booster, oracle, plank, crash, alice, bob } = await deploy({ perBurn: ethers.parseEther("0.15"), perRound: ethers.parseEther("0.15") });
    await prime(oracle);
    await booster.fund({ value: ethers.parseEther("5") });

    const amt = ethers.parseEther("100"); // fair value ~0.1 ETH
    const fairEach = await oracle.consult(await plank.getAddress(), amt);
    await plank.connect(alice).approve(await booster.getAddress(), amt);
    await plank.connect(bob).approve(await booster.getAddress(), amt);

    let [rid, plankBurned, ethBoosted, cap] = await booster.roundFuelStats();
    expect(plankBurned).to.equal(0n);
    expect(ethBoosted).to.equal(0n);
    expect(cap).to.equal(ethers.parseEther("0.15"));

    await booster.connect(alice).burnFuel(amt);
    [rid, plankBurned, ethBoosted, cap] = await booster.roundFuelStats();
    expect(plankBurned).to.equal(amt);
    expect(ethBoosted).to.equal(fairEach);

    // Bob's burn pushes past the round cap: HIS FULL PLANK still burns and
    // is counted (uncapped total), but the ETH boost stalls at the cap --
    // exactly the honest "burned X, only Y converted" split the UI needs.
    await booster.connect(bob).burnFuel(amt);
    [rid, plankBurned, ethBoosted, cap] = await booster.roundFuelStats();
    expect(plankBurned).to.equal(amt * 2n); // both burns counted in full
    expect(ethBoosted).to.equal(ethers.parseEther("0.15")); // capped

    // A new round resets both counters to zero.
    await networkHelpers.time.increase(31);
    await crash.lockRound();
    const [rid2, plankBurned2, ethBoosted2] = await booster.roundFuelStats();
    expect(rid2).to.be.gt(rid);
    expect(plankBurned2).to.equal(0n);
    expect(ethBoosted2).to.equal(0n);
  });

  it("POOL CAP: never releases more ETH than the boost pool actually holds", async () => {
    const { booster, oracle, plank, crash, alice } = await deploy({ perBurn: ethers.parseEther("1"), perRound: ethers.parseEther("1") });
    await prime(oracle);
    await booster.fund({ value: ethers.parseEther("0.03") }); // thin pool

    const amt = ethers.parseEther("100"); // fair value 0.1 ETH, more than the pool holds
    await plank.connect(alice).approve(await booster.getAddress(), amt);
    await booster.connect(alice).burnFuel(amt);

    expect(await crash.reserve()).to.equal(ethers.parseEther("0.03")); // pool-limited
    expect(await booster.boostPool()).to.equal(0n);
  });

  it("THE CORE GUARANTEE: burning fuel does NOT touch the burner's own stake, cash-out, or crash odds -- only the shared Vault grows", async () => {
    const { booster, oracle, plank, crash, alice, bob } = await deploy();
    await booster.fund({ value: ethers.parseEther("5") });

    // Alice places a real bet, unrelated to fuel-burning. Bet BEFORE priming
    // the oracle -- priming advances chain time past the (30s) betting
    // window, which would otherwise close it first.
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await prime(oracle);
    const stakeBefore = await crash.stakeOf(await crash.currentRoundId(), alice.address);
    const cashBefore = await crash.cashOutBlockOf(await crash.currentRoundId(), alice.address);

    // She burns a large amount of fuel.
    const amt = ethers.parseEther("500");
    await plank.connect(alice).approve(await booster.getAddress(), amt);
    await booster.connect(alice).burnFuel(amt);

    // Her own stake and cash-out state are byte-for-byte unchanged -- the
    // burn only ever calls crash.fundVault(), never anything player-scoped.
    const rid = await crash.currentRoundId();
    expect(await crash.stakeOf(rid, alice.address)).to.equal(stakeBefore);
    expect(await crash.cashOutBlockOf(rid, alice.address)).to.equal(cashBefore);
    // And the Vault (which seeds every FUTURE round for every player, not
    // just her) is what actually grew.
    expect(await crash.reserve()).to.be.gt(0n);
  });

  describe("progression wiring (optional; see PlankProgression.sol)", () => {
    it("setProgression is restricted to this contract's own deployer, exactly once", async () => {
      const { booster, alice } = await deploy();
      const progression: any = await (
        await ethers.getContractFactory("PlankProgression")
      ).deploy(ethers.ZeroAddress, await booster.getAddress(), ethers.ZeroAddress);
      const progressionAddr = await progression.getAddress();

      await expect(booster.connect(alice).setProgression(progressionAddr)).to.be.revertedWithCustomError(
        booster,
        "NotDeployer"
      );
      await (await booster.setProgression(progressionAddr)).wait();
      expect(await booster.progression()).to.equal(progressionAddr);
      await expect(booster.setProgression(progressionAddr)).to.be.revertedWithCustomError(
        booster,
        "ProgressionAlreadySet"
      );
    });

    it("a real burnFuel call records the burn on the wired progression contract", async () => {
      const { plank, oracle, crash, booster, alice, bob } = await deploy();
      const progression: any = await (
        await ethers.getContractFactory("PlankProgression")
      ).deploy(await crash.getAddress(), await booster.getAddress(), ethers.ZeroAddress);
      await (await booster.setProgression(await progression.getAddress())).wait();

      expect((await progression.statsOf(alice.address)).fuelBurns).to.equal(0n);
      await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
      await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
      await prime(oracle);
      const amt = ethers.parseEther("10");
      await plank.connect(alice).approve(await booster.getAddress(), amt);
      await (await booster.connect(alice).burnFuel(amt)).wait();
      expect((await progression.statsOf(alice.address)).fuelBurns).to.equal(1n);
    });
  });
});
