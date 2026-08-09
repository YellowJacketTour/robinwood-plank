import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexVault, defaultParams, paramsTuple, WAD, TIMELOCK, maxIn } from "../helpers/index-vault";

/**
 * ============================================================================
 * PR8 (ONESHOT §7, §8 INT-1..3) — Factory sink -> Bus, real end-to-end
 * deposit -> route.
 *
 * WIRING CHECK, STATED PLAINLY (this PR's own brief). `CollectionVaultFactory`
 * already accepts an arbitrary `upstreamSink_` address at construction
 * (`CollectionVaultFactory.sol:65-70`) and every deployed `CollectionVault`
 * routes its sink cut with a PLAIN `IERC20.transfer(upstreamSink, sinkCut)`
 * (`CollectionVault.sol:310,397,423`) — a completely generic ERC-20 push with
 * no interface expectation on the receiver whatsoever. `EnergyBus.route()` is
 * itself just a permissionless WETH-balance splitter
 * (`EnergyBus.sol:104-140`) with no inbound "deposit" function to call — WETH
 * simply needs to be at its address before `route()` runs. Those two facts
 * together mean a factory's `upstreamSink` CAN ALREADY be pointed directly at
 * a real `EnergyBus` instance with ZERO code changes to either contract; this
 * suite is the first place that wiring is actually exercised end-to-end
 * rather than asserted in prose. No `.sol` file in this repo was modified for
 * this PR.
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md / ONESHOT §8:
 *   - INT-1 "deposit NFT -> sink -> route | end-to-end inventory or div moves"
 *   - INT-2 "swap Stream B -> route | bus receives 50% fee side"
 *   - INT-3 "new vault admit -> appears in weights | autogenesis"
 *
 * REAL, NOT MOCKED, for every piece PR1-7 shipped:
 *   - `CollectionVaultFactory` + a real CREATE2-deployed `CollectionVault`,
 *     `upstreamSink` pointed at a real `EnergyBus` address (predicted via
 *     nonce, since the Bus's own adapter set needs the index Diamond and
 *     WeightModule to already exist — see the fixture below for the exact
 *     dependency order).
 *   - The real `WeightModule`, admitted permissionlessly via `checkAdmit`.
 *   - The real index Diamond (`IndexEnergyFacet`, `IndexCoreFacet`, etc.),
 *     with the vault's own share `S` as its one constituent.
 *   - Real `InventoryBuyAdapter` (Pipe I), `IdxBurnAdapter` (Pipe X),
 *     `PlankBurnAdapter` (Pipe P), `PlankLpRenounceAdapter` (Pipe R),
 *     `DividendAdapter` (Pipe D) — PR1-7's own shipped contracts, not
 *     `MockEnergyAdapter` stand-ins.
 *
 * ONE HONEST GAP, DISCLOSED RATHER THAN PAPERED OVER: Pipe L (`clpAdapter`,
 * "Collection LP renounce") has NO shipped adapter contract anywhere in this
 * repo as of this commit. `docs/DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-
 * MINT-2026-08-08.md` (git history `c879311`, "obsolete PR6 donation-only
 * files removed") confirms an earlier `CollectionLpRenounceAdapter.sol`
 * attempt was deliberately removed as obsolete and re-designed as the native
 * `CollectionVaultLP` mechanism instead — a DIFFERENT, already-shipped
 * mechanism (`CollectionVault.addLiquidity`/`removeLiquidity`, PR6's actual
 * final shape) that does not plug into `EnergyBus` as a pipe at all. Building
 * a brand-new real Pipe-L adapter is out of scope for an integration-proofing
 * PR (PR8/PR9 are explicitly "integration-proof stages over already-shipped
 * contracts, not new contract logic" per this PR's own brief) — so Pipe L
 * here uses `MockEnergyAdapter` in SPEND_ALL mode, exactly the way
 * `InventoryBuyAdapterNest.test.ts` (NEST-1, PR5) already does for every pipe
 * not under that suite's test. This is the SAME "5 real + 1 documented mock"
 * shape as every other suite in this repo that assembles a full Bus today;
 * "all 6 real adapters" cannot be literally true until a real Pipe L adapter
 * ships in a future PR — flagged here rather than silently worked around.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("CollectionVaultFactory sink -> real EnergyBus, e2e deposit -> route (PR8, INT-1..3)", () => {
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
    const [deployer, roleAdmin, seeder, alice, bob, admission, risk, allocation, governance, treasury, busDeployer] =
      await ethers.getSigners();

    // ── WETH: the ONE payment token every layer of this stack shares ──────
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    // ── Predict the EnergyBus address BEFORE the factory is deployed, so
    //    the factory's IMMUTABLE `upstreamSink` can be pointed directly at a
    //    real Bus rather than an EOA stand-in. `busDeployer` is a DEDICATED
    //    signer used for NOTHING ELSE anywhere in this fixture/test — not for
    //    the factory, not the vault, not the index diamond, not any actor
    //    action — so its nonce is exactly 0 right now and stays fully
    //    predictable regardless of how many transactions every OTHER signer
    //    sends later (deployIndexVault alone deploys ~18 facets on the
    //    default signer). It will deploy exactly 6 adapters, then the Bus,
    //    in that fixed order, later in this test — nonce 6 at Bus deploy
    //    time, known with certainty right now, before anything else exists. ─
    const predictedBus = ethers.getCreateAddress({ from: busDeployer.address, nonce: 6 });

    // ── Factory + one real CollectionVault, upstreamSink == predicted Bus ──
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();

    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(predictedBus, wethAddr, TIMELOCK);
    const factoryAddr = await factory.getAddress();

    const vaultAddr = await factory.deployVault.staticCall(
      await nft.getAddress(),
      treasury.address,
      MINT_REDEEM_SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), treasury.address, MINT_REDEEM_SINK_BPS);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    expect(await vault.upstreamSink()).to.equal(predictedBus);

    // ── WeightModule, wired to the vault ────────────────────────────────────
    const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(factoryAddr);
    const weightModuleAddr = await weightModule.getAddress();
    await vault.connect(treasury).setWeightModule(weightModuleAddr);

    // ── Fund alice with WETH + two NFTs (one seeds the pool, one cycles) ───
    await weth.mint(alice.address, ethers.parseEther("200"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await nft.mint(alice.address, 1);
    await nft.mint(alice.address, 2);
    await nft.connect(alice).approve(vaultAddr, 1);
    await nft.connect(alice).approve(vaultAddr, 2);

    return {
      deployer,
      busDeployer,
      roleAdmin,
      seeder,
      alice,
      bob,
      admission,
      risk,
      allocation,
      governance,
      treasury,
      weth,
      wethAddr,
      nft,
      factory,
      factoryAddr,
      vault,
      vaultAddr,
      weightModule,
      weightModuleAddr,
      predictedBus,
    };
  }

  it("INT-1/INT-2/INT-3: real vault fee activity reaches a real Bus at the factory's own upstreamSink, route() distributes across all 6 pipes (5 real + Pipe L documented mock), and the vault autogenesis-admits into weights", async function () {
    this.timeout(180_000);
    const {
      deployer,
      busDeployer,
      roleAdmin,
      seeder,
      alice,
      bob,
      admission,
      risk,
      allocation,
      governance,
      treasury,
      weth,
      wethAddr,
      nft,
      vault,
      vaultAddr,
      weightModule,
      weightModuleAddr,
      predictedBus,
    } = await deployFixture();

    // ── 1. Open the vault's own AMM pool ────────────────────────────────────
    await vault.connect(alice).deposit(1); // mints 1e18 S to alice — real Stream A fee event #1
    const seedPayment = ethers.parseEther("2");
    await weth.mint(treasury.address, seedPayment);
    await weth.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();

    // The mint above already pushed a real Stream A sink cut straight to
    // `predictedBus` via a plain ERC20 transfer — the Bus's own address has
    // no contract deployed there YET (it will, at the exact same address,
    // once `busDeployer`'s nonce reaches the predicted value below), but a
    // plain `IERC20.transfer` to an address with no code is a completely
    // ordinary, successful ERC-20 transfer (no receiver code is ever
    // invoked by `transfer`/`transferFrom`) — the WETH sits there, waiting,
    // exactly the same as it would at any EOA. This is INT-1's first half:
    // "deposit NFT -> sink" already genuinely happened.
    const preBusWeth: bigint = await weth.balanceOf(predictedBus);
    expect(preBusWeth).to.be.gt(0n);

    // ── 2. Cycle deposit/redeem on NFT #2 (more Stream A fee events) AND
    //    buyShares/sellShares (Stream B swap fee events) so INT-2's "swap
    //    Stream B -> route" has real swap-fee-derived WETH at the Bus too,
    //    on top of INT-1's mint/redeem fees. ─────────────────────────────────
    let cumulativeSink = 0n;
    const F_MIN_WEI = ethers.parseEther("0.05");
    let cycles = 0;
    while (cumulativeSink < F_MIN_WEI && cycles < 60) {
      await nft.connect(alice).approve(vaultAddr, 2);
      await vault.connect(alice).deposit(2);
      await vault.connect(alice).redeem(2);
      cycles += 1;
      cumulativeSink = await weightModule.scores(vaultAddr).then((s: any) => s.feeWethCumulative);
    }
    expect(cumulativeSink).to.be.gte(F_MIN_WEI);

    const busWethBeforeSwap: bigint = await weth.balanceOf(predictedBus);

    // A real Stream B swap: buy S with WETH, then sell some of it back —
    // both directions sink 50% of the swap fee (`SWAP_SINK_SPLIT_BPS`)
    // straight to `upstreamSink`, i.e. the Bus.
    await weth.mint(bob.address, ethers.parseEther("5"));
    await weth.connect(bob).approve(vaultAddr, ethers.MaxUint256);
    await expect(vault.connect(bob).buyShares(ethers.parseEther("2"), 0n)).to.emit(vault, "SweptToSink");
    const bobShares: bigint = await vault.balanceOf(bob.address);
    await vault.connect(bob).approve(vaultAddr, bobShares);
    await expect(vault.connect(bob).sellShares(bobShares / 2n, 0n)).to.emit(vault, "SweptToSink");

    const busWethAfterSwap: bigint = await weth.balanceOf(predictedBus);
    // INT-2: the Bus genuinely received the swap-fee-derived 50% side, on
    // top of whatever mint/redeem fees already landed there.
    expect(busWethAfterSwap).to.be.gt(busWethBeforeSwap);

    // ── 3. Admit the vault into WeightModule (permissionless) — INT-3
    //    "new vault admit -> appears in weights: autogenesis". ─────────────
    await weightModule.checkAdmit(vaultAddr);
    const { vaults: wVaults, wBps } = await weightModule.weights();
    expect(wVaults).to.deep.equal([vaultAddr]);
    expect(wBps[0]).to.be.gt(0n);

    // ── 4. Deploy the real index Diamond, vault's own share `S` as its ONE
    //    constituent (identical shape to NEST-1). ──────────────────────────
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const source: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    const { vault: index, vaultAddr: indexAddr } = await deployIndexVault({
      name: "AXIOM-1 PR8 Test Index",
      symbol: "tIDX8",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: vaultAddr,
    });

    await index.connect(seeder).seedConstituent(vaultAddr, await source.getAddress(), 10_000);

    await nft.connect(alice).approve(vaultAddr, 2);
    await vault.connect(alice).deposit(2);
    const aliceSBal: bigint = await vault.balanceOf(alice.address);
    const seedSAmount = aliceSBal / 4n;
    await vault.connect(alice).transfer(seeder.address, seedSAmount);
    await vault.connect(seeder).approve(indexAddr, seedSAmount);
    await index.connect(seeder).seedDeposit(vaultAddr, seedSAmount);
    await index.connect(seeder).openIndex(1_000n * WAD);

    const remainingSBal: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).approve(indexAddr, remainingSBal);
    await index.connect(alice).mintProRata(10n * WAD, maxIn(1));

    const supplyBefore: bigint = await index.totalSupply();
    const [, amountsBefore] = await index.previewRedeemProRata(WAD);
    const perShareBefore: bigint = amountsBefore[0];

    // ── 5. Deploy 5 REAL adapters + 1 documented MockEnergyAdapter (Pipe L,
    //    see this file's header) in the EXACT fixed count/order the
    //    predicted-Bus-address math above assumed, then the real Bus itself
    //    at the predicted address. ────────────────────────────────────────
    const MockAdapter = await ethers.getContractFactory("MockEnergyAdapter");
    const clpMock: any = await MockAdapter.connect(busDeployer).deploy(wethAddr); // Pipe L — no real adapter shipped, see header

    const IdxBurn = await ethers.getContractFactory("IdxBurnAdapter");
    const idxBurn: any = await IdxBurn.connect(busDeployer).deploy(wethAddr, indexAddr, predictedBus);

    const PlankBurn = await ethers.getContractFactory("PlankBurnAdapter");
    const plankBurn: any = await PlankBurn.connect(busDeployer).deploy(
      wethAddr,
      predictedBus,
      governance.address,
      TIMELOCK
    );

    const PlankLp = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const plankLp: any = await PlankLp.connect(busDeployer).deploy(
      wethAddr,
      predictedBus,
      governance.address,
      TIMELOCK
    );

    const Div = await ethers.getContractFactory("DividendAdapter");
    const div: any = await Div.connect(busDeployer).deploy(wethAddr, indexAddr, predictedBus);

    const InvAdapter = await ethers.getContractFactory("InventoryBuyAdapter");
    const inv: any = await InvAdapter.connect(busDeployer).deploy(wethAddr, indexAddr, predictedBus, weightModuleAddr);

    const bus: any = await (
      await ethers.getContractFactory("EnergyBus")
    )
      .connect(busDeployer)
      .deploy(
        wethAddr,
        [
          await inv.getAddress(),
          await clpMock.getAddress(),
          await idxBurn.getAddress(),
          await plankBurn.getAddress(),
          await plankLp.getAddress(),
          await div.getAddress(),
        ],
        [INV_BPS, CLP_BPS, IDX_BURN_BPS, PLANK_BURN_BPS, PLANK_LP_BPS, DIV_BPS]
      );
    const busAddr = await bus.getAddress();
    // The whole point of this suite: the Bus lands EXACTLY where the
    // factory's own immutable `upstreamSink` already pointed, with no
    // further wiring call needed on the factory/vault side at all.
    expect(busAddr).to.equal(predictedBus);
    expect(await vault.upstreamSink()).to.equal(busAddr);

    // Wire the index's `onlyEnergyBus` gate to this real Bus (governed,
    // timelocked, same as every other risk-surface change).
    await index.connect(risk).queueEnergyBus(busAddr);
    await time.increase(TIMELOCK + 1);
    await index.executeEnergyBus();
    expect(await index.energyBus()).to.equal(busAddr);

    // PlankBurnAdapter/PlankLpRenounceAdapter are left with NO router/pool
    // configured — the realistic pre-launch state this repo's own PR7 header
    // documents as "a graceful skip, never a forced fake interaction". Their
    // slice therefore returns to the Bus and lands on Pipe D, which is the
    // exact "adapter skip -> remainder to D" behavior ONESHOT §6 rule 7
    // requires and this test asserts on below.

    // ── 6. route() — the REAL end-to-end deposit -> route INT-1/INT-2 ask
    //    for, now against every fee already collected above. ────────────────
    const busWethBeforeRoute: bigint = await weth.balanceOf(busAddr);
    expect(busWethBeforeRoute).to.be.gt(0n);

    const sReserveAtIndexBefore: bigint = await vault.balanceOf(indexAddr);
    const idxSupplyBeforeRoute: bigint = await index.totalSupply();

    await expect(bus.route()).to.not.be.reverted;

    // Pipe I genuinely bought vault S and it landed at the index Diamond.
    const sBalAtIndex: bigint = await vault.balanceOf(indexAddr);
    expect(sBalAtIndex).to.be.gt(sReserveAtIndexBefore);

    // No free iToken was ever minted by any pipe (ONESHOT §6 rule 4).
    expect(await index.totalSupply()).to.equal(idxSupplyBeforeRoute);

    const reconcileNeeded: bigint = await index.reconcile.staticCall(vaultAddr);
    if (reconcileNeeded > 0n) {
      await index.reconcile(vaultAddr);
    }

    for (let i = 0; i < STREAM_VEST_BLOCKS + 2; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    const supplyAfter: bigint = await index.totalSupply();
    const [, amountsAfter] = await index.previewRedeemProRata(WAD);
    const perShareAfter: bigint = amountsAfter[0];

    // INT-1: "end-to-end inventory or div moves" — the real, routed fee
    // genuinely raised the index's own per-share redemption value, with
    // zero new mints between the two snapshots.
    expect(supplyAfter).to.equal(supplyBefore);
    expect(perShareAfter).to.be.gt(perShareBefore);

    // Every pipe accounted for: nothing trapped in the Bus itself.
    expect(await weth.balanceOf(busAddr)).to.equal(0n);
  });
});
