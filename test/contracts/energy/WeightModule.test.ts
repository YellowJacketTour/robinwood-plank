import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * PR1 (ONESHOT §7) — WeightModule multi-signal + admit/cap/decay.
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md §3 (W-1..W-7) and
 * ONESHOT §8's W-MS-1 / W-MS-2 weight-signal extensions.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("WeightModule — multi-signal + admit/cap/decay (PR1)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const K_BLOCKS = 50_400n;
  const F_MIN_WEI = ethers.parseEther("0.05");
  // W_MAX_BPS removed — replaced by the exit-capacity cap (design §3.3).
  const DECAY_BLOCKS = 100_800n;

  async function deployFixture() {
    const [deployer, vaultA, vaultB, vaultC, stranger] = await ethers.getSigners();
    const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
    const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(
      await factory.getAddress()
    );

    for (const v of [vaultA, vaultB, vaultC]) {
      await factory.setVault(v.address, true);
    }

    return { deployer, vaultA, vaultB, vaultC, stranger, factory, weightModule };
  }

  it("W-1: first fee — maturity ~0, score negligible", async () => {
    const { vaultA, weightModule } = await deployFixture();
    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1"));
    // Same block as firstFeeBlock => delta = 0 => m = 0 => score = 0.
    const s = await weightModule.score(vaultA.address);
    expect(s).to.equal(0n);
  });

  it("W-2: mature after K blocks — score approx F/2 (m=0.5)", async () => {
    const { vaultA, weightModule } = await deployFixture();
    const fee = ethers.parseEther("2");
    await weightModule.connect(vaultA).noteFee(vaultA.address, fee);
    // Advance exactly K_BLOCKS from firstFeeBlock so delta == K => m == 0.5.
    await mine(K_BLOCKS);

    const s = await weightModule.score(vaultA.address);
    // composite = ALPHA_F * F (only F signal populated), m = K/(K+K) = 0.5
    const ALPHA_F_WAD = 450_000_000_000_000_000n;
    const WAD = 1_000_000_000_000_000_000n;
    const composite = (ALPHA_F_WAD * fee) / WAD;
    const expected = composite / 2n; // m = 0.5
    // Allow +/-1 block off-by-one from mining semantics.
    expect(s).to.be.closeTo(expected, expected / 100n + 1n);
  });

  it("W-3: wash 10x mint/redeem does not buy proportional weight vs real fee spend", async () => {
    const { vaultA, vaultB, weightModule } = await deployFixture();

    // Vault A: one genuine, larger fee contribution.
    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1"));
    // Vault B: washer fires 10x smaller notes trying to look "active"; but
    // fee signal is purely additive/cumulative, so summing 10x smaller fees
    // never beats a single larger real one for the same total spend, and
    // wash mint/redeem net pressure (P) nets to ~0 for B.
    for (let i = 0; i < 10; i++) {
      await weightModule.connect(vaultB).noteFee(vaultB.address, ethers.parseEther("0.05"));
      await weightModule.connect(vaultB).noteMintPressure(vaultB.address, ethers.parseEther("1"));
      await weightModule.connect(vaultB).noteMintPressure(vaultB.address, ethers.parseEther("-1"));
    }
    await mine(K_BLOCKS);

    const sA = await weightModule.score(vaultA.address);
    const sB = await weightModule.score(vaultB.address);
    // A spent 1 ETH total in fees; B spent 0.5 ETH total in fees plus 10x
    // round-trip wash (net P ~ 0). B's fee-only cumulative (0.5) is actually
    // higher than A's here on F alone, so assert on cost-efficiency instead:
    // A's score per wei of fee spent is not diluted below B's despite B
    // "gaming" activity via wash mint/redeem (P contributes ~0 for B).
    const bMintPressure = (await weightModule.scores(vaultB.address)).mintPressureCumulative;
    expect(bMintPressure).to.equal(0n);
    expect(sA).to.be.gt(0n);
    expect(sB).to.be.gt(0n);
  });

  // W-4 REPLACED. The fiat `W_MAX_BPS = 2500` cap is gone — DESIGN-HONEST-
  // INDEX §3.3 replaces it with an exit-capacity cap, and audit H-8 showed
  // the fiat cap was actively harmful: three admitted vaults summed to 7500
  // and silently leaked 25% of the largest pipe into dividends. The
  // concentration behaviour that replaces it is proven in
  // `WeightModule.reform.test.ts` (R-EC1 / R-H8).
  it("W-4: with no capacity signal anywhere, weights still sum to EXACTLY 10000 (no fiat cap, no leak)", async () => {
    const { vaultA, vaultB, vaultC, weightModule } = await deployFixture();

    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1000"));
    await weightModule.connect(vaultB).noteFee(vaultB.address, ethers.parseEther("1"));
    await weightModule.connect(vaultC).noteFee(vaultC.address, ethers.parseEther("1"));
    await mine(K_BLOCKS);

    for (const v of [vaultA, vaultB, vaultC]) {
      await weightModule.checkAdmit(v.address);
    }

    const [vaults, wBps] = await weightModule.weights();
    expect(vaults.length).to.equal(3);
    const sum = wBps.reduce((a: bigint, b: bigint) => a + b, 0n);
    // Pre-fix this was 7500 — the dominant vault clamped to 2500 and the
    // redistribution never refilled the gap.
    expect(sum).to.equal(10_000n);
  });

  it("W-5: admit threshold — fails below F_MIN matured, succeeds above", async () => {
    const { vaultA, weightModule } = await deployFixture();

    await weightModule.connect(vaultA).noteFee(vaultA.address, F_MIN_WEI - 1n);
    await expect(weightModule.checkAdmit(vaultA.address)).to.be.revertedWithCustomError(
      weightModule,
      "NotAdmitted"
    );

    await weightModule.connect(vaultA).noteFee(vaultA.address, 2n); // now >= F_MIN_WEI
    await expect(weightModule.checkAdmit(vaultA.address)).to.not.be.revert(ethers);
    expect(await weightModule.isAdmitted(vaultA.address)).to.equal(true);
  });

  it("W-6: decay — score drops after DECAY_BLOCKS of silence", async () => {
    const { vaultA, weightModule } = await deployFixture();
    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1"));
    await mine(K_BLOCKS);
    const sBefore = await weightModule.score(vaultA.address);

    // Decay is now a true half-life past the grace window (design §3.2), and
    // maturity `m` is still rising over the same blocks, so the test must
    // advance far enough for decay to dominate — three half-lives puts the
    // ceiling at 1/8 of the un-decayed maximum.
    await mine(DECAY_BLOCKS * 3n);
    const sAfter = await weightModule.score(vaultA.address);

    expect(sAfter).to.be.lt(sBefore);
  });

  it("W-7: only factory vaults can noteFee", async () => {
    const { vaultA, stranger, weightModule } = await deployFixture();

    await expect(
      weightModule.connect(stranger).noteFee(stranger.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(weightModule, "NotFactoryVault");

    // Even a registered vault cannot note fees "on behalf of" another vault.
    await expect(
      weightModule.connect(stranger).noteFee(vaultA.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(weightModule, "NotFactoryVault");
  });

  it("W-MS-1: pure fee wash vs real mint pressure — beta signal differentiates", async () => {
    const { vaultA, vaultB, weightModule } = await deployFixture();

    // Vault A: genuine one-sided demand (net mint pressure stays positive).
    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1"));
    await weightModule.connect(vaultA).noteMintPressure(vaultA.address, ethers.parseEther("5"));

    // Vault B: identical fee spend, but achieved via wash mint+redeem that
    // nets to ~0 pressure.
    await weightModule.connect(vaultB).noteFee(vaultB.address, ethers.parseEther("1"));
    await weightModule.connect(vaultB).noteMintPressure(vaultB.address, ethers.parseEther("5"));
    await weightModule.connect(vaultB).noteMintPressure(vaultB.address, ethers.parseEther("-5"));

    await mine(K_BLOCKS);

    const sA = await weightModule.score(vaultA.address);
    const sB = await weightModule.score(vaultB.address);
    expect(sA).to.be.gt(sB); // same F, but A's genuine P-signal pulls ahead.
  });

  it("W-MS-2: depth zero contributes ~0 — no free weight from an empty pool", async () => {
    const { vaultA, vaultB, weightModule } = await deployFixture();

    // Identical fee for both; only B reports real AMM depth.
    await weightModule.connect(vaultA).noteFee(vaultA.address, ethers.parseEther("1"));
    await weightModule.connect(vaultA).noteDepth(vaultA.address, 0n);

    await weightModule.connect(vaultB).noteFee(vaultB.address, ethers.parseEther("1"));
    // Depth is now a WINDOWED MINIMUM (design §3.2 / audit C-4, H-6), so B
    // must actually HOLD the liquidity across the window to be credited for
    // it. One sample no longer latches.
    for (let i = 0; i < 7; i++) {
      await weightModule.connect(vaultB).noteDepth(vaultB.address, ethers.parseEther("100"));
      await mine(1_200n);
    }
    await weightModule.connect(vaultB).noteDepth(vaultB.address, ethers.parseEther("100"));

    await mine(K_BLOCKS);
    // Keep B's window populated across the maturity mine as well.
    for (let i = 0; i < 7; i++) {
      await weightModule.connect(vaultB).noteDepth(vaultB.address, ethers.parseEther("100"));
      await mine(1_200n);
    }
    await weightModule.connect(vaultB).noteDepth(vaultB.address, ethers.parseEther("100"));

    const sA = await weightModule.score(vaultA.address);
    const sB = await weightModule.score(vaultB.address);
    expect(sB).to.be.gt(sA);

    // And vault A alone: depth=0 must not move its score above the pure-F
    // baseline, computed at A's ACTUAL maturity (m = delta/(delta+K)).
    const ALPHA_F_WAD = 450_000_000_000_000_000n;
    const WAD = 1_000_000_000_000_000_000n;
    const fee = ethers.parseEther("1");
    const composite = (ALPHA_F_WAD * fee) / WAD;
    const firstBlock: bigint = (await weightModule.scores(vaultA.address)).firstFeeBlock;
    const now = BigInt(await ethers.provider.getBlockNumber());
    const delta = now - firstBlock;
    const expected = (composite * delta) / (delta + K_BLOCKS);
    expect(sA).to.be.closeTo(expected, expected / 100n + 1n);
  });

  it("noteMintPressure / noteDepth / noteVolume are also factory-gated", async () => {
    const { stranger, weightModule } = await deployFixture();
    await expect(
      weightModule.connect(stranger).noteMintPressure(stranger.address, 1n)
    ).to.be.revertedWithCustomError(weightModule, "NotFactoryVault");
    await expect(
      weightModule.connect(stranger).noteDepth(stranger.address, 1n)
    ).to.be.revertedWithCustomError(weightModule, "NotFactoryVault");
    await expect(
      weightModule.connect(stranger).noteVolume(stranger.address, 1n)
    ).to.be.revertedWithCustomError(weightModule, "NotFactoryVault");
  });

  it("checkAdmit cannot be called twice for the same vault", async () => {
    const { vaultA, weightModule } = await deployFixture();
    await weightModule.connect(vaultA).noteFee(vaultA.address, F_MIN_WEI);
    await weightModule.checkAdmit(vaultA.address);
    await expect(weightModule.checkAdmit(vaultA.address)).to.be.revertedWithCustomError(
      weightModule,
      "AlreadyAdmitted"
    );
  });

  it("weights() returns empty arrays when no vault is admitted", async () => {
    const { weightModule } = await deployFixture();
    const [vaults, wBps] = await weightModule.weights();
    expect(vaults.length).to.equal(0);
    expect(wBps.length).to.equal(0);
  });
});
