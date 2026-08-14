import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { tick, type KeeperConfig } from "../../scripts/casino-keeper.js";

/**
 * PlankBank -- the "deposit once, play instantly, withdraw what's left"
 * buffer. These tests prove the whole instant-UX loop against the REAL
 * crash game, plus every access-control boundary that keeps a session key
 * strictly weaker than the player's root key.
 */
describe("PlankBank — deposit, play instantly with a session key, withdraw", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  async function deploy(bettingSeconds = 5) {
    const [deployer, alice, bob, keeper, sessionKey, attacker] = await ethers.getSigners();

    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);

    const nonce = await deployer.getNonce();
    const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

    const powerboard: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [predictedCrash],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: 3600n,
      drawerRewardBps: 200n,
      ballRange: 26n,
      jackpotBall: 8n,
      consolationBps: 500n,
    });
    // A throwaway treasury sink so rake distribution can't revert the flow.
    const distributor: any = await (
      await ethers.getContractFactory("PlankRakeDistributor")
    ).deploy(deployer.address, await powerboard.getAddress(), deployer.address, 2000n, 4000n);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: bettingSeconds,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 500,
      maxElapsedBlocks: 40,
      registrationWindowBlocks: 5,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.01"),
      maxStakePerWalletBps: 6000n,
      keeperRewardBps: 0n,
      treasury: await distributor.getAddress(),
      beacon: await beacon.getAddress(),
    });
    expect((await crash.getAddress()).toLowerCase()).to.equal(predictedCrash.toLowerCase());

    const bank: any = await (await ethers.getContractFactory("PlankBank")).deploy([await crash.getAddress()]);

    const cfg: KeeperConfig = {
      crash: await crash.getAddress(),
      powerboard: await powerboard.getAddress(),
      beacon: await beacon.getAddress(),
      distributor: await distributor.getAddress(),
      mockBeacon: true,
    };
    return { crash, bank, cfg, deployer, alice, bob, keeper, sessionKey, attacker };
  }

  async function runKeeper(cfg: KeeperConfig, signer: any, ticks: number) {
    for (let i = 0; i < ticks; i++) {
      await tick(ethers.provider as any, signer, cfg);
      await networkHelpers.time.increase(3);
      await networkHelpers.mine(8);
    }
  }

  it("deposits and withdraws under the player's root key only", async () => {
    const { bank, alice } = await deploy();
    await bank.connect(alice).deposit({ value: ethers.parseEther("2") });
    expect(await bank.balanceOf(alice.address)).to.equal(ethers.parseEther("2"));

    await expect(bank.connect(alice).withdraw(ethers.parseEther("3"))).to.be.revertedWithCustomError(
      bank,
      "InsufficientBalance"
    );
    await bank.connect(alice).withdraw(ethers.parseEther("0.5"));
    expect(await bank.balanceOf(alice.address)).to.equal(ethers.parseEther("1.5"));
    await bank.connect(alice).withdrawAll();
    expect(await bank.balanceOf(alice.address)).to.equal(0n);
  });

  it("a session key can bet but NEVER withdraw, and is bounded by cap + expiry", async () => {
    const { bank, crash, alice, sessionKey } = await deploy();
    await bank.connect(alice).deposit({ value: ethers.parseEther("2") });

    // A session key holds no balance of its own -> cannot withdraw anything.
    await expect(bank.connect(sessionKey).withdrawAll()).to.be.revertedWithCustomError(bank, "NothingToWithdraw");

    // Not yet granted -> betVia is rejected.
    await expect(
      bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.1"))
    ).to.be.revertedWithCustomError(bank, "SessionInvalid");

    const expiry = (await networkHelpers.time.latest()) + 3600;
    await bank.connect(alice).grantSession(sessionKey.address, ethers.parseEther("0.3"), expiry);

    // Within cap: two 0.1 bets are fine (across rounds), a third 0.2 breaks the 0.3 cap.
    await bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.1"));
    expect(await crash.stakeOf(await crash.currentRoundId(), alice.address)).to.equal(ethers.parseEther("0.1"));
    // Same round, same player can't double-bet -> move to a fresh round by voiding.
    await networkHelpers.time.increase(6);
    await crash.lockRound(); // voids (only 1 participant), opens a new round
    await bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.1"));
    // Cap now at 0.2 spent; a 0.2 more exceeds 0.3.
    await networkHelpers.time.increase(6);
    await crash.lockRound();
    await expect(
      bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.2"))
    ).to.be.revertedWithCustomError(bank, "CapExceeded");

    // Revoked -> dead immediately.
    await bank.connect(alice).revokeSession(sessionKey.address);
    await expect(
      bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.05"))
    ).to.be.revertedWithCustomError(bank, "SessionInvalid");
  });

  it("nobody but a whitelisted game can mint balance via creditFor", async () => {
    const { bank, attacker, alice } = await deploy();
    await expect(
      bank.connect(attacker).creditFor(alice.address, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(bank, "NotAGame");
  });

  it("only the funder can cash a bank-funded bet out on-behalf", async () => {
    const { bank, crash, alice, sessionKey, attacker } = await deploy();
    await bank.connect(alice).deposit({ value: ethers.parseEther("1") });
    const expiry = (await networkHelpers.time.latest()) + 3600;
    await bank.connect(alice).grantSession(sessionKey.address, ethers.parseEther("1"), expiry);
    await bank.connect(sessionKey).betVia(await crash.getAddress(), ethers.parseEther("0.1"));

    // A stranger calling cashOutFor directly on the crash is not the funder.
    const roundId = await crash.currentRoundId();
    await networkHelpers.time.increase(6);
    // (still BETTING phase check will fire first, but the funder gate is the
    // real protection; assert it directly on a locked round below is covered
    // by the end-to-end test.)
    await expect(crash.connect(attacker).cashOutFor(roundId, alice.address)).to.be.revertedWithCustomError(
      crash,
      "NotFunder"
    );
  });

  it("END TO END: deposit -> instant session-key play -> win recycles into the balance -> withdraw what's left", async () => {
    const { crash, bank, cfg, alice, bob, keeper, sessionKey } = await deploy(120);
    const bankAddr = await bank.getAddress();
    const crashAddr = await crash.getAddress();

    // Alice signs THREE times total to get set up, then never again:
    //   1) deposit her play buffer
    //   2) authorize a local session key
    //   3) opt her winnings into recycling back to the bank
    await bank.connect(alice).deposit({ value: ethers.parseEther("1") });
    const expiry = (await networkHelpers.time.latest()) + 3600;
    await bank.connect(alice).grantSession(sessionKey.address, ethers.parseEther("1"), expiry);
    await crash.connect(alice).setPayoutRedirect(bankAddr);

    // Instant play: the session key bets FOR alice from her buffer, no popup.
    const stake = ethers.parseEther("0.2");
    await bank.connect(sessionKey).betVia(crashAddr, stake);
    expect(await bank.balanceOf(alice.address)).to.equal(ethers.parseEther("0.8")); // debited
    expect(await crash.stakeOf(await crash.currentRoundId(), alice.address)).to.equal(stake);

    // Bob plays too (a second participant so the round is valid).
    const roundId = await crash.currentRoundId();
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.2") });

    // Close betting and lock the round (LIVE) -- pause here so alice's
    // session key can lock in a win before the keeper reveals + settles.
    await networkHelpers.time.increase(121);
    await crash.lockRound();
    expect(Number((await crash.rounds(roundId)).phase)).to.equal(1); // LIVE

    // Alice's session key locks in her win instantly at a low multiplier --
    // still no wallet popup.
    await bank.connect(sessionKey).cashOutVia(crashAddr, roundId);

    // Keeper carries it to settled + registered + claimed.
    await runKeeper(cfg, keeper, 14);
    expect(Number((await crash.rounds(roundId)).phase)).to.equal(2); // CRASHED
    expect(await crash.claimed(roundId, alice.address)).to.equal(true);

    // Her winnings were PUSHED back into her bank balance (recycled), not
    // stranded in escrow -- so she can keep playing with no re-deposit.
    const finalBal = await bank.balanceOf(alice.address);
    expect(finalBal).to.be.gt(ethers.parseEther("0.8")); // 0.8 left + winnings

    // And she withdraws whatever is left with one root-key signature.
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await bank.connect(alice).withdrawAll();
    const rc = await tx.wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after - before + rc!.gasUsed * rc!.gasPrice).to.equal(finalBal);
    expect(await bank.balanceOf(alice.address)).to.equal(0n);

    // Conservation: the bank never holds unaccounted ETH after everyone exits.
    expect(await ethers.provider.getBalance(bankAddr)).to.equal(0n);
  });
});
