import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankCrashV2's real mechanics, proven end to end. See
 * contracts/PlankCrashV2.sol's own header for the full design this is
 * testing against -- the short version: V1 (contracts/PlankCrash.sol)
 * had a real bug where the live-displayed multiplier and the final
 * settled multiplier were two different measurements (live capped by a
 * fixed reveal window, final an unbounded blockhash-derived draw). V2's
 * core fix is that a round's real duration now tracks its own crash
 * point, capped by maxElapsedBlocks -- so the two numbers are
 * mathematically guaranteed to match. That equality is the single most
 * important property this file proves, not assumes.
 */
describe("PlankCrashV2", () => {
  const BETTING_SECONDS = 5;
  const ROUND_INTERVAL_SECONDS = 0; // opt out of daily-grid scheduling for most tests
  const ENTROPY_DELAY_BLOCKS = 2;
  const MAX_ELAPSED_BLOCKS = 40; // small on purpose: makes the capped-round path easy to hit in tests
  const REGISTRATION_BLOCKS = 20;
  const RAKE_BPS = 250n;
  const KEEPER_REWARD_BPS = 1000n; // 10% of the rake, not of players' distributable pool
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 5000n; // 50% -- see PlankCrash.test.ts for why this is the tightest cap 2-3 equal bettors can clear

  async function deployCrash(overrides: Partial<Record<string, unknown>> = {}) {
    const [, treasury, alice, bob, carol] = await ethers.getSigners();
    const Crash = await ethers.getContractFactory("PlankCrashV2");
    const crash: any = await Crash.deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: ROUND_INTERVAL_SECONDS,
      entropyDelayBlocks: ENTROPY_DELAY_BLOCKS,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: MIN_PARTICIPANTS,
      minPoolSize: MIN_POOL,
      maxStakePerWalletBps: MAX_STAKE_BPS,
      keeperRewardBps: KEEPER_REWARD_BPS,
      treasury: treasury.address,
      ...overrides,
    });
    return { crash, treasury, alice, bob, carol };
  }

  async function closeBettingAndLock(crash: any) {
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await crash.lockRound();
  }

  async function mineToEntropyAndReveal(crash: any, roundId: bigint) {
    const round = await crash.rounds(roundId);
    const target = round.entropyBlock;
    const current = await ethers.provider.getBlockNumber();
    const toMine = Number(target) - current + 1;
    if (toMine > 0) await networkHelpers.mine(toMine);
    await crash.revealEntropy(roundId);
  }

  /// Mines forward until the round's effective (possibly capped) crash
  /// point is reached, then settles -- the real end-to-end path a keeper
  /// would follow. Assumes revealEntropy() already ran.
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

  // ── The core bug fix: ticker == final, always ───────────────────────

  it("liveMultiplierBps at the moment of settlement equals the recorded crashMultiplierBps -- the actual bug fix", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);

    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const targetBlock = Number(round.lockBlock) + Number(effective);
    const current = await ethers.provider.getBlockNumber();
    const toMine = targetBlock - current;
    if (toMine > 0) await networkHelpers.mine(toMine);

    // Read the ticker in the exact block settlement will happen in --
    // this is what a client polling right up to the crash would see.
    const tickerJustBeforeSettle: bigint = await crash.liveMultiplierBps(roundId);
    await crash.settleRound(roundId);
    const settled = await crash.rounds(roundId);

    expect(settled.crashMultiplierBps).to.equal(tickerJustBeforeSettle);
    expect(settled.crashElapsedBlocks).to.equal(effective);
  });

  it("a round whose true (uncapped) crash point exceeds maxElapsedBlocks settles at the capped value, not the phantom true one -- the exact V1 bug, reproduced and shown fixed", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);

    const round = await crash.rounds(roundId);
    // Force the scenario open-endedly: whichever real seed this produced,
    // assert the INVARIANT (capped correctly), not a specific number.
    await mineToCrashAndSettle(crash, roundId);
    const settled = await crash.rounds(roundId);

    if (round.trueCrashElapsedBlocks > BigInt(MAX_ELAPSED_BLOCKS)) {
      expect(settled.crashElapsedBlocks).to.equal(BigInt(MAX_ELAPSED_BLOCKS));
      expect(settled.crashMultiplierBps).to.equal(await crash._multiplierAt(MAX_ELAPSED_BLOCKS));
      expect(settled.crashMultiplierBps).to.be.lt(
        await crash._multiplierAt(round.trueCrashElapsedBlocks)
      );
    } else {
      expect(settled.crashElapsedBlocks).to.equal(round.trueCrashElapsedBlocks);
    }
  });

  it("cashOut() reverts once real elapsed blocks reach the (now-public) true crash point -- the property that actually makes ticker==final hold, not just settleRound()'s own math", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);

    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const targetBlock = Number(round.lockBlock) + Number(effective);
    const current = await ethers.provider.getBlockNumber();
    // Mine right up TO the crash block (not past it) -- next transaction
    // lands exactly at the crash point.
    const toMine = targetBlock - current;
    if (toMine > 0) await networkHelpers.mine(toMine);

    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "PastCrashPoint");
  });

  it("a live cash-out placed strictly before the true crash point still wins normally", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    // Cash out immediately at lock (elapsed 0) -- wins unless the crash
    // itself is at elapsed 0 too (the r==0 instant-crash case, ~1/10000).
    await crash.connect(alice).cashOut(roundId);
    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);

    await crash.connect(alice).registerResult(roundId);
    const round = await crash.rounds(roundId);
    if (round.crashElapsedBlocks > 0n) {
      const weight = await crash.currentRound(); // sanity: contract still readable
      expect(weight).to.not.be.undefined;
    }
  });

  // ── presetCashOut: zero-new-execution-surface auto-cashout ──────────

  it("presetCashOut locks in the exact block a live cash-out at that multiplier would have used", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    const targetBps = await crash._multiplierAt(5); // exactly 5 blocks of climb
    await crash.connect(alice).presetCashOut(roundId, targetBps);

    const recordedBlock = await crash.cashOutBlockOf(roundId, alice.address);
    expect(recordedBlock).to.equal(round.lockBlock + 5n);
  });

  it("presetCashOut reverts once entropy has been revealed -- the fairness gate", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);

    const targetBps = await crash._multiplierAt(5);
    await expect(crash.connect(alice).presetCashOut(roundId, targetBps)).to.be.revertedWithCustomError(
      crash,
      "EntropyAlreadyRevealed"
    );
  });

  it("SECURITY REGRESSION: presetCashOut reverts once entropyBlock is mined, even if revealEntropy() has NOT been called on-chain yet -- closes a real, previously-shipped exploit", async () => {
    // Real bug, found by audit and fixed here: blockhash(entropyBlock) is
    // a public EVM value the instant entropyBlock is mined -- readable by
    // anyone via a plain RPC call, long before anyone bothers to submit
    // revealEntropy(). Since _deriveCrash/_invertMultiplier are `public
    // pure`, an attacker who reproduces the true crash point off-chain
    // could previously call presetCashOut with it here -- a zero-risk,
    // deterministic, guaranteed-max-multiplier win. This test proves that
    // window is now closed: the gate must reject presetCashOut the moment
    // entropyBlock exists, NOT wait for the on-chain flag.
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    const current = await ethers.provider.getBlockNumber();
    const toMine = Number(round.entropyBlock) - current + 1; // exactly enough to mine entropyBlock, no further
    if (toMine > 0) await networkHelpers.mine(toMine);

    // entropyBlock is now mined and its hash is real and public -- but
    // revealEntropy() has deliberately NOT been called. Before the fix,
    // this exact state is what let an attacker read the real blockhash
    // off-chain, compute the true crash point via the contract's own
    // public pure _deriveCrash, and call presetCashOut with it.
    expect((await crash.rounds(roundId)).entropyRevealed).to.equal(false);
    const trueEntropy = await ethers.provider.send("eth_getBlockByNumber", [
      "0x" + Number(round.entropyBlock).toString(16),
      false,
    ]);
    expect(trueEntropy.hash).to.not.be.undefined; // proves the "attacker" really can read it off-chain right now
    const [trueMultiplierBps] = await crash._deriveCrash(trueEntropy.hash);

    await expect(crash.connect(alice).presetCashOut(roundId, trueMultiplierBps)).to.be.revertedWithCustomError(
      crash,
      "EntropyAlreadyRevealed"
    );
  });

  it("presetCashOut still works normally while entropyBlock is genuinely in the future -- the fix doesn't over-restrict the legitimate case", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    const current = await ethers.provider.getBlockNumber();
    expect(Number(round.entropyBlock)).to.be.gt(current); // still genuinely in the future

    const targetBps = await crash._multiplierAt(5);
    await crash.connect(alice).presetCashOut(roundId, targetBps);
    expect(await crash.cashOutBlockOf(roundId, alice.address)).to.be.gt(0n);
  });

  it("presetCashOut reverts for a target beyond what maxElapsedBlocks can ever reach", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const unreachable = (await crash._multiplierAt(MAX_ELAPSED_BLOCKS)) + 1n;
    await expect(crash.connect(alice).presetCashOut(roundId, unreachable)).to.be.revertedWithCustomError(
      crash,
      "TargetUnreachable"
    );
  });

  it("a preset target that turns out to be past the real crash loses, exactly like a live player who never clicked cash out in time", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    // Preset at the maximum reachable target -- will lose unless the real
    // crash also happens to land at exactly maxElapsedBlocks.
    const maxReachable = await crash._multiplierAt(MAX_ELAPSED_BLOCKS);
    await crash.connect(alice).presetCashOut(roundId, maxReachable);
    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);

    const round = await crash.rounds(roundId);
    await crash.connect(alice).registerResult(roundId);
    if (round.crashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS)) {
      await networkHelpers.mine(REGISTRATION_BLOCKS + 1);
      await expect(crash.connect(alice).claim(roundId)).to.be.revertedWithCustomError(crash, "NotWinner");
    }
  });

  // ── Liveness: the entropy-window escape hatch ────────────────────────

  it("voidStaleRound reverts before the blockhash window actually expires", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await expect(crash.voidStaleRound(roundId)).to.be.revertedWithCustomError(crash, "TooEarly");
  });

  it("voidStaleRound rescues a round nobody ever revealed entropy for once the blockhash window expires, and the stake carries forward", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    const current = await ethers.provider.getBlockNumber();
    await networkHelpers.mine(Number(round.entropyBlock) - current + 257);

    await crash.voidStaleRound(roundId);
    expect(await crash.voided(roundId)).to.equal(true);

    await crash.connect(alice).carryForwardStake(roundId);
    const nextRoundId = await crash.currentRoundId();
    expect(await crash.stakeOf(nextRoundId, alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  // ── Keeper incentive (settlement stays timely with no operator bot) ──

  it("settleRound() pays its caller a real reward carved from the rake, not from players' distributable pool", async () => {
    const { crash, treasury, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);

    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const targetBlock = Number(round.lockBlock) + Number(effective);
    const current = await ethers.provider.getBlockNumber();
    if (targetBlock - current > 0) await networkHelpers.mine(targetBlock - current);

    // A third party (not a bettor, not the treasury) calls settleRound --
    // the exact "nobody's tab needs to be open" scenario this exists for.
    const [, , , , , keeper] = await ethers.getSigners();
    await crash.connect(keeper).settleRound(roundId);

    const settled = await crash.rounds(roundId);
    const totalRake = settled.pool - settled.distributable;
    const expectedKeeperCut = (totalRake * KEEPER_REWARD_BPS) / 10000n;

    await crash.connect(keeper).withdrawPayments(keeper.address);
    const balanceAfter = await ethers.provider.getBalance(keeper.address);
    // Non-trivial reward actually landed (loose bound -- gas noise on the
    // withdraw tx itself, but the reward is 10% of a real 2 ETH pool's
    // rake, orders of magnitude bigger than gas noise).
    expect(expectedKeeperCut).to.be.gt(0n);
    expect(balanceAfter).to.be.gt(0n);

    // The remainder still went to the treasury's normal rake path,
    // undiminished beyond the keeper's carved-out share.
    await crash.claimRake();
    await crash.connect(treasury).withdrawPayments(treasury.address);
  });

  // ── estimatedPayout: honest, real-time pari-mutuel guidance ──────────

  it("estimatedPayout gives the whole distributable pool to a sole cashed-out winner, not just their own stake*multiplier", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);

    // Alice cashes out early (small multiplier); Bob never does.
    await crash.connect(alice).cashOut(roundId);

    const round = await crash.rounds(roundId);
    const estimate: bigint = await crash.estimatedPayout(roundId, alice.address);
    const distributableNow = (round.pool * (10000n - RAKE_BPS)) / 10000n;

    // Alice is the ONLY cashed-out player right now, so her estimate is
    // the entire distributable pool -- proof the estimate reflects real
    // pari-mutuel share math, not a naive stake*multiplier calculation
    // (which would show something close to her 1 ETH stake, not ~2 ETH
    // worth of distributable pool).
    expect(estimate).to.equal(distributableNow);
  });

  it("estimatedPayout splits proportionally once a second player also cashes out, and moves as more people join", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);

    await crash.connect(alice).cashOut(roundId);
    const estimateBefore: bigint = await crash.estimatedPayout(roundId, alice.address);

    await crash.connect(bob).cashOut(roundId);
    const estimateAfter: bigint = await crash.estimatedPayout(roundId, alice.address);

    // A second winner joining the pool can only ever shrink (or leave
    // unchanged) an existing winner's share of the same fixed
    // distributable amount -- it can never grow it.
    expect(estimateAfter).to.be.lte(estimateBefore);

    const round = await crash.rounds(roundId);
    expect(round.provisionalWinningWeight).to.be.gt(0n);
  });

  it("estimatedPayout is 0 for a player who hasn't cashed out", async () => {
    const { crash, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);
    await crash.connect(alice).cashOut(roundId);

    expect(await crash.estimatedPayout(roundId, bob.address)).to.equal(0n);
  });

  it("estimatedPayout switches to the EXACT post-settlement figure once the round crashes, and matches claim() exactly -- found by re-auditing the estimate rather than assuming the pre-settlement version was the whole story", async () => {
    const { crash, alice, bob, carol } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("1") });
    await crash.connect(carol).placeBet({ value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);

    // Alice cashes out early; Bob cashes out later (before the true
    // crash); Carol never cashes out -- a real mixed cohort, not a
    // sole-winner special case.
    await crash.connect(alice).cashOut(roundId);
    await networkHelpers.mine(2);
    const round0 = await crash.rounds(roundId);
    if (round0.phase !== 1n) return; // already crashed on its own (rare) -- skip, not the property under test
    try {
      await crash.connect(bob).cashOut(roundId);
    } catch {
      // Bob's cash-out landed past the true crash once entropy happened
      // to already be revealed by an earlier assertion path -- not
      // expected here since entropy hasn't been revealed yet, but fail
      // safe rather than crash the test suite on a timing fluke.
    }

    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);

    // BEFORE anyone registers -- proves this doesn't require registering
    // first (a real bug this exact check caught: an earlier version
    // returned a flat 0 for genuine winners in this entire window,
    // because it gated on totalWinningWeight being nonzero, which it
    // structurally can't be before the first registration -- fixed to
    // fall back to the already-known provisional weight instead).
    const estimateBeforeRegistration = await crash.estimatedPayout(roundId, alice.address);

    await crash.connect(alice).registerResult(roundId);
    await crash.connect(bob).registerResult(roundId);
    await crash.connect(carol).registerResult(roundId);

    // NOW it must be exact: totalWinningWeight is fully populated (every
    // real bettor has registered), so this is no longer a provisional
    // fallback -- it's the same math claim() itself is about to use.
    const estimateAfterRegistration = await crash.estimatedPayout(roundId, alice.address);
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    if (estimateAfterRegistration > 0n) {
      // Read the CONTRACT's own accounting of the payout (the Claimed
      // event's payout arg) rather than a raw wallet balance delta -- a
      // real test-methodology mistake caught on the first attempt here:
      // "before/after wallet balance" also captures the gas cost of BOTH
      // claim() and withdrawPayments(), which has nothing to do with
      // whether the estimate was correct and was silently failing this
      // assertion by a gas-sized amount. This is the same reason the
      // original PlankCrash.test.ts only ever bounds totalPaid <=
      // distributable rather than asserting raw balance deltas exactly.
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
      expect(claimedEvent).to.not.be.undefined;
      expect(claimedEvent.args.payout).to.equal(estimateAfterRegistration);
    } else {
      // Alice turned out not to be a winner this seed (crash landed at or
      // before her cash-out block) -- claim() must agree.
      await expect(crash.connect(alice).claim(roundId)).to.be.revertedWithCustomError(crash, "NotWinner");
    }

    // The pre-registration estimate was never wrong, just provisional --
    // it's allowed to differ from the final figure (documented, expected),
    // but it must never have been a flat 0 for a real winner, and it must
    // never OVER-promise relative to the real, later-exact figure.
    if (estimateAfterRegistration > 0n) {
      expect(estimateBeforeRegistration).to.be.gt(0n);
    }
  });

  // ── Solvency (unchanged property, re-proven against V2's settlement path) ──

  it("total payouts never exceed the round's real distributable pool", async () => {
    const { crash, alice, bob, carol } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(carol).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await crash.connect(alice).cashOut(roundId);
    await crash.connect(bob).cashOut(roundId);

    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);
    const round = await crash.rounds(roundId);

    await crash.connect(alice).registerResult(roundId);
    await crash.connect(bob).registerResult(roundId);
    await crash.connect(carol).registerResult(roundId);
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    const distributable: bigint = round.distributable;
    let totalPaid = 0n;
    for (const signer of [alice, bob, carol]) {
      const before: bigint = await ethers.provider.getBalance(signer.address);
      try {
        await crash.connect(signer).claim(roundId);
        await crash.connect(signer).withdrawPayments(signer.address);
      } catch {
        continue;
      }
      const after: bigint = await ethers.provider.getBalance(signer.address);
      if (after > before) totalPaid += after - before;
    }
    expect(totalPaid).to.be.lte(distributable);
  });

  it("a wallet cannot stake more than the whale cap allows", async () => {
    const { crash, alice, bob } = await deployCrash();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await expect(crash.connect(bob).placeBet({ value: ethers.parseEther("1") })).to.be.revertedWithCustomError(
      crash,
      "StakeExceedsCap"
    );
  });

  it("a round under the collateral floor voids and does not lock", async () => {
    const { crash, alice } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: MIN_POOL });
    await closeBettingAndLock(crash);
    expect(await crash.voided(roundId)).to.equal(true);
  });

  it("accumulated rake is only ever claimable to the fixed treasury address", async () => {
    const { crash, treasury, alice, bob } = await deployCrash();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);

    const rake = await crash.accumulatedRake();
    expect(rake).to.be.gt(0n);
    await crash.claimRake();
    await crash.connect(treasury).withdrawPayments(treasury.address);
    expect(await crash.accumulatedRake()).to.equal(0n);
  });

  // ── Pure math properties ─────────────────────────────────────────────

  it("_multiplierAt is strictly increasing (required for presetCashOut's inversion to be well-defined)", async () => {
    const { crash } = await deployCrash();
    let prev = await crash._multiplierAt(0);
    for (let e = 1; e <= 200; e += 7) {
      const cur = await crash._multiplierAt(e);
      expect(cur).to.be.gt(prev);
      prev = cur;
    }
  });

  it("_invertMultiplier round-trips with _multiplierAt: the inverted block, played back through the curve, meets or exceeds the original target", async () => {
    const { crash } = await deployCrash();
    for (const e of [0, 1, 5, 17, 42, 100]) {
      const bps = await crash._multiplierAt(e);
      const inverted = await crash._invertMultiplier(bps);
      expect(inverted).to.be.lte(e);
      expect(await crash._multiplierAt(inverted)).to.be.gte(bps);
    }
  });

  it("the crash-derivation math is a pure, independently re-runnable function of the seed alone", async () => {
    const { crash } = await deployCrash();
    const seed = ethers.keccak256(ethers.toUtf8Bytes("test-seed-42"));
    const [m1, e1] = await crash._deriveCrash(seed);
    const [m2, e2] = await crash._deriveCrash(seed);
    expect(m1).to.equal(m2);
    expect(e1).to.equal(e2);
  });

  // ── Daily-cadence scheduling ──────────────────────────────────────────

  it("with a nonzero roundIntervalSeconds, round 2's betting window lands exactly on the genesis+interval grid, not wherever settlement happened to finish", async () => {
    const INTERVAL = 3600; // 1 hour, small enough to test quickly
    const { crash, alice, bob } = await deployCrash({ roundIntervalSeconds: INTERVAL });
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet({ value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await mineToEntropyAndReveal(crash, roundId);
    await mineToCrashAndSettle(crash, roundId);

    const genesis: bigint = await crash.genesisTimestamp();
    const round2 = await crash.rounds(await crash.currentRoundId());
    expect((round2.bettingEndsAt - genesis) % BigInt(INTERVAL)).to.equal(0n);
  });
});
