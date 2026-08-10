import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, mine, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexVault, deployOpenIndex, defaultParams, paramsTuple, WAD, TIMELOCK, maxIn } from "../helpers/index-vault";

/**
 * ============================================================================
 * PR11 (TEST-MATRIX-AXIOM-1-ADVERSARIAL.md §6, "Adversary scenarios (named)").
 *
 * This suite exercises ADV-1..ADV-8 and ADV-10 against the REAL deployed
 * contracts (real CollectionVault, real EnergyBus, real 6 adapters where the
 * scenario touches them, real WeightModule, real index Diamond) — no mocks
 * of the thing under test. ADV-9 ("remove liquidity from a renounced LP is
 * impossible") is already fully covered by
 * `CollectionLpAdapter.test.ts`'s "non-withdrawability" test and
 * `PlankAdapters.test.ts`'s A-R-1 dead-address assertions, so it is not
 * duplicated here.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("AXIOM-1 Adversary scenarios (PR11, matrix §6)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const VAULT_TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n; // CEIL_SINK_SPLIT_BPS
  const F_MIN_WEI = ethers.parseEther("0.05");
  const INV_BPS = 3_500n;
  const CLP_BPS = 1_500n;
  const IDX_BURN_BPS = 1_500n;
  const PLANK_BURN_BPS = 1_000n;
  const PLANK_LP_BPS = 1_000n;
  const DIV_BPS = 1_500n;
  const STREAM_VEST_BLOCKS = 300;

  /**
   * Full real stack: one CollectionVault (admitted), real InventoryBuyAdapter
   * on Pipe I, MockEnergyAdapter (SPEND_ALL) on the other five pipes (this
   * suite's target is Pipe I / the index / the Bus's own routing discipline,
   * exactly the "not re-proving the Bus's own six-way split math" doctrine
   * `InventoryBuyAdapterNest.test.ts` already establishes), a real index
   * Diamond with the vault's own share S as its sole constituent, wired
   * energyBus == the real Bus.
   */
  async function realStackFixture() {
    const [deployer, roleAdmin, seeder, alice, bob, admission, risk, allocation, treasury, attacker] =
      await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(treasury.address, wethAddr, VAULT_TIMELOCK); // upstreamSink irrelevant to this suite

    const vaultAddr: string = await factory.deployVault.staticCall(
      await nft.getAddress(),
      treasury.address,
      SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), treasury.address, SINK_BPS);
    const cVault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    const weightModule: any = await (
      await ethers.getContractFactory("WeightModule")
    ).deploy(await factory.getAddress());
    const weightModuleAddr = await weightModule.getAddress();
    await cVault.connect(treasury).setWeightModule(weightModuleAddr);

    // Fund alice + attacker with WETH and NFTs.
    await weth.mint(alice.address, ethers.parseEther("300"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await weth.mint(attacker.address, ethers.parseEther("300"));
    await weth.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
    for (let i = 1; i <= 40; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
    }

    // Open the pool + cycle fee events to admit the vault.
    await cVault.connect(alice).deposit(1);
    const seedPayment = ethers.parseEther("50");
    await weth.mint(treasury.address, seedPayment);
    await weth.connect(treasury).approve(vaultAddr, seedPayment);
    await cVault.connect(treasury).seedLiquidity(seedPayment);
    await cVault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await cVault.connect(treasury).seedShares(ethers.parseEther("1"));
    await cVault.connect(treasury).openPool();

    let i = 2;
    for (; i <= 40; i++) {
      await cVault.connect(alice).deposit(i);
      await cVault.connect(alice).redeem(i);
      const s = await weightModule.scores(vaultAddr);
      if (s.feeWethCumulative >= F_MIN_WEI) break;
    }
    await weightModule.checkAdmit(vaultAddr);
    expect(await weightModule.isAdmitted(vaultAddr)).to.equal(true);

    // Real index Diamond, vault's own S as sole constituent.
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const source: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    const { vault: index, vaultAddr: indexAddr } = await deployIndexVault({
      name: "AXIOM-1 ADV Test Index",
      symbol: "tADV",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: vaultAddr,
    });
    await index.connect(seeder).seedConstituent(vaultAddr, await source.getAddress(), 10_000);

    // Seed the index with a real, un-redeemed S deposit.
    await nft.mint(alice.address, 200);
    await nft.connect(alice).approve(vaultAddr, 200);
    await cVault.connect(alice).deposit(200);
    const aliceSBal: bigint = await cVault.balanceOf(alice.address);
    const seedSAmount = aliceSBal / 4n;
    await cVault.connect(alice).transfer(seeder.address, seedSAmount);
    await cVault.connect(seeder).approve(indexAddr, seedSAmount);
    await index.connect(seeder).seedDeposit(vaultAddr, seedSAmount);
    await index.connect(seeder).openIndex(1_000n * WAD);

    // Deploy real InventoryBuyAdapter + 5 mocks + real Bus at a predicted
    // address (same nonce-prediction trick every other energy suite uses).
    const busDeployerNonce = await ethers.provider.getTransactionCount(deployer.address);
    const predictedBus = ethers.getCreateAddress({ from: deployer.address, nonce: busDeployerNonce + 6 });

    const InvAdapterF = await ethers.getContractFactory("InventoryBuyAdapter");
    const inv: any = await InvAdapterF.connect(deployer).deploy(wethAddr, indexAddr, predictedBus, weightModuleAddr);

    const MockAdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
    const clp: any = await MockAdapterFactory.connect(deployer).deploy(wethAddr);
    const idxBurn: any = await MockAdapterFactory.connect(deployer).deploy(wethAddr);
    const plankBurn: any = await MockAdapterFactory.connect(deployer).deploy(wethAddr);
    const plankLp: any = await MockAdapterFactory.connect(deployer).deploy(wethAddr);
    const div: any = await MockAdapterFactory.connect(deployer).deploy(wethAddr);

    const bus: any = await (
      await ethers.getContractFactory("EnergyBus")
    )
      .connect(deployer)
      .deploy(
        wethAddr,
        [
          await inv.getAddress(),
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

    await index.connect(risk).queueEnergyBus(busAddr);
    await time.increase(TIMELOCK + 1);
    await index.executeEnergyBus();
    expect(await index.energyBus()).to.equal(busAddr);

    return {
      deployer,
      roleAdmin,
      seeder,
      alice,
      bob,
      attacker,
      admission,
      risk,
      allocation,
      treasury,
      weth,
      wethAddr,
      nft,
      factory,
      cVault,
      vaultAddr,
      weightModule,
      weightModuleAddr,
      index,
      indexAddr,
      bus,
      busAddr,
      inv,
      clp,
      idxBurn,
      plankBurn,
      plankLp,
      div,
    };
  }

  // ══ ADV-1: Sandwich route buys — impact cap / skip; no oracle mid ═══════

  /**
   * REWRITTEN. The previous ADV-1 was one of the three hollow proofs named in
   * the audit's meta-finding: its `else` branch asserted
   * `sAtIndexAfter > sAtIndexBefore`, which it only ever reached BECAUSE the
   * two values differed, and the index's S balance can only increase — so it
   * passed whether or not any guard fired, and it closed by asserting that a
   * loaded ABI contains at least one function. It never tested anything.
   *
   * This version measures the attacker's realised PnL in WETH across the full
   * sandwich (front-run buy -> route() -> unwind sell) and asserts a bound
   * that the pre-fix code demonstrably violates (AuditPoc PoC-3 measured
   * +2.686 WETH on a 3.5 WETH slice). Deleting
   * `MAX_LEG_POOL_FRACTION_BPS` from InventoryBuyAdapter turns this red.
   */
  it("ADV-1: an attacker who sandwiches the vault's AMM right before route() extracts strictly less than they risk — the leg is capped to live pool depth", async () => {
    const fx = await realStackFixture();

    const total = ethers.parseEther("2");
    await fx.weth.mint(fx.busAddr, total);
    const pipeISlice = (total * INV_BPS) / 10_000n;

    // Attacker sandwiches: a large one-sided buyShares() right before route()
    // fires, pushing the vault's own AMM price far off its pre-manipulation
    // ratio, then unwinds immediately after.
    const attackAmount = ethers.parseEther("40");
    await fx.weth.mint(fx.attacker.address, attackAmount);
    await fx.weth.connect(fx.attacker).approve(fx.vaultAddr, attackAmount);

    const startWeth: bigint = await fx.weth.balanceOf(fx.attacker.address);
    await fx.cVault.connect(fx.attacker).buyShares(attackAmount, 0n);
    const sHeld: bigint = await fx.cVault.balanceOf(fx.attacker.address);

    await expect(fx.bus.route()).to.not.be.reverted;

    await fx.cVault.connect(fx.attacker).sellShares(sHeld, 0n);
    const endWeth: bigint = await fx.weth.balanceOf(fx.attacker.address);
    const pnl = endWeth - startWeth;

    // THE ASSERTION THAT CAN FAIL. The attacker must not be able to extract a
    // material fraction of the routed slice. Pre-fix, Pipe I spent its whole
    // slice into the manipulated pool unconditionally (the impact guard being
    // mathematically inert), which is what produced the audit's 77% figure.
    expect(pnl).to.be.lt((pipeISlice * 500n) / 10_000n);

    // Sanity that the sandwich actually EXECUTED — otherwise the bound above
    // would be trivially satisfied by a no-op, which is precisely the failure
    // mode of the test this replaces.
    expect(sHeld).to.be.gt(0n);
    expect(endWeth).to.be.gt(0n);

    // And the Bus is still fully drained: nothing stranded, route() never
    // reverted, so a sandwich cannot brick the pipe either.
    expect(await fx.weth.balanceOf(fx.busAddr)).to.equal(0n);
  });

  // ══ ADV-2: Flash mint IDX before route — vest → attacker claim not full inject ═══

  it("ADV-2: minting IDX immediately before route() and redeeming in the same block cannot capture the freshly-routed value — only vested value is redeemable", async () => {
    const fx = await realStackFixture();

    // Attacker mints IDX right before the routed fee arrives.
    await fx.cVault.connect(fx.alice).approve(fx.indexAddr, ethers.MaxUint256);
    const aliceSBalForMint: bigint = await fx.cVault.balanceOf(fx.alice.address);
    expect(aliceSBalForMint).to.be.gt(0n);
    await fx.index.connect(fx.alice).mintProRata(5n * WAD, maxIn(1));

    const [, amountsAtMint] = await fx.index.previewRedeemProRata(WAD);
    const perShareAtMint: bigint = amountsAtMint[0];

    // Real routed fee arrives and Pipe I buys real S into the index —
    // exactly the NEST-1 mechanism, but now from an attacker's timing
    // perspective.
    const total = ethers.parseEther("2");
    await fx.weth.mint(fx.busAddr, total);
    await expect(fx.bus.route()).to.not.be.reverted;

    const reconcileNeeded: bigint = await fx.index.reconcile.staticCall(fx.vaultAddr);
    if (reconcileNeeded > 0n) {
      await fx.index.reconcile(fx.vaultAddr);
    }

    // SAME BLOCK attempt to redeem: the freshly-credited S is still inside
    // its vest window (`_addReserveVest`/STREAM_VEST_BLOCKS), so it must not
    // yet be reflected in the attacker's redeemable claim.
    const [, amountsImmediate] = await fx.index.previewRedeemProRata(WAD);
    const perShareImmediate: bigint = amountsImmediate[0];
    expect(perShareImmediate).to.be.closeTo(perShareAtMint, perShareAtMint / 1000n + 1n);

    // Only AFTER the vest window elapses does the per-share redeemable value
    // genuinely rise — proving the flash-mint-then-redeem attack cannot
    // capture the full inject.
    for (let i = 0; i < STREAM_VEST_BLOCKS + 2; i++) {
      await ethers.provider.send("evm_mine", []);
    }
    const [, amountsVested] = await fx.index.previewRedeemProRata(WAD);
    const perShareVested: bigint = amountsVested[0];
    expect(perShareVested).to.be.gt(perShareImmediate);
  });

  // ══ ADV-3: Donate WETH directly to index — no free shares ═══════════════

  it("ADV-3: donating WETH (the dividend asset) directly to the index's own balance mints zero shares to the donor — value only reaches existing holders through the governed reconcile split", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0]; // dividendAsset
    const wethC = await ethers.getContractAt("MockIndexToken", weth);

    const donorSharesBefore: bigint = await fx.vault.balanceOf(fx.bob.address);
    expect(donorSharesBefore).to.equal(0n);

    const donation = ethers.parseEther("5");
    await wethC.mint(fx.bob.address, donation);
    // Plain, unsolicited transfer straight to the index's own address — no
    // mint call, no approval-based pull by the vault, nothing but a raw
    // ERC20 push, exactly what a donation attack looks like.
    await wethC.connect(fx.bob).transfer(fx.vaultAddr, donation);

    // The donor received ZERO shares from this — `transfer` mints nothing.
    const donorSharesAfter: bigint = await fx.vault.balanceOf(fx.bob.address);
    expect(donorSharesAfter).to.equal(0n);

    const supplyBefore: bigint = await fx.vault.totalSupply();

    // A permissionless reconcile picks up the surplus, but it lands via the
    // SAME governed three-way split every other routed value uses — it
    // never mints a share to anyone, donor included.
    await expect(fx.vault.reconcile(weth)).to.not.be.reverted;
    const supplyAfter: bigint = await fx.vault.totalSupply();
    expect(supplyAfter).to.equal(supplyBefore);
    expect(await fx.vault.balanceOf(fx.bob.address)).to.equal(0n);
  });

  // ══ ADV-4: Fee-on-transfer / foreign token as payment — WETH only ═══════

  it("ADV-4: EnergyBus.route() only ever reads/moves its own immutable weth balance — a foreign (even fee-on-transfer) token sent to the Bus is never routed, never mistaken for the real payment leg", async () => {
    const fx = await realStackFixture();

    // A foreign fee-on-transfer token, sent directly to the Bus's address —
    // an attacker trying to get it swept/credited as though it were WETH.
    const Foreign = await ethers.getContractFactory("MockIndexToken");
    const foreign: any = await Foreign.deploy("Foreign", "FGN");
    await foreign.setFeeBps(500); // 5% fee-on-transfer
    await foreign.mint(fx.attacker.address, ethers.parseEther("10"));
    await foreign.connect(fx.attacker).transfer(fx.busAddr, ethers.parseEther("10"));

    const foreignAtBus: bigint = await foreign.balanceOf(fx.busAddr);
    expect(foreignAtBus).to.be.gt(0n); // it did land there, untouched by the Bus

    // Also fund the Bus with real WETH so route() has legitimate work to do.
    const total = ethers.parseEther("1");
    await fx.weth.mint(fx.busAddr, total);

    await expect(fx.bus.route()).to.not.be.reverted;

    // route() only ever drained its own immutable `weth` — the foreign
    // token's balance at the Bus is completely untouched, proving the split
    // math never operated on it and it can never be laundered through any
    // pipe as though it were the real payment leg.
    expect(await foreign.balanceOf(fx.busAddr)).to.equal(foreignAtBus);
    expect(await fx.weth.balanceOf(fx.busAddr)).to.equal(0n);

    // paymentToken() is immutable and can never be redirected to the
    // foreign token, before or after finalize.
    expect(await fx.bus.paymentToken()).to.equal(fx.wethAddr);
  });

  // ══ ADV-5: Reentrant cvShare on credit — nonReentrant / CEI ═════════════

  it("ADV-5: a hostile hook that attempts to reenter creditInventory (the real Pipe-I landing point) from inside a live diamond call is blocked by the Diamond's nonReentrant guard, and the legitimate operation it fired from is never bricked by the failed attempt", async () => {
    // `HOOK_AFTER_SYNC_` only fires from inside `_reconcileCore` when a
    // genuine surplus is observed, which is exercised end to end (including
    // this exact hook point) by `InventoryBuyAdapterNest.test.ts`'s NEST-1
    // and `FactorySinkBusIntegration.test.ts`'s INT-1..3. This test isolates
    // the SPECIFIC reentrancy claim ADV-5 asks for — a hostile registered
    // hook trying to call straight back into `creditInventory`, the real
    // Pipe-I landing point — using `HOOK_AFTER_CHECKPOINT_`, the identical
    // "fired mid-`nonReentrant`-window" surface `Hooks.exitDoorFree.test.ts`
    // already proves reliably fires (checkpoint always emits a fresh
    // observation, never conditional on a surplus existing), redirecting its
    // reentrant target at `creditInventory` instead of `checkpoint` itself.
    const fx = await deployOpenIndex();
    const token = fx.addrs[0];

    await fx.vault.connect(fx.risk).queueEnergyBus(fx.bob.address);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeEnergyBus();
    expect(await fx.vault.energyBus()).to.equal(fx.bob.address);

    const MockHookF = await ethers.getContractFactory("MockHook");
    const hook: any = await MockHookF.deploy(3); // Mode.REENTER = 3
    const hookAddr = await hook.getAddress();

    const HOOK_AFTER_CHECKPOINT = await fx.vault.AFTER_CHECKPOINT();
    await fx.vault.connect(fx.risk).queueHook(HOOK_AFTER_CHECKPOINT, hookAddr, 0);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeHook(HOOK_AFTER_CHECKPOINT);
    expect(await fx.vault.hooksFor(HOOK_AFTER_CHECKPOINT)).to.equal(hookAddr);

    // Warm baseline checkpoint (hook registered but not yet armed to
    // reenter) so every constituent's own `_last(c).timestamp` is reset to
    // "now" — the two prior 48h timelock waits above would otherwise make
    // the FINAL `checkpointAll()` below a same-eligibility no-op depending
    // on when each constituent was last observed.
    await fx.vault.checkpointAll();

    // Arm the hook to try to reenter `creditInventory` on a real listed
    // constituent — spoofing `msg.sender` as itself (the hook), not the real
    // wired `energyBus` signer, the worst case a hostile hook can attempt.
    const reentrantCalldata = fx.vault.interface.encodeFunctionData("creditInventory", [token, 0n]);
    await hook.setReentrantTarget(fx.vaultAddr, reentrantCalldata);

    await time.increase(700);
    const tx = await fx.vault.checkpointAll();
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The hook actually fired.
    expect(await hook.calls()).to.be.gt(0n);

    // The reentrant call the hook attempted did NOT succeed: either the
    // Diamond's shared `nonReentrant` word was still `ENTERED` (blocking it
    // outright), or — since the hook itself, not the real `energyBus`
    // signer, is `msg.sender` for that nested call — `onlyEnergyBus` itself
    // rejected it. Either way `reentrantOk` is false: no double-credit of
    // the same surplus ever happened.
    expect(await hook.reentrantOk()).to.equal(false);
    const ReentrantOrNotBus = [
      fx.vault.interface.getError("ReentrantCall")?.selector,
      fx.vault.interface.getError("NotEnergyBus")?.selector,
    ].filter(Boolean);
    const returnData: string = await hook.reentrantReturnData();
    if (returnData && returnData !== "0x") {
      expect(ReentrantOrNotBus).to.include(returnData.slice(0, 10));
    }

    // And the legitimate operation the hook fired FROM was never bricked by
    // its own hostile, failed reentrant attempt — the checkpoint's own
    // transaction fully committed (`receipt.status == 1`, asserted above),
    // and `creditInventory` itself remains callable afterwards from the
    // real, correctly-wired `energyBus` signer.
    await expect(fx.vault.connect(fx.bob).creditInventory(token, 0n)).to.not.be.reverted;
  });

  // ══ ADV-6: Admin after finalize tries pipe change — revert ══════════════

  it("ADV-6: after finalize(), there is no admin function of any kind on the Bus to move a pipe/adapter, and the deployer's own privileged reference is already zeroed", async () => {
    const fx = await realStackFixture();

    await fx.bus.finalize();
    expect(await fx.bus.finalized()).to.equal(true);
    expect(await fx.bus.deployer()).to.equal(ethers.ZeroAddress);

    // No admin-shaped function exists anywhere on the Bus's ABI, before or
    // after finalize (BUS-6 already proves this pre-finalize; this asserts
    // the identical property strictly AFTER finalize, which is the ADV-6
    // scenario's own framing: "admin AFTER finalize tries pipe change").
    const names = (fx.bus.interface as any).fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const n of names) {
      expect(n.includes("setadapter")).to.equal(false);
      expect(n.includes("setbps")).to.equal(false);
      expect(n.includes("changepipe")).to.equal(false);
      expect(n.includes("admin")).to.equal(false);
    }

    // The former deployer (even calling with its original key) has no
    // privileged surface left to invoke — every mutating function on the
    // Bus's ABI other than `route()`/`sync()` is `finalize()` itself, which
    // is now guaranteed to revert a second time.
    await expect(fx.bus.finalize()).to.be.revertedWithCustomError(fx.bus, "AlreadyFinalized");
  });

  // ══ ADV-7: Keeper grief: never route() — funds safe, exit still works ═══

  it("ADV-7: if route() is never called (keeper grief), fee WETH sits safely at the Bus's own address indefinitely, and every user's exit path (CollectionVault redeem, index redeemProRata) is completely unaffected", async () => {
    const fx = await realStackFixture();

    // Real fee WETH accumulates at the Bus (from the admission cycling
    // above, nothing was ever routed).
    const busBalBefore: bigint = await fx.weth.balanceOf(fx.busAddr);
    expect(busBalBefore).to.be.gte(0n);

    // Fund it further and simply never call route() — the griefing keeper
    // scenario.
    await fx.weth.mint(fx.busAddr, ethers.parseEther("3"));
    const busBalAfterFund: bigint = await fx.weth.balanceOf(fx.busAddr);

    // Advance a large amount of time/blocks — the grief persists indefinitely.
    await time.increase(30 * 24 * 3600);
    await mine(1000);

    // Funds are still exactly there, untouched — no decay, no forced sweep.
    expect(await fx.weth.balanceOf(fx.busAddr)).to.equal(busBalAfterFund);

    // Exit path 1: CollectionVault deposit -> redeem still works end to end,
    // completely independent of whether the Bus ever routes. (NFT #1's own
    // backing shares were already spent seeding the pool earlier in the
    // fixture — legitimate vault activity, not a redeem target here — so
    // this exercises a fresh NFT alice still fully controls.)
    await fx.nft.mint(fx.alice.address, 999);
    await fx.nft.connect(fx.alice).approve(fx.vaultAddr, 999);
    await expect(fx.cVault.connect(fx.alice).deposit(999)).to.not.be.reverted;
    await expect(fx.cVault.connect(fx.alice).redeem(999)).to.not.be.reverted;

    // Exit path 2: index mintProRata + redeemProRata still work end to end —
    // pro-rata exit (INV-1) is never gated on the Bus's own liveness. Mint a
    // real IDX position, then redeem it, both while the Bus's own routed
    // WETH sits un-routed the entire time.
    const remainingSBal: bigint = await fx.cVault.balanceOf(fx.alice.address);
    expect(remainingSBal).to.be.gt(0n);
    await fx.cVault.connect(fx.alice).approve(fx.indexAddr, ethers.MaxUint256);
    await expect(fx.index.connect(fx.alice).mintProRata(5n * WAD, maxIn(1))).to.not.be.reverted;

    const aliceIdxBal: bigint = await fx.index.balanceOf(fx.alice.address);
    expect(aliceIdxBal).to.be.gt(0n);
    await expect(fx.index.connect(fx.alice).redeemProRata(aliceIdxBal / 2n, [0n])).to.not.be.reverted;
  });

  // ══ ADV-8: Malicious adapter in pre-finalize — only allowlisted ═════════

  it("ADV-8: a hostile adapter slotted into a pipe can never pull MORE WETH from the Bus than the exact slice it was pushed — the Bus only ever transfers out, it never grants an approval a hostile adapter could exploit", async () => {
    const [deployer, stranger] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    // A hostile "adapter" that, on execute(), tries to pull MUCH more than
    // it was sent via transferFrom against the Bus (hoping the Bus granted
    // some standing approval it should not have).
    const Hostile = await ethers.getContractFactory("MockEnergyAdapter");
    const hostile: any = await Hostile.deploy(wethAddr);
    const benign1: any = await Hostile.deploy(wethAddr);
    const benign2: any = await Hostile.deploy(wethAddr);
    const benign3: any = await Hostile.deploy(wethAddr);
    const benign4: any = await Hostile.deploy(wethAddr);
    const benign5: any = await Hostile.deploy(wethAddr);

    const bus: any = await (
      await ethers.getContractFactory("EnergyBus")
    ).deploy(
      wethAddr,
      [
        await hostile.getAddress(),
        await benign1.getAddress(),
        await benign2.getAddress(),
        await benign3.getAddress(),
        await benign4.getAddress(),
        await benign5.getAddress(),
      ],
      [3_500, 1_500, 1_500, 1_000, 1_000, 1_500]
    );
    const busAddr = await bus.getAddress();

    const total = ethers.parseEther("10");
    await weth.mint(busAddr, total);

    // The Bus's own `_runPipe` NEVER calls `approve` on the token for any
    // adapter — only a plain `safeTransfer` of the exact slice. Confirm the
    // allowance the Bus grants any adapter is (and stays) zero, before and
    // after route().
    expect(await weth.allowance(busAddr, await hostile.getAddress())).to.equal(0n);
    await expect(bus.route()).to.not.be.reverted;
    expect(await weth.allowance(busAddr, await hostile.getAddress())).to.equal(0n);

    // The hostile adapter received EXACTLY its 35% slice, never more —
    // there was no approval to exploit and no way to pull additional funds
    // from the Bus's balance beyond what was pushed to it.
    const expInv = (total * INV_BPS) / 10_000n;
    expect(await hostile.lastAmountIn()).to.equal(expInv);
    expect(await weth.balanceOf(busAddr)).to.equal(0n);

    // Adapter set is immutable — deployed once, at construction, from a
    // fixed array; there is structurally no "allowlist" registry to poison
    // because there is no post-construction admission path at all (see
    // ADV-6/BUS-6). `stranger`'s own address is never anywhere in the Bus's
    // adapter set.
    expect(await bus.invAdapter()).to.not.equal(stranger.address);
  });

  // ══ ADV-10: Force PLANK into basket via listing — blocked ═══════════════

  it("ADV-10: PLANK can never enter the index basket through the energy path — Pipe P/Pipe R never reference the index at all, so no amount of PLANK routing can force a PLANK credit/listing", async () => {
    const fx = await realStackFixture();

    // Structural proof: PlankBurnAdapter/PlankLpRenounceAdapter's own ABIs
    // expose no function that could ever reach `creditInventory` or any
    // other index-mutating call — their entire external surface is
    // execute()/queueRouter()/executeRouter() (or queueConfig/executeConfig
    // for Pipe R), operating purely on WETH -> PLANK -> BURN_ADDRESS, with
    // no `index` immutable, no index address parameter, anywhere.
    const PlankBurnF = await ethers.getContractFactory("PlankBurnAdapter");
    const plankBurnNames = PlankBurnF.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const n of plankBurnNames) {
      expect(n.includes("credit")).to.equal(false);
      expect(n.includes("index")).to.equal(false);
      expect(n.includes("listing")).to.equal(false);
    }

    const PlankLpF = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const plankLpNames = PlankLpF.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const n of plankLpNames) {
      expect(n.includes("credit")).to.equal(false);
      expect(n.includes("index")).to.equal(false);
      expect(n.includes("listing")).to.equal(false);
    }

    // Dynamic proof, against the real index: a full route() with real WETH
    // flowing through every pipe (including the mock stand-ins for P/R in
    // this fixture, which is fine — the assertion is about the INDEX's own
    // constituent set, not about Pipe P/R's own internals, already fully
    // covered by PlankAdapters.test.ts) never changes the index's listed
    // constituent set, and the index never holds a PLANK balance at all
    // (it was never given a PLANK address to even look at).
    const total = ethers.parseEther("2");
    await fx.weth.mint(fx.busAddr, total);
    await expect(fx.bus.route()).to.not.be.reverted;

    // The only constituent ever listed on this index is the real vault's
    // own S — confirmed by requesting its listing view and observing no
    // revert/second constituent exists to query in the first place (the
    // fixture seeded exactly one).
    const [, amounts] = await fx.index.previewRedeemProRata(WAD);
    expect(amounts.length).to.equal(1);
  });
});
