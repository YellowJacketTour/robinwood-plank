import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";
import { deployIndexVault, defaultParams, paramsTuple, WAD, TIMELOCK, maxIn } from "../helpers/index-vault.js";

/**
 * ============================================================================
 * PR5 (ONESHOT §5.3, §7 PR5, §8 NEST-1) — InventoryBuyAdapter (Pipe I) +
 * IndexEnergyFacet, end to end, under the CORRECTED single-share-atom model
 * (DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2/§4/§10 — supersedes the
 * PR4/PR5-original dual vToken+xToken design).
 *
 * "Do not merge PR5 without nested compound invariant green" — ONESHOT §5.3.
 *
 * This is the LOAD-BEARING NEST-1 test: fees are deposited into a REAL
 * `CollectionVault`, routed through a REAL `EnergyBus` (with a REAL
 * `InventoryBuyAdapter` on Pipe I — the other five pipes use
 * `MockEnergyAdapter` in SPEND_ALL mode, exactly as `EnergyBus.test.ts`
 * itself already does, since this suite is about Pipe I's INTEGRATION, not
 * re-proving the Bus's own six-way split math), credited into a REAL
 * Diamond via `IndexEnergyFacet.creditInventory`, vested past
 * `STREAM_VEST_BLOCKS`, and the index coin's redemption value per share is
 * asserted to have genuinely risen — with ZERO new index-coin mints between
 * the "before" and "after" snapshots.
 *
 * Nothing here is mocked at the layer under test:
 *   - `CollectionVault` is the real factory-deployed contract (fees, its own
 *     constant-product AMM, `XTOKEN_COMPOUND_BPS` carve-out DONATED DIRECTLY
 *     into its own `paymentReserve` — no separate stake contract anymore —
 *     `WeightModule` signal pushes).
 *   - `WeightModule` is the real multi-signal admit/weight module.
 *   - `EnergyBus` is the real 6-pipe splitter.
 *   - `InventoryBuyAdapter` is the real Pipe I adapter under test, buying the
 *     vault's own share `S` DIRECTLY (no xToken wrap step) and crediting it
 *     into the index via `IndexEnergyFacet.creditInventory(vault, ...)`.
 *   - The index Diamond is the real, finalized, cut facet set (including the
 *     new `IndexEnergyFacet`), via `deployIndexVault`, with the vault's own
 *     share `S` (i.e. `vaultAddr`) as its ONE constituent.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("InventoryBuyAdapter + IndexEnergyFacet — NEST-1 (PR5, corrected single-share-atom model)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const MINT_REDEEM_SINK_BPS = 3_000; // CEIL_SINK_SPLIT_BPS — maximizes Stream A's fee-to-sink signal per cycle
  const INV_BPS = 3_500n;
  const CLP_BPS = 1_500n;
  const IDX_BURN_BPS = 1_500n;
  const PLANK_BURN_BPS = 1_000n;
  const PLANK_LP_BPS = 1_000n;
  const DIV_BPS = 1_500n;
  const STREAM_VEST_BLOCKS = 300;

  async function deployFixture() {
    const [deployer, roleAdmin, seeder, alice, bob, admission, risk, allocation, sinkStandIn, treasury] =
      await ethers.getSigners();

    // ── WETH: the ONE payment token every layer of this stack shares ────────
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    // ── Factory + one CollectionVault ────────────────────────────────────────
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sinkStandIn.address, wethAddr, TIMELOCK);
    const factoryAddr = await factory.getAddress();

    const vaultAddr = await factory.deployVault.staticCall(
      await nft.getAddress(),
      treasury.address,
      MINT_REDEEM_SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), treasury.address, MINT_REDEEM_SINK_BPS);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    // ── WeightModule, wired to the vault. NO InventoryStake anymore — S is
    //    the vault's own ERC20; there is nothing else to deploy or wire. ────
    const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(factoryAddr);
    const weightModuleAddr = await weightModule.getAddress();
    await vault.connect(treasury).setWeightModule(weightModuleAddr);

    // ── Fund alice with WETH + two NFTs (one seeds the pool, one cycles) ────
    await weth.mint(alice.address, ethers.parseEther("100"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await nft.mint(alice.address, 1);
    await nft.mint(alice.address, 2);
    await nft.connect(alice).approve(vaultAddr, 1);
    await nft.connect(alice).approve(vaultAddr, 2);

    return {
      deployer,
      roleAdmin,
      seeder,
      alice,
      bob,
      admission,
      risk,
      allocation,
      treasury,
      weth,
      wethAddr,
      nft,
      factory,
      vault,
      vaultAddr,
      weightModule,
      weightModuleAddr,
    };
  }

  it("NEST-1: fee -> Bus -> InventoryBuyAdapter -> IndexEnergyFacet.creditInventory -> vested NAV rise, zero new mints, zero staking step", async function () {
    this.timeout(180_000);
    const {
      deployer,
      roleAdmin,
      seeder,
      alice,
      bob,
      admission,
      risk,
      allocation,
      treasury,
      weth,
      wethAddr,
      nft,
      vault,
      vaultAddr,
      weightModule,
      weightModuleAddr,
    } = await deployFixture();

    // ── 1. Open the vault's own AMM pool (needed for both buyShares later
    //    and for XTOKEN_COMPOUND_BPS's own fee-compounding to actually
    //    fire, rather than falling back to accruedFees). ────────────────────
    await vault.connect(alice).deposit(1); // mints 1e18 S to alice
    const seedPayment = ethers.parseEther("2");
    await weth.mint(treasury.address, seedPayment);
    await weth.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();

    // ── 2. Cycle deposit/redeem on NFT #2 enough times to cross
    //    WeightModule's F_MIN_WEI admit floor (0.05 ETH of cumulative sink
    //    fee) via real Stream A fee events. Every cycle ALSO compounds
    //    XTOKEN_COMPOUND_BPS of its fee DIRECTLY into `paymentReserve` — this
    //    is the "L1 fee -> S's own backing up" half of the corrected §2/§4
    //    nested compound physics, exercised for real before Pipe I ever
    //    runs. ──────────────────────────────────────────────────────────────
    const rateBeforeCompound: bigint = await vault.convertToAssets(WAD);

    let cumulativeSink = 0n;
    const F_MIN_WEI = ethers.parseEther("0.05");
    let cycles = 0;
    while (cumulativeSink < F_MIN_WEI && cycles < 60) {
      await nft.connect(alice).approve(vaultAddr, 2);
      await expect(vault.connect(alice).deposit(2)).to.emit(vault, "XTokenCompounded");
      await vault.connect(alice).redeem(2);
      cycles += 1;
      cumulativeSink = await weightModule.scores(vaultAddr).then((s: any) => s.feeWethCumulative);
    }
    expect(cumulativeSink).to.be.gte(F_MIN_WEI);

    // Real S/paymentReserve backing genuinely rose from real fee compounding
    // — re-confirmed here as the PRECONDITION NEST-1 builds on. Unlike the
    // superseded xToken model, THIS rate rise benefits EVERY S holder
    // automatically (alice never staked anything, never called a second
    // contract).
    const rateAfterCompound: bigint = await vault.convertToAssets(WAD);
    expect(rateAfterCompound).to.be.gt(rateBeforeCompound);

    // ── 3. Admit the vault into WeightModule (permissionless). ───────────────
    await weightModule.checkAdmit(vaultAddr);
    const { vaults: wVaults, wBps } = await weightModule.weights();
    expect(wVaults).to.deep.equal([vaultAddr]);
    expect(wBps[0]).to.be.gt(0n);

    // ── 4. Deploy the index Diamond, with the vault's own share `S` (i.e.
    //    `vaultAddr` itself — `CollectionVault` IS the ERC20) as its ONE
    //    constituent (and dividend asset). No xToken exists to wire. ────────
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const source: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    const { vault: index, vaultAddr: indexAddr } = await deployIndexVault({
      name: "AXIOM-1 Test Index",
      symbol: "tIDX",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: vaultAddr,
    });

    await index.connect(seeder).seedConstituent(vaultAddr, await source.getAddress(), 10_000);

    // Seed a nonzero S reserve so `openIndex` can proceed (needs a positive
    // reserve + an observation, both of which `seedDeposit` gives). Alice
    // deposits NFT #2 one more time (kept, not redeemed) to hold real S, and
    // hands a slice to the seeder — DIRECTLY, no staking step in between.
    await nft.connect(alice).approve(vaultAddr, 2);
    await vault.connect(alice).deposit(2);
    const aliceSBal: bigint = await vault.balanceOf(alice.address);
    expect(aliceSBal).to.be.gt(0n);

    const seedSAmount = aliceSBal / 4n;
    await vault.connect(alice).transfer(seeder.address, seedSAmount);
    await vault.connect(seeder).approve(indexAddr, seedSAmount);
    await index.connect(seeder).seedDeposit(vaultAddr, seedSAmount);
    await index.connect(seeder).openIndex(1_000n * WAD);

    // ── 5. Mint a real IDX-coin holder BEFORE any Pipe-I credit — this is
    //    the position whose redemption value NEST-1 measures rising, with
    //    NO further mint between the "before" and "after" snapshots. ───────
    const remainingSBal: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).approve(indexAddr, remainingSBal);
    const mintShares = 10n * WAD;
    await index.connect(alice).mintProRata(mintShares, maxIn(1));

    const supplyBefore: bigint = await index.totalSupply();
    const [, amountsBefore] = await index.previewRedeemProRata(WAD);
    const perShareBefore: bigint = amountsBefore[0];
    expect(perShareBefore).to.be.gt(0n);

    // ── 6. Wire IndexEnergyFacet.energyBus via the SAME timelock every
    //    other risk-surface setter uses. ─────────────────────────────────────
    // (EnergyBus is deployed in step 7, its address predicted here so
    //  InventoryBuyAdapter's immutable `bus` can be set correctly.)

    // ── 7. Deploy the real EnergyBus with a REAL InventoryBuyAdapter on
    //    Pipe I and MockEnergyAdapter (SPEND_ALL) on the other five pipes —
    //    same pattern `EnergyBus.test.ts` itself uses for pipes not under
    //    test. `InventoryBuyAdapter`'s immutable `bus` must equal the
    //    EnergyBus's own address, so it is deployed one nonce before the Bus
    //    at a PREDICTED create address. ───────────────────────────────────────
    const MockAdapter = await ethers.getContractFactory("MockEnergyAdapter");
    const clp: any = await MockAdapter.deploy(wethAddr);
    const idxBurn: any = await MockAdapter.deploy(wethAddr);
    const plankBurn: any = await MockAdapter.deploy(wethAddr);
    const plankLp: any = await MockAdapter.deploy(wethAddr);
    const div: any = await MockAdapter.deploy(wethAddr);
    // All default to Mode.SPEND_ALL (enum index 0) — nothing further to set.

    const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
    const predictedBus = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 });

    const InvAdapter = await ethers.getContractFactory("InventoryBuyAdapter");
    const inv: any = await InvAdapter.connect(deployer).deploy(wethAddr, indexAddr, predictedBus, weightModuleAddr);
    const invAddr = await inv.getAddress();

    const bus: any = await (
      await ethers.getContractFactory("EnergyBus")
    )
      .connect(deployer)
      .deploy(
        wethAddr,
        [
          invAddr,
          await clp.getAddress(),
          await idxBurn.getAddress(),
          await plankBurn.getAddress(),
          await plankLp.getAddress(),
          await div.getAddress(),
        ],
        [INV_BPS, CLP_BPS, IDX_BURN_BPS, PLANK_BURN_BPS, PLANK_LP_BPS, DIV_BPS]
      );
    const busAddr = await bus.getAddress();
    expect(busAddr).to.equal(predictedBus);
    expect(await inv.bus()).to.equal(busAddr);

    // Now wire the index's `onlyEnergyBus` gate to this real Bus.
    await index.connect(risk).queueEnergyBus(busAddr);
    await time.increase(TIMELOCK + 1);
    await index.executeEnergyBus();
    expect(await index.energyBus()).to.equal(busAddr);

    // ── 8. Fund the Bus with WETH (a real fee event, standing in for the
    //    aggregate of many collections' Stream A/B sink pushes) and route. ──
    const feeWethIn = ethers.parseEther("1");
    await weth.mint(busAddr, feeWethIn);

    const sReserveAtIndexBefore: bigint = await vault.balanceOf(indexAddr);

    await expect(bus.route()).to.not.be.revert(ethers);

    // Pipe I bought vault S directly with its slice of the routed WETH,
    // transferred it STRAIGHT to the index Diamond (no intermediate wrap),
    // and `creditInventory` moved that fresh S balance into `c.reserve`
    // (vested) — ALL WITHOUT touching `ERC20Storage.totalSupply` (the index
    // coin's own supply), which is the crux of "no free iToken from fees"
    // (ONESHOT §6 rule 4).
    expect(await index.totalSupply()).to.equal(supplyBefore);

    // The S Pipe I bought is real, observed inventory that the Diamond did
    // not have before — either credited already (best case) or at least
    // sitting at the Diamond's own balance ready for a permissionless
    // reconcile (defensive case covering a same-call credit-race edge).
    const sBalAtIndex: bigint = await vault.balanceOf(indexAddr);
    expect(sBalAtIndex).to.be.gt(sReserveAtIndexBefore);

    const reconcileNeeded: bigint = await index.reconcile.staticCall(vaultAddr);
    if (reconcileNeeded > 0n) {
      // Not yet reconciled this call (defensive path) — sweep it in
      // explicitly via the same permissionless backstop §7.2 already ships,
      // so the "genuinely credited" assertion below is unconditionally true
      // regardless of which of `creditInventory`'s two landing paths fired.
      await index.reconcile(vaultAddr);
    }

    // ── 9. Advance past the vesting window (`_addReserveVest`'s
    //    `STREAM_VEST_BLOCKS`) so the freshly-credited S is no longer
    //    displaced from `redeemProRata`'s net-of-vest sizing. ────────────────
    for (let i = 0; i < STREAM_VEST_BLOCKS + 2; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    // ── 10. THE LOAD-BEARING ASSERTIONS ──────────────────────────────────────
    const supplyAfter: bigint = await index.totalSupply();
    const [, amountsAfter] = await index.previewRedeemProRata(WAD);
    const perShareAfter: bigint = amountsAfter[0];

    // ZERO new index-coin mints between the two snapshots.
    expect(supplyAfter).to.equal(supplyBefore);

    // The index coin's redemption value per share has GENUINELY risen —
    // the nested compound this whole PR exists to prove, now under the
    // corrected single-share-atom model: real vault fee -> S's own backing
    // rises for EVERY S holder (no staking step) -> the real Bus buys more S
    // into the index -> real Diamond credit, vested, now redeemable by every
    // existing holder pro rata, with no one having minted a single
    // additional share to capture it.
    expect(perShareAfter).to.be.gt(perShareBefore);
  });
});
