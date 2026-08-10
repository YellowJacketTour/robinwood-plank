import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * ============================================================================
 * PHASE 3 — WEIGHT REFORM (DESIGN-HONEST-INDEX-2026-08-09 §3).
 * Closes audit C-4, H-4, H-6, H-8.
 *
 * EVERY TEST HERE IS WRITTEN TO GO RED IF ITS MECHANISM IS REMOVED. The audit's
 * meta-finding was that three load-bearing tests proved nothing (an assertion
 * true on both branches, a cited-but-missing file, a source-code grep), so each
 * `it()` below names the exact pre-fix behaviour it would observe if the fix
 * were reverted.
 * ============================================================================
 */
describe("WeightModule — Phase 3 weight reform (C-4 / H-4 / H-6 / H-8)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const K_BLOCKS = 50_400n;
  const DECAY_BLOCKS = 100_800n;
  const BUCKET = 1_200n;
  const BUCKETS = 6n;
  const WAD = 10n ** 18n;
  const ALPHA_F_WAD = 450_000_000_000_000_000n;
  const EWMA_ALPHA_WAD = 200_000_000_000_000_000n;

  async function fixture() {
    const [deployer, vaultA, vaultB, vaultC, robinwood, stranger] = await ethers.getSigners();
    const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
    const wm: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());
    for (const v of [vaultA, vaultB, vaultC, robinwood]) await factory.setVault(v.address, true);
    return { deployer, vaultA, vaultB, vaultC, robinwood, stranger, factory, wm };
  }

  /** Report depth in every bucket of the whole window — i.e. genuinely HOLD
   * the liquidity, for the full window duration. Takes all vaults at once
   * because the window is wall-clock: filling one vault's window while
   * another sits idle lets the idle one's window roll off, which is exactly
   * the property under test. */
  async function holdDepth(wm: any, entries: Array<[any, bigint]>) {
    for (let i = 0n; i < BUCKETS + 1n; i++) {
      for (const [signer, amount] of entries) {
        await wm.connect(signer).noteDepth(signer.address, amount);
      }
      await mine(BUCKET);
    }
    for (const [signer, amount] of entries) {
      await wm.connect(signer).noteDepth(signer.address, amount);
    }
  }

  /** The score a vault would have from its UNRECOVERABLE FEE ALONE, at its
   * own current maturity — the yardstick every "signal X is worth zero"
   * assertion is measured against. */
  async function pureFeeScore(wm: any, addr: string, fee: bigint) {
    const st = await wm.scores(addr);
    const now = BigInt(await ethers.provider.getBlockNumber());
    const delta = now - BigInt(st.firstFeeBlock);
    const m = (delta * WAD) / (delta + K_BLOCKS);
    return (m * ((ALPHA_F_WAD * fee) / WAD)) / WAD;
  }

  /** Clear the admit floor (sink-delivered fee only). */
  async function contribute(wm: any, signer: any, amount: bigint) {
    await wm.connect(signer).noteFee(signer.address, amount);
  }

  // ──────────────────────────────────────────────────────────────────────
  // §3.2 — DEPTH IS A WINDOWED MINIMUM (closes C-4 / H-6)
  // ──────────────────────────────────────────────────────────────────────

  it("R-D1: a flash-loaned depth spike is minimised away — it does NOT latch (pre-fix: latched forever)", async () => {
    const { vaultA, vaultB, wm } = await fixture();

    // Attacker: one enormous sample (flash-loan addLiquidity -> dust swap ->
    // removeLiquidity), then silence. This is verbatim audit C-4's cheap path.
    await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("10000"));

    // Honest vault: a hundredth of that, but genuinely HELD across the window.
    await holdDepth(wm, [[vaultB, ethers.parseEther("100")]]);

    // Pre-fix (`vs.depthWeth = reserveWethWei`, read straight by _rawScore)
    // this would be 10000 ether and would stay 10000 ether forever.
    expect(await wm.windowMinDepth(vaultA.address)).to.equal(0n);
    expect(await wm.windowMinDepth(vaultB.address)).to.equal(ethers.parseEther("100"));
  });

  it("R-D2: holding real liquidity for the whole window is the ONLY way to earn depth weight", async () => {
    const { vaultA, vaultB, wm } = await fixture();
    const fee = ethers.parseEther("1");
    await contribute(wm, vaultA, fee);
    await contribute(wm, vaultB, fee);

    await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("10000")); // spike
    await holdDepth(wm, [[vaultB, ethers.parseEther("100")]]); // held

    // Identical unrecoverable contribution; B wins purely on real, sustained
    // depth. Pre-fix, A's latched 10000 would have dominated by 100x.
    const sA: bigint = await wm.score(vaultA.address);
    const sB: bigint = await wm.score(vaultB.address);
    expect(sB).to.be.gt(sA);
  });

  it("R-D3: a single low sample inside a bucket cannot be erased by a later spike in the same bucket", async () => {
    const { vaultA, wm } = await fixture();
    // Establish a full, honest window first, then within the CURRENT bucket
    // report a trough and immediately try to paper over it with a spike.
    await holdDepth(wm, [[vaultA, ethers.parseEther("100")]]);
    await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("1"));
    await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("9999"));
    expect(await wm.windowMinDepth(vaultA.address)).to.equal(ethers.parseEther("1"));
  });

  it("R-D4: pokeDepth is permissionless — anyone may put a thin pool on the record", async () => {
    const { vaultA, stranger, wm } = await fixture();
    await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("500"));
    // A non-conforming (EOA) vault has no readable paymentReserve, so an
    // honest poke records ZERO — the vault cannot hide behind silence.
    await wm.connect(stranger).pokeDepth(vaultA.address);
    expect(await wm.windowMinDepth(vaultA.address)).to.equal(0n);
    // Still gated to real factory vaults.
    await expect(wm.pokeDepth(stranger.address)).to.be.revertedWithCustomError(wm, "NotFactoryVault");
  });

  // ──────────────────────────────────────────────────────────────────────
  // §3.2 — VOLUME IS SINK FEE, AND THE EWMA HAS NO UNDAMPED FIRST SAMPLE
  // ──────────────────────────────────────────────────────────────────────

  it("R-V1: the first volume sample enters DAMPED at ALPHA (pre-fix: seeded raw, owning the signal in one print)", async () => {
    const { vaultA, wm } = await fixture();
    const print = ethers.parseEther("1000");
    await wm.connect(vaultA).noteVolume(vaultA.address, print);
    const ewma: bigint = (await wm.scores(vaultA.address)).volumeEwma;
    // Pre-fix: `vs.volumeEwma == 0 ? feeDerivedVolumeWei : ...` => exactly `print`.
    expect(ewma).to.equal((print * EWMA_ALPHA_WAD) / WAD);
    expect(ewma).to.be.lt(print);
  });

  it("R-V2: zero-sink volume buys zero weight — gross notional is free, so it counts for nothing", async () => {
    const { vaultA, vaultB, wm } = await fixture();
    const fee = ethers.parseEther("1");
    await contribute(wm, vaultA, fee);
    await contribute(wm, vaultB, fee);
    // A wash-trades enormous notional whose sink cut is 0 (round-trips cancel).
    for (let i = 0; i < 20; i++) await wm.connect(vaultA).noteVolume(vaultA.address, 0n);
    await mine(K_BLOCKS);
    // A's score is EXACTLY its unrecoverable-fee score: 20 volume prints with
    // no sink cut moved it by zero wei. Pre-fix the first print alone seeded
    // the EWMA raw and DELTA_V-weighted it straight into the composite.
    expect(await wm.score(vaultA.address)).to.equal(await pureFeeScore(wm, vaultA.address, fee));
    expect(await wm.score(vaultB.address)).to.equal(await pureFeeScore(wm, vaultB.address, fee));
  });

  // ──────────────────────────────────────────────────────────────────────
  // §3.1 — ONLY UNRECOVERABLE CONTRIBUTION COUNTS (closes H-4)
  // ──────────────────────────────────────────────────────────────────────

  it("R-F1: a zero sink cut starts no clock and earns nothing — 100%-to-own-treasury is not a contribution", async () => {
    const { vaultA, wm } = await fixture();
    await wm.connect(vaultA).noteFee(vaultA.address, 0n);
    expect((await wm.scores(vaultA.address)).firstFeeBlock).to.equal(0n);
    await mine(K_BLOCKS);
    expect(await wm.score(vaultA.address)).to.equal(0n);
    await expect(wm.checkAdmit(vaultA.address)).to.be.revertedWithCustomError(wm, "NotAdmitted");
  });

  it("R-H4: R <= C — an attacker's score is a function of unrecoverable contribution ALONE", async () => {
    const { vaultA, vaultB, wm } = await fixture();
    const C = ethers.parseEther("1");

    // A pays C to the commons and then fires EVERY free signal it can reach:
    // flash-loaned depth spikes, gross wash volume with no sink cut, and
    // round-trip mint pressure. This is the whole H-4 toolkit.
    await contribute(wm, vaultA, C);
    for (let i = 0; i < 5; i++) {
      await wm.connect(vaultA).noteDepth(vaultA.address, ethers.parseEther("10000"));
      await wm.connect(vaultA).noteVolume(vaultA.address, 0n);
      await wm.connect(vaultA).noteMintPressure(vaultA.address, ethers.parseEther("50"));
      await wm.connect(vaultA).noteMintPressure(vaultA.address, ethers.parseEther("-50"));
    }
    // B pays the same C and does nothing else at all.
    await contribute(wm, vaultB, C);

    await mine(K_BLOCKS + BUCKET * (BUCKETS + 1n));

    const sA: bigint = await wm.score(vaultA.address);
    const sB: bigint = await wm.score(vaultB.address);
    // EXACT equality: every free lever A pulled is worth exactly zero, so the
    // reward attracted by contributing C cannot exceed the reward for
    // contributing C honestly. Pre-fix, A's latched depth alone made
    // sA >= 1000x sB. This is the in-module half of the `R <= C` bound; the
    // other half (purchases priced at the realizable integral, so a bought
    // weight cannot be sold back at a profit) lives in the adapters and is
    // tested in AuditPoc.energy.test.ts.
    expect(sA).to.equal(await pureFeeScore(wm, vaultA.address, C));
    expect(sB).to.equal(await pureFeeScore(wm, vaultB.address, C));
    expect(sA).to.be.gt(0n);
    // ...and the two land within a hair of each other, differing only by the
    // handful of blocks A's own attack transactions consumed.
    const diff = sA > sB ? sA - sB : sB - sA;
    expect(diff * 1_000n).to.be.lt(sB);
  });

  // ──────────────────────────────────────────────────────────────────────
  // §3.2 — DECAY GENUINELY REACHES ZERO
  // ──────────────────────────────────────────────────────────────────────

  it("R-DK1: a dormant vault's score decays to EXACTLY zero (pre-fix: hyperbolic, ~2 years to reach 1%)", async () => {
    const { vaultA, wm } = await fixture();
    await contribute(wm, vaultA, ethers.parseEther("1"));
    await mine(K_BLOCKS);
    const alive: bigint = await wm.score(vaultA.address);
    expect(alive).to.be.gt(0n);

    // Halves every DECAY_BLOCKS of silence past the grace window.
    await mine(DECAY_BLOCKS * 3n);
    const decayed: bigint = await wm.score(vaultA.address);
    expect(decayed).to.be.lt(alive / 3n); // >=2 halvings elapsed

    await mine(DECAY_BLOCKS * 130n);
    expect(await wm.score(vaultA.address)).to.equal(0n);
  });

  // ──────────────────────────────────────────────────────────────────────
  // §3.3 — EXIT-CAPACITY CAP AND EXACT RENORMALIZATION (closes H-8)
  // ──────────────────────────────────────────────────────────────────────

  it("R-H8: weights sum to EXACTLY 10000 for 1, 2 and 3 admitted vaults (pre-fix: 2500 / 5000 / 7500)", async () => {
    const { vaultA, vaultB, vaultC, wm } = await fixture();
    const signers = [vaultA, vaultB, vaultC];
    const admitted: any[] = [];
    for (const v of signers) {
      await contribute(wm, v, ethers.parseEther("1"));
      await mine(K_BLOCKS / 10n);
      await wm.checkAdmit(v.address);
      admitted.push(v);

      const [vaults, wBps] = await wm.weights();
      expect(vaults.length).to.equal(admitted.length);
      const sum = wBps.reduce((a: bigint, b: bigint) => a + b, 0n);
      expect(sum).to.equal(10_000n);
    }
  });

  it("R-EC1: a thin pool cannot hold a large weight no matter how large its score", async () => {
    const { vaultA, vaultB, wm } = await fixture();

    // A: dominant contribution, but a pool a hundredth as deep as B's.
    await contribute(wm, vaultA, ethers.parseEther("1000"));
    await contribute(wm, vaultB, ethers.parseEther("1"));
    await mine(K_BLOCKS);
    await wm.checkAdmit(vaultA.address);
    await wm.checkAdmit(vaultB.address);

    await holdDepth(wm, [
      [vaultA, ethers.parseEther("1")],
      [vaultB, ethers.parseEther("99")],
    ]);

    const capA: bigint = await wm.exitCapacityWeth(vaultA.address);
    const capB: bigint = await wm.exitCapacityWeth(vaultB.address);
    expect(capA).to.equal(ethers.parseEther("1") / 10n); // 10% haircut window
    expect(capB).to.equal(ethers.parseEther("99") / 10n);

    const [vaults, wBps] = await wm.weights();
    const idxA = vaults.indexOf(vaultA.address);
    const idxB = vaults.indexOf(vaultB.address);
    // A's cap is its share of measured exit capacity: 1/(1+99) = 100 bps.
    expect(wBps[idxA]).to.equal(100n);
    expect(wBps[idxB]).to.equal(9_900n);
    expect(wBps[idxA] + wBps[idxB]).to.equal(10_000n);
    // Pre-fix, the fiat W_MAX_BPS would have given A 2500 bps over a pool it
    // could never exit, and the pair would have summed to 5000.
  });

  // ──────────────────────────────────────────────────────────────────────
  // §3.4 — THE ROBINWOOD FLOOR, 8.1%, SELF-FULFILLING
  // ──────────────────────────────────────────────────────────────────────

  it("R-RW1: Robinwood receives at least 810 bps even with a near-zero meritocratic score", async () => {
    const { vaultA, robinwood, wm } = await fixture();
    await wm.setRobinwoodVault(robinwood.address);

    await contribute(wm, vaultA, ethers.parseEther("1000"));
    await contribute(wm, robinwood, ethers.parseEther("0.05")); // zero-fee marketplace
    await mine(K_BLOCKS);
    await wm.checkAdmit(vaultA.address);
    await wm.checkAdmit(robinwood.address);

    // Both hold ample, equal depth, so exit capacity supports the floor.
    await holdDepth(wm, [
      [vaultA, ethers.parseEther("100")],
      [robinwood, ethers.parseEther("100")],
    ]);

    const [vaults, wBps] = await wm.weights();
    const idxRw = vaults.indexOf(robinwood.address);
    expect(wBps[idxRw]).to.be.gte(810n);
    expect(await wm.robinwoodShortfallBps()).to.equal(0n);
    expect(wBps.reduce((a: bigint, b: bigint) => a + b, 0n)).to.equal(10_000n);
  });

  it("R-RW2: where exit capacity cannot support 8.1%, the floor is NOT faked — the shortfall is published for Pipe L", async () => {
    const { vaultA, robinwood, wm } = await fixture();
    await wm.setRobinwoodVault(robinwood.address);

    await contribute(wm, vaultA, ethers.parseEther("1000"));
    await contribute(wm, robinwood, ethers.parseEther("1"));
    await mine(K_BLOCKS);
    await wm.checkAdmit(vaultA.address);
    await wm.checkAdmit(robinwood.address);

    // Robinwood's pool is far too thin to exit 8.1% of the index.
    await holdDepth(wm, [
      [vaultA, ethers.parseEther("1000")],
      [robinwood, ethers.parseEther("1")],
    ]);

    const capBps = (10_000n * 1n) / 1001n; // ~9 bps of measured capacity
    const shortfall: bigint = await wm.robinwoodShortfallBps();
    expect(shortfall).to.be.gt(0n);
    expect(shortfall).to.equal(810n - capBps);

    const [vaults, wBps] = await wm.weights();
    const idxRw = vaults.indexOf(robinwood.address);
    // Held to what it can honestly pay — §1 is not negotiable — rather than
    // printed at 810 over a pool that cannot honour it.
    expect(wBps[idxRw]).to.be.lt(810n);
    expect(wBps[idxRw]).to.equal(capBps);
    expect(wBps.reduce((a: bigint, b: bigint) => a + b, 0n)).to.equal(10_000n);
  });

  it("R-RW3: Robinwood can be named exactly once, only by the deployer", async () => {
    const { deployer, vaultA, vaultB, stranger, wm } = await fixture();
    await expect(wm.connect(stranger).setRobinwoodVault(vaultA.address)).to.be.revertedWithCustomError(
      wm,
      "NotRobinwoodSetter"
    );
    await wm.connect(deployer).setRobinwoodVault(vaultA.address);
    await expect(wm.connect(deployer).setRobinwoodVault(vaultB.address)).to.be.revertedWithCustomError(
      wm,
      "RobinwoodAlreadySet"
    );
    expect(await wm.robinwoodVault()).to.equal(vaultA.address);
  });
});
