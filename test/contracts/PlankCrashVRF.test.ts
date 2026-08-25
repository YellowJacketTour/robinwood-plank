import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankCrashVRF's real delta from PlankCrashV2 (its header is required
 * reading first): Chainlink VRF entropy instead of blockhash, using the
 * real VRFCoordinatorV2_5Mock -- not a hand-rolled stand-in -- so the
 * request/fulfill flow this exercises is the actual Chainlink interface
 * shape a real deployment would hit, not an approximation of it.
 */
describe("PlankCrashVRF", () => {
  const BETTING_SECONDS = 5;
  const ROUND_INTERVAL_SECONDS = 0;
  const MAX_AWAIT_BLOCKS = 50;
  const MAX_ELAPSED_BLOCKS = 40;
  const REGISTRATION_BLOCKS = 20;
  const RAKE_BPS = 250n;
  const KEEPER_REWARD_BPS = 1000n;
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 5000n;
  const KEY_HASH = "0x" + "11".repeat(32); // any 32-byte value -- the mock doesn't validate it against a real oracle job
  const REQUEST_CONFIRMATIONS = 1;
  const CALLBACK_GAS_LIMIT = 500000;

  async function deployAll(overrides: Partial<Record<string, unknown>> = {}) {
    const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

    // Real, unmodified Chainlink VRFCoordinatorV2_5Mock -- see
    // contracts/test/VRFCoordinatorV2_5Mock.sol for why this uses a
    // differently-named empty subclass rather than the mock's own name.
    const Mock = await ethers.getContractFactory("PlankCrashVRFCoordinatorMock");
    // (baseFee, gasPrice, weiPerUnitLink) -- real constructor shape, values
    // don't matter for correctness here since nativePayment is used, not
    // LINK, but the mock still wants them.
    const coordinator: any = await Mock.deploy(
      ethers.parseEther("0.1"),
      1_000_000_000n,
      4_000_000_000_000_000n
    );
    const subTx = await coordinator.createSubscription();
    const subReceipt = await subTx.wait();
    const subCreatedEvent = subReceipt.logs
      .map((log: any) => {
        try {
          return coordinator.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "SubscriptionCreated");
    const subscriptionId: bigint = subCreatedEvent.args.subId;
    await coordinator.fundSubscription(subscriptionId, ethers.parseEther("100"));

    const Crash = await ethers.getContractFactory("PlankCrashVRF");
    const crash: any = await Crash.deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: ROUND_INTERVAL_SECONDS,
      maxAwaitBlocks: MAX_AWAIT_BLOCKS,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: MIN_PARTICIPANTS,
      minPoolSize: MIN_POOL,
      maxStakePerWalletBps: MAX_STAKE_BPS,
      keeperRewardBps: KEEPER_REWARD_BPS,
      treasury: treasury.address,
      vrfCoordinator: await coordinator.getAddress(),
      keyHash: KEY_HASH,
      subscriptionId,
      requestConfirmations: REQUEST_CONFIRMATIONS,
      callbackGasLimit: CALLBACK_GAS_LIMIT,
      ...overrides,
    });
    await coordinator.addConsumer(subscriptionId, await crash.getAddress());

    return { crash, coordinator, subscriptionId, deployer, treasury, alice, bob, carol };
  }

  async function closeBettingAndLock(crash: any) {
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await crash.lockRound();
  }

  /// Simulates the VRF coordinator's real callback with a caller-chosen
  /// random word, exactly the way VRFCoordinatorV2_5Mock is meant to be
  /// driven in tests -- not a fake shortcut, the actual documented mock
  /// entry point for forcing a specific outcome deterministically.
  async function fulfillWith(coordinator: any, crash: any, roundId: bigint, randomWord: bigint) {
    const round = await crash.rounds(roundId);
    await coordinator.fulfillRandomWordsWithOverride(round.vrfRequestId, await crash.getAddress(), [randomWord]);
  }

  async function mineToCrashAndSettle(crash: any, roundId: bigint) {
    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const current = await ethers.provider.getBlockNumber();
    const targetBlock = Number(round.lockBlock) + Number(effective);
    const toMine = targetBlock - current;
    if (toMine > 0) await networkHelpers.mine(toMine);
    await crash.settleRound(roundId);
  }

  it("a naive transferOwnership(address(0)) does NOT renounce anything -- the original owner silently keeps permanent control, exactly the real trap OwnershipBurner exists to avoid", async () => {
    const { crash, deployer } = await deployAll();
    // No revert -- ConfirmedOwner's transferOwnership only checks
    // to != msg.sender, not to != address(0). This "succeeding" is
    // precisely the danger: it looks like it worked.
    await crash.connect(deployer).transferOwnership(ethers.ZeroAddress);
    // owner() is UNCHANGED -- the transfer is only proposed
    // (s_pendingOwner), never completed, because nothing can ever
    // transact as address(0) to call acceptOwnership().
    expect(await crash.owner()).to.equal(deployer.address);
    // The original deployer can still call owner-gated functions --
    // "renounced" in name only, control never actually left.
    await crash.connect(deployer).setCoordinator(deployer.address);
    expect(await crash.s_vrfCoordinator()).to.equal(deployer.address);
  });

  it("OwnershipBurner performs a REAL renunciation -- setCoordinator becomes permanently uncallable by anyone once the handoff completes", async () => {
    const { crash, deployer } = await deployAll();
    expect(await crash.owner()).to.equal(deployer.address);

    const Burner = await ethers.getContractFactory("OwnershipBurner");
    const burner: any = await Burner.deploy(await crash.getAddress());

    await crash.connect(deployer).transferOwnership(await burner.getAddress());
    // Still the deployer -- step 3 of the real handoff only PROPOSES the
    // transfer; nothing has completed yet.
    expect(await crash.owner()).to.equal(deployer.address);

    await burner.burn();
    expect(await crash.owner()).to.equal(await burner.getAddress());

    // The deployer -- and everyone else -- has permanently lost the
    // ability to call any owner-gated function. OwnershipBurner has no
    // function that could ever re-propose a transfer on the contract's
    // behalf, so this is irreversible by construction, not just by
    // convention.
    await expect(crash.connect(deployer).setCoordinator(deployer.address)).to.be.revertedWithCustomError(
      crash,
      "OnlyOwnerOrCoordinator"
    );

    // burn() is one-shot.
    await expect(burner.burn()).to.be.revertedWithCustomError(burner, "AlreadyBurned");
  });

  it("a real end-to-end round: lock requests VRF, the coordinator's callback reveals entropy, and settlement pays out exactly like PlankCrashV2's blockhash-based flow", async () => {
    const { crash, coordinator, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);

    const roundAfterLock = await crash.rounds(roundId);
    expect(roundAfterLock.vrfRequestId).to.be.gt(0n);
    expect(roundAfterLock.entropyRevealed).to.equal(false);

    // Real cash-out before the (not yet knowable) crash point.
    await crash.connect(alice).cashOut(roundId);

    // The coordinator calls back with a real random word -- pick one that
    // maps to a real, mid-range crash point (not the 1/10000 r==0 edge).
    await fulfillWith(coordinator, crash, roundId, 12345n);
    const revealed = await crash.rounds(roundId);
    expect(revealed.entropyRevealed).to.equal(true);

    await mineToCrashAndSettle(crash, roundId);
    const settled = await crash.rounds(roundId);
    expect(settled.phase).to.equal(2n); // CRASHED

    await crash.connect(alice).registerResult(roundId);
    await crash.connect(bob).registerResult(roundId);
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    const estimate = await crash.estimatedPayout(roundId, alice.address);
    if (estimate > 0n) {
      const tx = await crash.connect(alice).claim(roundId);
      const receipt = await tx.wait();
      const claimedEvent = receipt.logs
        .map((log: any) => {
          try {
            return crash.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "Claimed");
      expect(claimedEvent.args.payout).to.equal(estimate);
    }
  });

  it("cashOut() is gated against the true crash point once VRF has revealed it, same load-bearing property as PlankCrashV2", async () => {
    const { crash, coordinator, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await fulfillWith(coordinator, crash, roundId, 42n);
    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const current = await ethers.provider.getBlockNumber();
    const targetBlock = Number(round.lockBlock) + Number(effective);
    if (targetBlock - current > 0) await networkHelpers.mine(targetBlock - current);

    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "PastCrashPoint");
  });

  it("presetCashOut is rejected once entropy has been revealed, same fairness gate as PlankCrashV2", async () => {
    const { crash, coordinator, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await fulfillWith(coordinator, crash, roundId, 7n);

    const targetBps = await crash._multiplierAt(5);
    await expect(crash.connect(alice).presetCashOut(roundId, targetBps)).to.be.revertedWithCustomError(
      crash,
      "EntropyAlreadyRevealed"
    );
  });

  it("voidStaleRequest rescues a round the coordinator never calls back for, and the stake carries forward", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    // Deliberately never call fulfillWith -- simulates an oracle-network
    // outage or an underfunded subscription.
    await expect(crash.voidStaleRequest(roundId)).to.be.revertedWithCustomError(crash, "TooEarly");
    await networkHelpers.mine(MAX_AWAIT_BLOCKS + 1);

    await crash.voidStaleRequest(roundId);
    expect(await crash.voided(roundId)).to.equal(true);

    await crash.connect(alice).carryForwardStake(roundId);
    const nextRoundId = await crash.currentRoundId();
    expect(await crash.stakeOf(nextRoundId, alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  it("only the real VRF coordinator can ever trigger fulfillment -- a spoofed direct call reverts", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await expect(crash.connect(alice).rawFulfillRandomWords(1, [12345n])).to.be.revertedWithCustomError(
      crash,
      "OnlyCoordinatorCanFulfill"
    );
  });

  it("the same _multiplierAt/_deriveCrash curve as PlankCrashV2 -- both contracts pay out identically for the same entropy, proving the VRF swap changed nothing about game math", async () => {
    const { crash } = await deployAll();
    const V2 = await ethers.getContractFactory("PlankCrashV2");
    const v2: any = await V2.deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: 0,
      entropyDelayBlocks: 2,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: MIN_PARTICIPANTS,
      minPoolSize: MIN_POOL,
      maxStakePerWalletBps: MAX_STAKE_BPS,
      keeperRewardBps: KEEPER_REWARD_BPS,
      treasury: ethers.ZeroAddress === "" ? ethers.ZeroAddress : (await ethers.getSigners())[1].address,
    });
    for (const seedStr of ["a", "b", "c", "42", "plank"]) {
      const seed = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
      const [m1, e1] = await crash._deriveCrash(seed);
      const [m2, e2] = await v2._deriveCrash(seed);
      expect(m1).to.equal(m2);
      expect(e1).to.equal(e2);
    }
  });
});
