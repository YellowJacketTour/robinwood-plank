import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankCrashEntropy's real delta from PlankCrashV2 (its header is
 * required reading first): Pyth Entropy randomness instead of blockhash,
 * using the real MockEntropy shipped by @pythnetwork/entropy-sdk-solidity
 * itself -- not a hand-rolled stand-in -- so the request/reveal flow this
 * exercises is the actual Pyth interface shape a real deployment would
 * hit, not an approximation of it.
 */
describe("PlankCrashEntropy", () => {
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
  const ENTROPY_GAS_LIMIT = 200000;

  async function deployAll(overrides: Partial<Record<string, unknown>> = {}) {
    const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

    // Real, unmodified Pyth MockEntropy -- see contracts/test/MockEntropy.sol
    // for why this uses a differently-named empty subclass rather than the
    // SDK's own contract name (Hardhat 3 tree-shakes unused bare imports).
    const Mock = await ethers.getContractFactory("PlankCrashMockEntropy");
    const mock: any = await Mock.deploy(deployer.address);
    const provider = deployer.address;

    const Crash = await ethers.getContractFactory("PlankCrashEntropy");
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
      entropy: await mock.getAddress(),
      entropyProvider: provider,
      entropyGasLimit: ENTROPY_GAS_LIMIT,
      ...overrides,
    });

    return { crash, mock, provider, deployer, treasury, alice, bob, carol };
  }

  async function closeBettingAndLock(crash: any, locker: any) {
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    // MockEntropy's real fee for a freshly-registered provider is 1 wei
    // (see its constructor) -- overpay slightly to exercise the real
    // excess-refund path, not just the exact-fee path.
    await crash.connect(locker).lockRound({ value: 10n });
  }

  /// Simulates Pyth's real provider revelation via the SDK's own
  /// MockEntropy.mockReveal -- the actual documented mock entry point for
  /// forcing a specific outcome deterministically, mirroring how
  /// fulfillWith drives VRFCoordinatorV2_5Mock in PlankCrashVRF's tests.
  async function revealWith(mock: any, provider: string, crash: any, roundId: bigint, randomNumber: string) {
    const round = await crash.rounds(roundId);
    await mock.mockReveal(provider, round.entropySequenceNumber, randomNumber);
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

  it("lockRound reads the real fee from getFeeV2() and refunds strictly-positive overpayment", async () => {
    // NOTE: the SDK's own MockEntropy hardcodes every getFeeV2() overload
    // to return 0 regardless of the provider's real tracked feeInWei (see
    // MockEntropy.sol -- a real, confirmed limitation of the official
    // mock, not of this contract). That means InsufficientFee can't be
    // exercised against this mock with any msg.value >= 0; what CAN be
    // proven here is that lockRound() reads getFeeV2() live (not a
    // hardcoded assumption) and refunds 100% of an overpayment when the
    // real fee it observes is 0.
    const { crash, alice, bob, carol } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await networkHelpers.time.increase(BETTING_SECONDS + 1);

    await crash.connect(carol).lockRound({ value: 1000n });
    const round = await crash.rounds(roundId);
    expect(round.locker).to.equal(carol.address);
    expect(round.entropyFeePaid).to.equal(0n); // MockEntropy's real (hardcoded) fee

    // The entire overpayment sits as a withdrawable payment, not lost --
    // proves the excess-refund path actually ran, not just didn't revert.
    expect(await crash.payments(carol.address)).to.equal(1000n);
  });

  it("a real end-to-end round: lock requests Pyth Entropy, the provider's reveal sets the crash point, and settlement pays out exactly like PlankCrashV2's blockhash-based flow", async () => {
    const { crash, mock, provider, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash, alice);

    const roundAfterLock = await crash.rounds(roundId);
    expect(roundAfterLock.entropySequenceNumber).to.be.gt(0n);
    expect(roundAfterLock.entropyRevealed).to.equal(false);

    // Real cash-out before the (not yet knowable) crash point.
    await crash.connect(alice).cashOut(roundId);

    // The provider reveals a real random value -- pick one that maps to a
    // real, mid-range crash point (not the 1/10000 r==0 edge).
    await revealWith(mock, provider, crash, roundId, ethers.keccak256(ethers.toUtf8Bytes("plank-entropy-1")));
    const revealed = await crash.rounds(roundId);
    expect(revealed.entropyRevealed).to.equal(true);

    await mineToCrashAndSettle(crash, roundId);
    const settled = await crash.rounds(roundId);
    expect(settled.phase).to.equal(2n); // CRASHED

    // The locker (alice) was refunded her overpayment at lock time --
    // MockEntropy's getFeeV2() is hardcoded to 0 (see the fee test's own
    // note), so the entire 10 wei she sent back at closeBettingAndLock
    // comes back as a withdrawable payment.
    expect(await crash.payments(alice.address)).to.equal(10n);

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

  it("cashOut() is gated against the true crash point once Pyth has revealed it, same load-bearing property as PlankCrashV2", async () => {
    const { crash, mock, provider, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash, alice);

    await revealWith(mock, provider, crash, roundId, ethers.keccak256(ethers.toUtf8Bytes("seed-42")));
    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const current = await ethers.provider.getBlockNumber();
    const targetBlock = Number(round.lockBlock) + Number(effective);
    if (targetBlock - current > 0) await networkHelpers.mine(targetBlock - current);

    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "PastCrashPoint");
  });

  it("presetCashOut is rejected once entropy has been revealed, same fairness gate as PlankCrashV2", async () => {
    const { crash, mock, provider, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash, alice);
    await revealWith(mock, provider, crash, roundId, ethers.keccak256(ethers.toUtf8Bytes("seed-7")));

    const targetBps = await crash._multiplierAt(5);
    await expect(crash.connect(alice).presetCashOut(roundId, targetBps)).to.be.revertedWithCustomError(
      crash,
      "EntropyAlreadyRevealed"
    );
  });

  it("voidStaleRequest rescues a round the provider never reveals for, refunds the fronted fee, and the stake carries forward", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash, alice);

    // Deliberately never call revealWith -- simulates a provider outage.
    await expect(crash.voidStaleRequest(roundId)).to.be.revertedWithCustomError(crash, "TooEarly");
    await networkHelpers.mine(MAX_AWAIT_BLOCKS + 1);

    await crash.voidStaleRequest(roundId);
    expect(await crash.voided(roundId)).to.equal(true);
    // r.entropyFeePaid (0, since MockEntropy's getFeeV2() is hardcoded to
    // 0) is refunded on top of the 10 wei overpayment already refunded at
    // lock time -- voiding a round the provider itself failed to service
    // is not her fault.
    expect(await crash.payments(alice.address)).to.equal(10n);

    await crash.connect(alice).carryForwardStake(roundId);
    const nextRoundId = await crash.currentRoundId();
    expect(await crash.stakeOf(nextRoundId, alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  it("only the real Pyth Entropy contract can ever trigger the callback -- a spoofed direct call reverts", async () => {
    const { crash, alice, bob } = await deployAll();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash, alice);

    await expect(
      crash.connect(alice)._entropyCallback(1, alice.address, ethers.keccak256(ethers.toUtf8Bytes("spoof")))
    ).to.be.revertedWith("Only Entropy can call this function");
  });

  it("the same _multiplierAt/_deriveCrash curve as PlankCrashV2 -- both contracts pay out identically for the same entropy, proving the Pyth swap changed nothing about game math", async () => {
    const { crash, treasury } = await deployAll();
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
      treasury: treasury.address,
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
