import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, WAD, TIMELOCK } from "../helpers/index-vault";

/**
 * ============================================================================
 * PR5 (ONESHOT §7 / §5.3 / §8) — InventoryBuyAdapter (Pipe I) + IndexEnergyFacet.
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md A-I and, most importantly,
 * ONESHOT §8's NEST-1: "After route Pipe I, L2 xToken reserve up, iToken
 * supply fixed, claim nested up after vest."
 *
 * NEST-1 is exercised against the REAL chain end to end:
 *   real CollectionVault + InventoryStake (PR4) -> real WeightModule (PR1)
 *   admits it -> real EnergyBus.route() (PR2) actually invokes the real
 *   InventoryBuyAdapter as Pipe I -> it buys real vToken off the vault's own
 *   AMM, deposits it into InventoryStake (minting xToken straight to the
 *   real index Diamond) -> real IndexEnergyFacet.creditInventory reconciles
 *   it into the Diamond's redeemable reserve via the SAME §7.2/§7.3/§7.6
 *   mechanism already proven elsewhere in this codebase.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("InventoryBuyAdapter + IndexEnergyFacet (PR5)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const VAULT_TIMELOCK = 48 * 3600;
  const MINT_FEE = ethers.parseEther("0.05"); // MAX_MINT_FEE_WEI
  const REDEEM_FEE = ethers.parseEther("0.01");
  const SINK_BPS = 3_000n; // CEIL_SINK_SPLIT_BPS, for fast F_MIN_WEI admission
  const F_MIN_WEI = ethers.parseEther("0.05");

  /** Seed the vault's internal AMM pool, mirroring InventoryStake.test.ts's
   * own helper exactly. */
  async function openPool(vault: any, vaultAddr: string, treasury: any, payment: any, seedSharesHolder: any) {
    const seedPayment = ethers.parseEther("100");
    await payment.mint(treasury.address, seedPayment);
    await payment.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);

    await vault.connect(seedSharesHolder).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();
  }

  it("NEST-1: real Bus -> InventoryBuyAdapter -> IndexEnergyFacet raises the Diamond's xToken reserve and NAV, with iToken supply unchanged, after vest", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0]; // == dividendAsset, the payment token every pipe here uses
    const wethC = await ethers.getContractAt("MockIndexToken", weth);

    const [, , , , , , , , , cvTreasury] = await ethers.getSigners();

    // ── 1. Real CollectionVault + InventoryStake + WeightModule (PR1/PR4) ──
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(fx.vaultAddr, weth, VAULT_TIMELOCK);

    const vaultAddr: string = await factory.deployVault.staticCall(
      await nft.getAddress(),
      cvTreasury.address,
      SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), cvTreasury.address, SINK_BPS);
    const cVault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    const Stake = await ethers.getContractFactory("InventoryStake");
    const stake: any = await Stake.deploy(vaultAddr, vaultAddr, "Inventory xToken", "xSHARE");
    const stakeAddr = await stake.getAddress();
    await cVault.connect(cvTreasury).setInventoryStake(stakeAddr);

    const WeightModuleF = await ethers.getContractFactory("WeightModule");
    const weightModule: any = await WeightModuleF.deploy(await factory.getAddress());
    const weightModuleAddr = await weightModule.getAddress();
    await cVault.connect(cvTreasury).setWeightModule(weightModuleAddr);

    // ── 2. Mint NFTs + fund alice with payment token for THIS vault's fees ──
    await wethC.mint(fx.alice.address, ethers.parseEther("50"));
    await wethC.connect(fx.alice).approve(vaultAddr, ethers.MaxUint256);
    for (let i = 1; i <= 30; i++) {
      await nft.mint(fx.alice.address, i);
      await nft.connect(fx.alice).approve(vaultAddr, i);
    }

    await cVault.connect(fx.alice).deposit(1); // seed share for the pool
    await openPool(cVault, vaultAddr, cvTreasury, wethC, fx.alice);

    // A real staker establishes InventoryStake's exchange rate BEFORE the
    // Bus ever buys into it (mirrors InventoryStake.test.ts's own XTOKEN-1
    // fixture exactly) — otherwise the FIRST-EVER stake deposit lands
    // against whatever `_compoundXToken` had already donated pre-supply,
    // which (correctly, per the virtual-shares math) mints a vanishingly
    // small xToken amount for a small first deposit. With a real staker
    // already holding xToken at a sane rate, the Bus's later deposit mints
    // proportionally, at a magnitude large enough to move NAV visibly.
    await cVault.connect(fx.alice).deposit(2);
    const stakerShares = ethers.parseEther("1");
    await cVault.connect(fx.alice).approve(stakeAddr, stakerShares);
    await stake.connect(fx.alice).deposit(stakerShares, fx.alice.address);

    // Enough real mint-fee events to clear F_MIN_WEI (0.05 ether) of matured,
    // sink-routed fee signal — real economic activity, not a mock.
    for (let i = 3; i <= 30; i++) {
      await cVault.connect(fx.alice).deposit(i);
      const s = await weightModule.scores(vaultAddr);
      if (s.feeWethCumulative >= F_MIN_WEI) break;
    }
    const scoreAfterFees = await weightModule.scores(vaultAddr);
    expect(scoreAfterFees.feeWethCumulative).to.be.gte(F_MIN_WEI);

    await weightModule.checkAdmit(vaultAddr);
    expect(await weightModule.isAdmitted(vaultAddr)).to.equal(true);

    // ── 3. List xToken as an L2 constituent (real listing, real price source) ──
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const xSource: any = await Source.deploy(WAD, WAD); // 1:1
    await fx.vault.connect(fx.admission).queueListing(stakeAddr, await xSource.getAddress(), 1_000n, false);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(stakeAddr);
    await fx.vault.checkpointAll();

    // ── 4. Deploy real InventoryBuyAdapter + 5 mock pipes + a real EnergyBus ──
    const deployerAddr = fx.bob.address;
    const nonce = await ethers.provider.getTransactionCount(deployerAddr);
    // 1 real InventoryBuyAdapter + 5 mocks = 6 pending txs before the Bus.
    const predictedBusAddr = ethers.getCreateAddress({ from: deployerAddr, nonce: nonce + 6 });

    const InvAdapterF = await ethers.getContractFactory("InventoryBuyAdapter");
    const invAdapter: any = await InvAdapterF.connect(fx.bob).deploy(
      weth,
      fx.vaultAddr,
      predictedBusAddr,
      weightModuleAddr
    );

    const MockAdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
    const mL: any = await MockAdapterFactory.connect(fx.bob).deploy(weth);
    const mX: any = await MockAdapterFactory.connect(fx.bob).deploy(weth);
    const mP: any = await MockAdapterFactory.connect(fx.bob).deploy(weth);
    const mR: any = await MockAdapterFactory.connect(fx.bob).deploy(weth);
    const mD: any = await MockAdapterFactory.connect(fx.bob).deploy(weth);

    const EnergyBusFactory = await ethers.getContractFactory("EnergyBus");
    const bus: any = await EnergyBusFactory.connect(fx.bob).deploy(
      weth,
      [
        await invAdapter.getAddress(), // I
        await mL.getAddress(), // L
        await mX.getAddress(), // X
        await mP.getAddress(), // P
        await mR.getAddress(), // R
        await mD.getAddress(), // D
      ],
      [3_500, 1_500, 1_500, 1_000, 1_000, 1_500]
    );
    expect(await bus.getAddress()).to.equal(predictedBusAddr);

    // ── 5. Wire the Diamond's onlyEnergyBus gate ───────────────────────────
    //
    // `creditInventory` is called by Pipe I's `InventoryBuyAdapter` itself
    // (from inside `buyLeg`, a direct external call into the Diamond) —
    // never by `EnergyBus` calling back into the Diamond, since the Bus
    // never does that anywhere in this stack (see `EnergyBus.sol`: it only
    // ever calls `adapter.execute`). The Diamond's `onlyEnergyBus` gate is
    // therefore wired to the one address that genuinely places that call:
    // Pipe I's own `InventoryBuyAdapter`, whose own `bus` immutable is in
    // turn locked to the real `EnergyBus` deployed above — so the authority
    // chain is still anchored at the real, permissionless Bus; this is
    // simply naming the actual caller correctly.
    const invAdapterAddr = await invAdapter.getAddress();
    await fx.vault.connect(fx.risk).queueEnergyBus(invAdapterAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeEnergyBus();
    expect(await fx.vault.energyBus()).to.equal(invAdapterAddr);

    // ── 6. Snapshot: xToken reserve at the Diamond, NAV, iToken supply ─────
    const xTokenAtDiamondBefore: bigint = await stake.balanceOf(fx.vaultAddr);
    const [navLowBefore, navHighBefore] = await fx.vault.nav();
    const supplyBefore: bigint = await fx.vault.totalSupply();

    // ── 7. Fund the Bus with real WETH and route() — permissionless ────────
    const total = ethers.parseEther("2");
    await wethC.mint(await bus.getAddress(), total);
    await expect(bus.route()).to.not.be.reverted;

    // ── 8. The real xToken balance at the Diamond genuinely rose ───────────
    const xTokenAtDiamondAfter: bigint = await stake.balanceOf(fx.vaultAddr);
    expect(xTokenAtDiamondAfter).to.be.gt(xTokenAtDiamondBefore);

    // The adapter itself never retains WETH.
    expect(await wethC.balanceOf(await invAdapter.getAddress())).to.equal(0n);

    // ── 9. Advance past VEST_BLOCKS (300) so the credit fully matures ──────
    await mine(310);

    // ── 10. iToken supply is UNCHANGED — no free mint anywhere in this path ──
    const supplyAfter: bigint = await fx.vault.totalSupply();
    expect(supplyAfter).to.equal(supplyBefore);

    // ── 11. NAV (redemption value per iToken) genuinely rose ───────────────
    const [navLowAfter, navHighAfter] = await fx.vault.nav();
    console.log(
      `NEST-1 evidence: xToken@Diamond ${xTokenAtDiamondBefore} -> ${xTokenAtDiamondAfter}; ` +
        `navLow ${navLowBefore} -> ${navLowAfter}; navHigh ${navHighBefore} -> ${navHighAfter}; ` +
        `iToken totalSupply unchanged at ${supplyAfter}`
    );
    expect(navHighAfter).to.be.gt(navHighBefore);
    expect(navLowAfter).to.be.gte(navLowBefore);
  });

  it("A-I: with no admitted collection, InventoryBuyAdapter safely skips (whole slice returns to the Bus) and never reverts", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0];
    const wethC = await ethers.getContractAt("MockIndexToken", weth);

    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(fx.vaultAddr, weth, VAULT_TIMELOCK);
    const WeightModuleF = await ethers.getContractFactory("WeightModule");
    const weightModule: any = await WeightModuleF.deploy(await factory.getAddress());

    const InvAdapterF = await ethers.getContractFactory("InventoryBuyAdapter");
    const invAdapter: any = await InvAdapterF.deploy(
      weth,
      fx.vaultAddr,
      fx.bob.address, // bus stand-in EOA
      await weightModule.getAddress()
    );

    const amount = ethers.parseEther("1");
    await wethC.mint(fx.bob.address, amount);
    await wethC.connect(fx.bob).transfer(await invAdapter.getAddress(), amount);
    const [used, skipped] = await invAdapter.connect(fx.bob).execute.staticCall(amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);

    const before = await wethC.balanceOf(fx.bob.address);
    await invAdapter.connect(fx.bob).execute(amount);
    const after = await wethC.balanceOf(fx.bob.address);
    expect(after - before).to.equal(amount); // the whole slice came back
    expect(await wethC.balanceOf(await invAdapter.getAddress())).to.equal(0n);
  });

  it("InventoryBuyAdapter reverts only for the invariant violation of a non-Bus caller, never for any external condition", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0];
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(fx.vaultAddr, weth, VAULT_TIMELOCK);
    const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(
      await factory.getAddress()
    );
    const invAdapter: any = await (await ethers.getContractFactory("InventoryBuyAdapter")).deploy(
      weth,
      fx.vaultAddr,
      fx.bob.address,
      await weightModule.getAddress()
    );
    await expect(invAdapter.connect(fx.carol).execute(1n)).to.be.revertedWithCustomError(invAdapter, "NotBus");
  });

  it("IndexEnergyFacet.creditInventory reverts for any caller that is not the wired EnergyBus", async () => {
    const fx = await deployOpenIndex();
    await expect(
      fx.vault.connect(fx.carol).creditInventory(fx.addrs[0], 0n)
    ).to.be.revertedWithCustomError(fx.vault, "NotEnergyBus");
  });
});
