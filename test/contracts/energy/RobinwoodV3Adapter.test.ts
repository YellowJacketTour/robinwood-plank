import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine } from "../helpers/network-helpers.js";
import { deployBeaconMock } from "../helpers/beacon.js";

/**
 * ============================================================================
 * RobinwoodV3Adapter — wires the ALREADY-LIVE MarketplankVaultV3 into the
 * Honest Index's WeightModule as a real, honestly-scored constituent, with
 * ZERO changes to V3 itself and zero user migration.
 *
 * Covers: buyShares/sellShares round-trip against V3's REAL AMM, depth
 * (not fee) driving the maturity ramp and nonzero weight, F/P/V staying
 * genuinely zero (no fabricated activity signal), and the pre-existing
 * `RobinwoodVaultMustBeGated` guard correctly still refusing this adapter as
 * the floor beneficiary (V3 has no eligibility gating — see the adapter's
 * own header doc).
 * ============================================================================
 */
describe("RobinwoodV3Adapter — wiring an already-live legacy vault in read/write, zero migration", () => {
  const SHARE_UNIT = 10n ** 18n;
  const MINT_FEE = ethers.parseEther("0.001");
  const REDEEM_FEE = ethers.parseEther("0.001");
  const PREMIUM = ethers.parseEther("0.002");
  const SWAP_BPS = 30n;
  const DEPTH_BUCKETS = 6n;
  const DEPTH_BUCKET_BLOCKS = 1_200n;

  async function fixture() {
    const [deployer, treasury, alice, keeper] = await ethers.getSigners();

    // ── Deploy V3 exactly as VaultV3.audit.test.ts does — live, seeded, open.
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const VaultV3 = await ethers.getContractFactory("MarketplankVaultV3");
    const v3: any = await VaultV3.deploy(
      await nft.getAddress(),
      "vROBIN3",
      "vROBIN3",
      MINT_FEE,
      REDEEM_FEE,
      PREMIUM,
      SWAP_BPS,
      treasury.address,
      await beacon.getAddress()
    );
    const v3Addr = await v3.getAddress();

    for (let id = 1; id <= 8; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(v3Addr, id);
      await v3.connect(alice).deposit(id, { value: MINT_FEE });
    }
    await v3.connect(alice).transfer(treasury.address, SHARE_UNIT * 3n);
    await v3.connect(treasury).seedShares(SHARE_UNIT * 3n, { value: ethers.parseEther("4") });
    await v3.connect(treasury).openPool();

    // ── WETH + WeightModule + factory mock (isolated, same shape the
    // reform-fixture tests already use).
    const weth: any = await (await ethers.getContractFactory("CanonicalWeth9")).deploy();
    const factory: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
    const wm: any = await (await ethers.getContractFactory("WeightModule")).deploy(await factory.getAddress());

    const Adapter = await ethers.getContractFactory("RobinwoodV3Adapter");
    const adapter: any = await Adapter.deploy(v3Addr, await weth.getAddress(), await wm.getAddress());
    const adapterAddr = await adapter.getAddress();

    return { deployer, treasury, alice, keeper, nft, beacon, v3, v3Addr, weth, factory, wm, adapter, adapterAddr };
  }

  it("admitExternalVault admits immediately, bypassing the F_MIN_WEI fee floor (deliberate admin gate already vets it)", async () => {
    const { deployer, wm, adapterAddr } = await fixture();
    await expect(wm.connect(deployer).admitExternalVault(adapterAddr))
      .to.emit(wm, "Admitted")
      .withArgs(adapterAddr);
    expect(await wm.isAdmitted(adapterAddr)).to.equal(true);
    expect(await wm.externalVaultAllowed(adapterAddr)).to.equal(true);
    // Admitting twice reverts — same one-way, no-revoke shape as a factory deploy.
    await expect(wm.connect(deployer).admitExternalVault(adapterAddr)).to.be.revertedWithCustomError(
      wm,
      "AlreadyAdmitted"
    );
  });

  it("only robinwoodSetter may admit an external vault", async () => {
    const { alice, wm, adapterAddr } = await fixture();
    await expect(wm.connect(alice).admitExternalVault(adapterAddr)).to.be.revertedWithCustomError(
      wm,
      "NotRobinwoodSetter"
    );
  });

  it("buyShares pulls WETH, buys REAL V3 shares, and mints an equal wrapped claim — every wei accounted", async () => {
    const { keeper, weth, v3, v3Addr, adapter, adapterAddr } = await fixture();

    const budget = ethers.parseEther("1");
    await weth.connect(keeper).deposit({ value: budget });
    await weth.connect(keeper).approve(adapterAddr, budget);

    const quoted: bigint = await adapter.quoteBuyShares(budget);
    expect(quoted).to.be.gt(0n);

    const v3SharesBefore: bigint = await v3.balanceOf(adapterAddr);
    await expect(adapter.connect(keeper).buyShares(budget, quoted))
      .to.emit(adapter, "Transfer")
      .withArgs(ethers.ZeroAddress, keeper.address, quoted);

    // Real V3 shares landed in the adapter's custody...
    expect(await v3.balanceOf(adapterAddr)).to.equal(v3SharesBefore + quoted);
    // ...and the caller holds an exactly equal wrapped claim.
    expect(await adapter.balanceOf(keeper.address)).to.equal(quoted);
    expect(await adapter.totalSupply()).to.equal(quoted);
    // No WETH stranded in the adapter.
    expect(await weth.balanceOf(adapterAddr)).to.equal(0n);
  });

  it("sellShares burns the wrapped claim and returns real WETH, symmetrically", async () => {
    const { keeper, weth, adapter, adapterAddr } = await fixture();

    const budget = ethers.parseEther("1");
    await weth.connect(keeper).deposit({ value: budget });
    await weth.connect(keeper).approve(adapterAddr, budget);
    const minted: bigint = await adapter.quoteBuyShares(budget);
    await adapter.connect(keeper).buyShares(budget, minted);

    const quotedOut: bigint = await adapter.quoteSellShares(minted);
    expect(quotedOut).to.be.gt(0n);

    const wethBefore: bigint = await weth.balanceOf(keeper.address);
    await adapter.connect(keeper).sellShares(minted, quotedOut);
    expect(await weth.balanceOf(keeper.address)).to.equal(wethBefore + quotedOut);
    expect(await adapter.balanceOf(keeper.address)).to.equal(0n);
    expect(await adapter.totalSupply()).to.equal(0n);
  });

  it("depth alone — with ZERO fee activity ever — earns real, nonzero WeightModule score, closing the 'fee-less vault can never earn weight' gap", async () => {
    const { deployer, keeper, weth, wm, adapter, adapterAddr } = await fixture();

    await wm.connect(deployer).admitExternalVault(adapterAddr);

    // Deploy real capital so the adapter has real V3 depth to report.
    const budget = ethers.parseEther("2");
    await weth.connect(keeper).deposit({ value: budget });
    await weth.connect(keeper).approve(adapterAddr, budget);
    const minted: bigint = await adapter.quoteBuyShares(budget);
    await adapter.connect(keeper).buyShares(budget, minted);

    // Hold real depth through the whole window, exactly like
    // WeightModule.reform.test.ts's own `holdDepth` helper — poke every
    // bucket, mine through it.
    for (let i = 0n; i < DEPTH_BUCKETS + 1n; i++) {
      await adapter.pokeDepth();
      await mine(DEPTH_BUCKET_BLOCKS);
    }
    await adapter.pokeDepth();

    const score: bigint = await wm.score(adapterAddr);
    expect(score).to.be.gt(0n);

    // F/P/V are all genuinely zero — this adapter never called noteFee,
    // noteMintPressure, or noteVolume. The score above is 100% depth-derived.
    const st = await wm.scores(adapterAddr);
    expect(st.feeWethCumulative).to.equal(0n);
    expect(st.mintPressureCumulative).to.equal(0n);
    expect(st.volumeEwma).to.equal(0n);
    expect(st.firstFeeBlock).to.equal(0n);

    // And it shows up in the real allocation.
    const [vaults, wBps] = await wm.weights();
    const idx = vaults.indexOf(adapterAddr);
    expect(idx).to.be.gte(0);
    expect(wBps[idx]).to.be.gt(0n);
  });

  it("setRobinwoodVault still correctly REFUSES this adapter — V3 has no eligibility gating, and the adapter reports that honestly (eligibilityRoot() == 0)", async () => {
    const { deployer, wm, adapter, adapterAddr } = await fixture();
    expect(await adapter.eligibilityRoot()).to.equal(ethers.ZeroHash);
    await expect(wm.connect(deployer).setRobinwoodVault(adapterAddr)).to.be.revertedWithCustomError(
      wm,
      "RobinwoodVaultMustBeGated"
    );
  });
});
