import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { HARDENING_TEST_DEFAULTS, hardeningFor } from "./helpers/crashHardening.js";

/**
 * THE VAULT -- a perpetual, always-positive prize reserve that seeds every
 * game and can never be emptied. The single property that matters:
 *
 *   No sequence of player wins can ever drive the forward-carry prize pot to
 *   zero or below.
 *
 * It holds because the Vault's ONLY debit is a STRICT FRACTION of its own
 * current balance (seed = floor(reserve * num/den), num < den), so a draw
 * multiplies the balance by (den-num)/den > 0 -- and winners are paid from
 * the round pool, never from the Vault. These tests prove the invariant
 * across mixed win/bust rounds, plus the growth engine (rake carve + busts +
 * donations) and the optional hard floor.
 */
describe("PlankCrashDrand — the Vault (never-zero, always-compounding prize pot)", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const MAX_ELAPSED = 30;
  const REG = 6;
  const AWAIT = 40;
  const BETTING = 30;

  async function deploy(over: Record<string, any> = {}) {
    const [deployer, treasury, alice, bob] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const cfg: Record<string, any> = {
      bettingDurationSeconds: BETTING,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: AWAIT,
      maxElapsedBlocks: MAX_ELAPSED,
      registrationWindowBlocks: REG,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 8000n,
      keeperRewardBps: 1n, // hardening (c): must be > 0
      seedNumerator: 1n,
      seedDenominator: 4n, // release 25% of the Vault per game
      reserveShareBps: 4000n, // compound 40% of the rake back in
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(MAX_ELAPSED), // Phase 3 hardening fields (test defaults)
      ...over,
    };
    const crash: any = await (await ethers.getContractFactory("PlankCrashDrand")).deploy(cfg);
    return { crash, beacon, deployer, treasury, alice, bob };
  }

  // Drive one full round to settlement. Alice commits an early auto cash-out (so
  // she WINS whenever the crash point is reached), Bob rides to the crash.
  // Returns the settled roundId.
  async function playRound(crash: any, beacon: any, alice: any, bob: any, seed: string) {
    const rid = await crash.currentRoundId();
    // Hardening (a): Alice's auto target (the earliest possible cash-out,
    // 1.0001x -> 1 block) is committed WITH her bet -- presetCashOut is
    // gone -- so she wins whenever the crash point is >= 1 block.
    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(BETTING + 1);
    await crash.lockRound();
    const r = await crash.rounds(rid);
    const dueAt = DRAND_GENESIS + BigInt(r.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(r.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seed)));
    await crash.revealEntropy(rid);
    const r2 = await crash.rounds(rid);
    const eff = r2.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED) ? r2.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED);
    const cur = await ethers.provider.getBlockNumber();
    const target = Number(r2.lockBlock) + Number(eff);
    if (target - cur > 0) await networkHelpers.mine(target - cur);
    await crash.settleRound(rid);

    // Register both within the window, then close it and settle the money:
    // a winner's payout LEAVES via claim (draining the seed permanently); a
    // fully-busted pot is swept back into the Vault.
    await crash.registerResult(rid, alice.address).catch(() => {});
    await crash.registerResult(rid, bob.address).catch(() => {});
    await networkHelpers.mine(REG + 1);
    const settled = await crash.rounds(rid);
    const won = settled.totalWinningWeight > 0n;
    if (won) {
      await crash.claim(rid, alice.address).catch(() => {});
      await crash.claim(rid, bob.address).catch(() => {});
    } else {
      await crash.sweepBustedRound(rid).catch(() => {});
    }
    return { rid, won };
  }

  it("rejects a seed fraction that is not a proper fraction (that is what guarantees non-emptiness)", async () => {
    const Crash = await ethers.getContractFactory("PlankCrashDrand");
    const [, , eoa] = await ethers.getSigners();
    await expect(deploy({ seedNumerator: 2n, seedDenominator: 2n })).to.be.revertedWithCustomError(
      Crash,
      "BadVaultConfig"
    ); // num == den would zero the Vault in one draw
    await expect(deploy({ seedNumerator: 3n, seedDenominator: 2n })).to.be.revertedWithCustomError(
      Crash,
      "BadVaultConfig"
    );
    await expect(deploy({ seedNumerator: 0n, seedDenominator: 4n })).to.be.revertedWithCustomError(
      Crash,
      "BadVaultConfig"
    );
    await expect(deploy({ reserveShareBps: 10001n })).to.be.revertedWithCustomError(Crash, "BadVaultConfig");
    await expect(deploy({ rakeBps: 10001n })).to.be.revertedWithCustomError(Crash, "BadVaultConfig");
    await expect(deploy({ keeperRewardBps: 10001n })).to.be.revertedWithCustomError(Crash, "BadVaultConfig");
    await expect(deploy({ maxStakePerWalletBps: 10001n })).to.be.revertedWithCustomError(Crash, "BadVaultConfig");
    await expect(deploy({ reserveFloorWei: 100n, reserveCap: 99n })).to.be.revertedWithCustomError(
      Crash,
      "BadVaultConfig"
    );
    await expect(deploy({ reserveCap: 100n, jackpotSink: eoa.address })).to.be.revertedWithCustomError(
      Crash,
      "BadVaultConfig"
    );
  });

  it("never charges rake on restricted Vault seed", async () => {
    const { crash, beacon, alice, bob } = await deploy({
      seedNumerator: 1n,
      seedDenominator: 2n,
      rakeBps: 1000n,
      keeperRewardBps: 2500n,
      reserveShareBps: 4000n,
      maxStakePerWalletBps: 10000n,
    });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    await playRound(crash, beacon, alice, bob, "seed-rake-primer");
    const { rid } = await playRound(crash, beacon, alice, bob, "seed-rake-proof");
    const round = await crash.rounds(rid);
    const seed = round.rolledOverFromPrevious;
    const playerPool = round.pool - seed;
    const playerDistributable = (playerPool * 9000n) / 10000n;
    const playerRake = playerPool - playerDistributable;

    expect(seed).to.be.gt(0n);
    expect(round.distributable).to.equal(seed + playerDistributable);
    expect(round.pool - round.distributable).to.equal(playerRake);
  });

  it("fundVault grows the reserve and nextSeed() is exactly floor(reserve * num/den)", async () => {
    // num/den 1/20 == the PROPOSED seedMaxBps (500), so the formula under
    // test is the binding one (a looser num/den would be capped to 5%).
    const { crash, alice } = await deploy({ seedNumerator: 1n, seedDenominator: 20n });
    await crash.connect(alice).fundVault({ value: 1000n });
    expect(await crash.reserve()).to.equal(1000n);
    expect(await crash.nextSeed()).to.equal(50n); // 1000 * 1/20
    await crash.connect(alice).fundVault({ value: 234n });
    expect(await crash.reserve()).to.equal(1234n);
    expect(await crash.nextSeed()).to.equal(61n); // floor(1234/20)
    await expect(crash.connect(alice).fundVault({ value: 0n })).to.be.revertedWithCustomError(crash, "NothingToFund");
  });

  it("THE GUARANTEE: no sequence of wins can ever empty the Vault -- it stays strictly positive across many mixed rounds while paying out far more than it holds", async () => {
    const { crash, beacon, alice, bob } = await deploy({
      seedNumerator: 1n,
      seedDenominator: 4n,
      reserveShareBps: 4000n,
      maxStakePerWalletBps: 10000n, // disable the whale cap; irrelevant to the Vault invariant
    });
    // Prime it once; from here on it must never touch zero again.
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });

    let wins = 0;
    let busts = 0;
    let minReserve = await crash.reserve();

    for (let i = 0; i < 20; i++) {
      const { won } = await playRound(crash, beacon, alice, bob, "vault-" + i);
      if (won) wins++;
      else busts++;

      // After every round the Vault must be STRICTLY positive -- this is the
      // whole point. A winning round drains its seed permanently (paid to the
      // winner from the pool); neither wins nor any other outcome can ever
      // make the Vault <= 0.
      const after = await crash.reserve();
      expect(after, `Vault emptied after round ${i} (won=${won})`).to.be.gt(0n);
      if (after < minReserve) minReserve = after;
    }

    // We really did exercise winning rounds (so "wins don't empty it" is a
    // proven claim, not a vacuous one), and the Vault never bottomed out.
    expect(wins, "no winning rounds occurred").to.be.gt(0);
    expect(minReserve).to.be.gt(0n);
    void busts;
  });

  it("compounds: a winning round's rake share flows into the Vault (VaultGrew), and busted pots roll in whole", async () => {
    const { crash, beacon, alice, bob } = await deploy({ seedNumerator: 1n, seedDenominator: 8n, reserveShareBps: 5000n });
    const before = await crash.reserve();
    // Play one round; whatever the outcome, the rake carve must have grown
    // the Vault by 50% of the net rake of that round.
    const { rid } = await playRound(crash, beacon, alice, bob, "grow");
    const settled = await crash.rounds(rid);
    const rake = settled.pool - settled.distributable;
    // NET rake: hardening (c) requires keeperRewardBps > 0, so this fixture
    // pays 1 bps of the rake to the settler, plus the PROPOSED 1% lock and
    // 1% reveal bounties, before the carve.
    const netRake =
      rake - (rake * 1n) / 10000n - (rake * HARDENING_TEST_DEFAULTS.keeperLockBps) / 10000n - (rake * HARDENING_TEST_DEFAULTS.keeperRevealBps) / 10000n;
    const expectedCarve = (netRake * 5000n) / 10000n;

    // reserve moved by: + seed returned/kept mechanics are internal, but the
    // carve specifically is observable via the VaultGrew event.
    const evs = await crash.queryFilter(crash.filters.VaultGrew(rid));
    expect(evs.length).to.equal(1);
    expect(evs[0].args.fromRake).to.equal(expectedCarve);
    expect(await crash.reserve()).to.be.gt(before); // net grew
  });

  it("CASCADE: once the Vault is past its cap, the overflow spills into the Powerboard jackpot (crash growth unified with the lottery)", async () => {
    // A real Powerboard is the sink. The crash caps its Vault and spills the
    // rest into pb.fund(), so the compounding crash growth feeds the daily
    // jackpot instead of hoarding.
    const [, , alice] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const pb: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: 3600n,
      drawerRewardBps: 200n,
      ballRange: 26n,
      jackpotBall: 8n,
      consolationBps: 500n,
      mustHitByEpochs: 0n,
    });
    const { crash } = await deploy({
      seedNumerator: 1n,
      seedDenominator: 4n,
      reserveShareBps: 0n,
      reserveCap: ethers.parseEther("1"),
      jackpotSink: await pb.getAddress(),
      seedBootstrapBudgetWei: ethers.parseEther("0.1"), // NEW-1: <= reserveCap/10 on a capped Vault
    });

    // Fund the Vault above its cap -> it caps, and the overflow lands in the jackpot.
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1.5") });
    expect(await crash.reserve()).to.equal(ethers.parseEther("1")); // capped
    expect(await pb.jackpot()).to.equal(ethers.parseEther("0.5")); // overflow cascaded

    // More growth keeps capping and spilling -- the jackpot keeps receiving.
    await crash.connect(alice).fundVault({ value: ethers.parseEther("0.3") });
    expect(await crash.reserve()).to.equal(ethers.parseEther("1"));
    expect(await pb.jackpot()).to.equal(ethers.parseEther("0.8"));
  });

  it("respects a hard floor: the Vault is never drawn below reserveFloorWei", async () => {
    const floor = 1_000_000n;
    const { crash, alice } = await deploy({ seedNumerator: 1n, seedDenominator: 2n, reserveFloorWei: floor });
    // At/below the floor, it seeds nothing.
    await crash.connect(alice).fundVault({ value: floor });
    expect(await crash.nextSeed()).to.equal(0n);
    // Just above the floor, the draw is clamped so the remainder never dips
    // below it: reserve = 1.01F, the 5% (PROPOSED seedMaxBps) draw would be
    // 0.0505F > the 0.01F headroom, so exactly the headroom is drawn.
    await crash.connect(alice).fundVault({ value: floor / 100n }); // reserve = 1.01F
    expect(await crash.nextSeed()).to.equal(floor / 100n);
    // Well above the floor the cap, not the floor, binds: 5% of 2F.
    await crash.connect(alice).fundVault({ value: floor - floor / 100n }); // reserve = 2F
    expect(await crash.nextSeed()).to.equal((2n * floor * HARDENING_TEST_DEFAULTS.seedMaxBps) / 10000n);
  });
});
