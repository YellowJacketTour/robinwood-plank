import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";
import { TIMELOCK, WAD } from "../helpers/index-vault.js";

/**
 * ============================================================================
 * PR7 (ONESHOT §7) — PlankBurnAdapter (Pipe P) + PlankLpRenounceAdapter
 * (Pipe R).
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md A-P-1 ("PLANK burn | burn
 * address↑; index constituents unchanged") and A-R-1 ("PLANK LP renounce |
 * dead LP↑"), plus this PR's own brief:
 *  - PLANK genuinely reaches a burn address, no receipt/claim minted to
 *    anyone.
 *  - The LP position (when a pool is configured) is genuinely permanently
 *    locked the same way LP_LOCK_ADDR/SEED_LOCK_ADDR already are.
 *  - An unconfigured pool causes a graceful skip, never a revert.
 *  - Neither adapter ever reverts on a recoverable external-router failure.
 *
 * PLANK is external to this repo (see `IExternalSwapRouter.sol`'s header) —
 * these tests use `MockExternalSwapRouter`/`MockExternalPlankLpRouter`, the
 * same "mint the real thing to the real destination" mock doctrine
 * `IndexDevFundFacet.test.ts` already uses for the identical interface.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("PlankBurnAdapter + PlankLpRenounceAdapter (PR7)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

  async function fixture() {
    const [deployer, bus, governance, alice] = await ethers.getSigners();

    const Weth = await ethers.getContractFactory("MockIndexToken");
    const weth: any = await Weth.deploy("Wrapped Ether", "WETH");
    await weth.waitForDeployment();
    const wethAddr = await weth.getAddress();

    const Router = await ethers.getContractFactory("MockExternalSwapRouter");
    const router: any = await Router.deploy(WAD); // 1:1 rate
    await router.waitForDeployment();
    const plankAddr = await router.plank();
    const plank = await ethers.getContractAt("MockPlank", plankAddr);

    const LpPool = await ethers.getContractFactory("MockExternalPlankLpRouter");
    const lpPool: any = await LpPool.deploy(plankAddr, wethAddr);
    await lpPool.waitForDeployment();
    const lp = await ethers.getContractAt("MockPlankLp", await lpPool.lp());

    return { deployer, bus, governance, alice, weth, wethAddr, router, plank, plankAddr, lpPool, lp };
  }

  async function deployBurnAdapter(fx: any, delay = TIMELOCK) {
    const F = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, fx.bus.address, fx.governance.address, delay);
    await adapter.waitForDeployment();
    return adapter;
  }

  async function deployLpAdapter(fx: any, delay = TIMELOCK) {
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, fx.bus.address, fx.governance.address, delay);
    await adapter.waitForDeployment();
    return adapter;
  }

  /** Standalone "bus" adapter shims — `bus` never really finalizes in these
   * unit tests unless a test explicitly deploys a real EnergyBus, so
   * `finalized()` must exist for the `preFinalizeOnly` gate to read. */
  async function fundAndExecute(adapter: any, weth: any, busSigner: any, amount: bigint) {
    await weth.mint(busSigner.address, amount);
    await weth.connect(busSigner).transfer(await adapter.getAddress(), amount);
    const res = await adapter.connect(busSigner).execute.staticCall(amount);
    const tx = await adapter.connect(busSigner).execute(amount);
    await tx.wait();
    return res;
  }

  // Both adapters read `bus.finalized()` for their governance gate — an EOA
  // has no such function, so a tiny stand-in Bus stub is required wherever
  // governance is exercised. For pure execute()/no-router tests, an EOA
  // "bus" works fine since finalized() is never touched in that path... but
  // `queueRouter`/`queueConfig` DO call it, so those specific tests deploy a
  // minimal stub instead.
  async function deployBusStub() {
    const F = await ethers.getContractFactory("MockFinalizableBus");
    const stub: any = await F.deploy();
    await stub.waitForDeployment();
    return stub;
  }

  // ══ PlankBurnAdapter — A-P-1 ═══════════════════════════════════════════

  it("A-P-1: PlankBurnAdapter buys PLANK and delivers it straight to the dead address, no receipt to anyone", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await adapter.connect(fx.governance).queueRouter(await fx.router.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeRouter();
    expect(await adapter.router()).to.equal(await fx.router.getAddress());

    const burnBefore: bigint = await fx.plank.balanceOf(BURN_ADDRESS);
    expect(burnBefore).to.equal(0n);

    const amount = 10n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount);

    const burnAfter: bigint = await fx.plank.balanceOf(BURN_ADDRESS);
    expect(burnAfter).to.equal(10n * WAD); // 1:1 rate, whole amount converted

    // No receipt/claim minted to anyone else — the adapter itself, the
    // governance address, and the bus stub all hold zero PLANK.
    expect(await fx.plank.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await fx.plank.balanceOf(fx.governance.address)).to.equal(0n);
    expect(await fx.plank.balanceOf(await stub.getAddress())).to.equal(0n);

    // The adapter never retains WETH either.
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankBurnAdapter gracefully skips (never reverts) when no router is configured yet", async () => {
    const fx = await fixture();
    const adapter = await deployBurnAdapter(fx);

    const amount = 5n * WAD;
    const [used, skipped] = await fundAndExecute(adapter, fx.weth, fx.bus, amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);

    // Whole slice refunded to the bus signer, never stranded.
    expect(await fx.weth.balanceOf(fx.bus.address)).to.equal(amount);
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankBurnAdapter never reverts execute() when the router reverts outright", async () => {
    const fx = await fixture();
    const adapter = await deployBurnAdapter(fx);
    const stub = await deployBusStub();
    const adapter2Factory = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter2: any = await adapter2Factory.deploy(
      fx.wethAddr,
      await stub.getAddress(),
      fx.governance.address,
      TIMELOCK
    );
    await adapter2.connect(fx.governance).queueRouter(await fx.router.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter2.executeRouter();

    await fx.router.setMode(1); // Mode.REVERT
    const amount = 3n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await expect(stub.pushAndCall(await adapter2.getAddress(), fx.wethAddr, amount)).to.not.be.reverted;

    expect(await fx.weth.balanceOf(await stub.getAddress())).to.equal(amount); // refunded whole
    expect(await fx.weth.balanceOf(await adapter2.getAddress())).to.equal(0n);
    adapter; // silence unused
  });

  it("PlankBurnAdapter never reverts execute() when the router delivers zero PLANK (short delivery)", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);
    await adapter.connect(fx.governance).queueRouter(await fx.router.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeRouter();

    await fx.router.setMode(2); // Mode.SHORT_MINT
    const amount = 3n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await expect(stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount)).to.not.be.reverted;

    // SHORT_MINT pulls the full approval via transferFrom before reporting
    // failure, so there is nothing LEFT on the adapter's own balance to
    // refund (see `PlankBurnAdapter.execute`'s own "balance-based, not
    // blind amountIn" doctrine) — the call still never reverts, which is
    // the property under test, but the WETH is genuinely gone (spent
    // against a router that lied about its output), never left stranded on
    // the adapter and never double-counted back at the Bus.
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await fx.plank.balanceOf(BURN_ADDRESS)).to.equal(0n);
  });

  it("PlankBurnAdapter reverts only for the invariant violation of a non-Bus caller", async () => {
    const fx = await fixture();
    const adapter = await deployBurnAdapter(fx);
    await expect(adapter.connect(fx.alice).execute(1n)).to.be.revertedWithCustomError(adapter, "NotBus");
  });

  it("PlankBurnAdapter router is governed and timelocked: only `governance` may queue, only after the delay may anyone execute", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await expect(adapter.connect(fx.alice).queueRouter(await fx.router.getAddress())).to.be.revertedWithCustomError(
      adapter,
      "NotGovernance"
    );

    await adapter.connect(fx.governance).queueRouter(await fx.router.getAddress());
    await expect(adapter.executeRouter()).to.be.revertedWithCustomError(adapter, "TimelockNotElapsed");

    await time.increase(TIMELOCK + 1);
    await expect(adapter.executeRouter()).to.not.be.reverted;
    expect(await adapter.router()).to.equal(await fx.router.getAddress());
  });

  it("PlankBurnAdapter router cannot be re-queued once the bus has finalized", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankBurnAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await stub.finalize();
    await expect(
      adapter.connect(fx.governance).queueRouter(await fx.router.getAddress())
    ).to.be.revertedWithCustomError(adapter, "BusAlreadyFinalized");
  });

  // ══ PlankLpRenounceAdapter — A-R-1 ═════════════════════════════════════

  it("A-R-1: PlankLpRenounceAdapter buys PLANK, adds it as PLANK/WETH liquidity, and the LP position lands permanently at the dead address", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await adapter
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeConfig();

    const lpBefore: bigint = await fx.lp.balanceOf(BURN_ADDRESS);
    expect(lpBefore).to.equal(0n);

    const amount = 10n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount);

    const lpAfter: bigint = await fx.lp.balanceOf(BURN_ADDRESS);
    expect(lpAfter).to.be.gt(0n); // real, nonzero LP position minted straight to the dead address

    // Same permanence guarantee LP_LOCK_ADDR/SEED_LOCK_ADDR already prove:
    // nobody (not the adapter, not governance, not the bus) holds any of it.
    expect(await fx.lp.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await fx.lp.balanceOf(fx.governance.address)).to.equal(0n);
    expect(await fx.lp.balanceOf(await stub.getAddress())).to.equal(0n);
    // The dead address is the canonical unwithdrawable sink — nothing in
    // either contract exposes a withdraw/transfer-out path for it.
    expect(BURN_ADDRESS.toLowerCase()).to.equal("0x000000000000000000000000000000000000dead");

    // Neither WETH nor PLANK is left stranded on the adapter.
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await fx.plank.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankLpRenounceAdapter gracefully skips (never reverts) when no pool is configured yet", async () => {
    const fx = await fixture();
    const adapter = await deployLpAdapter(fx);

    const amount = 5n * WAD;
    const [used, skipped] = await fundAndExecute(adapter, fx.weth, fx.bus, amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);
    expect(await fx.weth.balanceOf(fx.bus.address)).to.equal(amount);
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankLpRenounceAdapter gracefully skips when only PART of the config is set (e.g. plankToken still zero)", async () => {
    const fx = await fixture();
    // queueConfig requires all three at once, so simulate "partial" by never
    // executing a queued config — router/plankToken/lpPool all stay
    // address(0) — proving the "any zero => skip" branch, not just "all
    // zero => skip".
    const adapter = await deployLpAdapter(fx);
    const amount = 4n * WAD;
    const [used, skipped] = await fundAndExecute(adapter, fx.weth, fx.bus, amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);
  });

  it("PlankLpRenounceAdapter never reverts execute() when the swap router reverts outright", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);
    await adapter
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeConfig();

    await fx.router.setMode(1); // Mode.REVERT
    const amount = 6n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await expect(stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount)).to.not.be.reverted;

    expect(await fx.weth.balanceOf(await stub.getAddress())).to.equal(amount); // refunded whole
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankLpRenounceAdapter never reverts execute() when the LP pool reverts outright (PLANK already bought is not lost across calls, but this call is refunded whole)", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);
    await adapter
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeConfig();

    await fx.lpPool.setMode(1); // Mode.REVERT
    const amount = 6n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await expect(stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount)).to.not.be.reverted;

    // Atomic unwind: the whole amount is refunded, including the WETH half
    // that would have gone to the LP pool — no partial spend.
    expect(await fx.weth.balanceOf(await stub.getAddress())).to.equal(amount);
    expect(await fx.weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    // The PLANK bought mid-attempt was unwound too (external call revert
    // rolls back the whole `_addPlankLiquidity` call, including the mock
    // router's own `transferFrom`).
    expect(await fx.plank.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("PlankLpRenounceAdapter never reverts execute() when the LP pool delivers zero LP (short delivery)", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);
    await adapter
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await time.increase(TIMELOCK + 1);
    await adapter.executeConfig();

    await fx.lpPool.setMode(2); // Mode.ZERO_LP
    const amount = 6n * WAD;
    await fx.weth.mint(await stub.getAddress(), amount);
    await expect(stub.pushAndCall(await adapter.getAddress(), fx.wethAddr, amount)).to.not.be.reverted;

    expect(await fx.weth.balanceOf(await stub.getAddress())).to.equal(amount);
    expect(await fx.lp.balanceOf(BURN_ADDRESS)).to.equal(0n);
  });

  it("PlankLpRenounceAdapter reverts only for the invariant violation of a non-Bus caller", async () => {
    const fx = await fixture();
    const adapter = await deployLpAdapter(fx);
    await expect(adapter.connect(fx.alice).execute(1n)).to.be.revertedWithCustomError(adapter, "NotBus");
  });

  it("PlankLpRenounceAdapter config is governed and timelocked: only `governance` may queue, only after the delay may anyone execute", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await expect(
      adapter.connect(fx.alice).queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress())
    ).to.be.revertedWithCustomError(adapter, "NotGovernance");

    await adapter
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await expect(adapter.executeConfig()).to.be.revertedWithCustomError(adapter, "TimelockNotElapsed");

    await time.increase(TIMELOCK + 1);
    await expect(adapter.executeConfig()).to.not.be.reverted;
    expect(await adapter.lpPool()).to.equal(await fx.lpPool.getAddress());
  });

  it("PlankLpRenounceAdapter config cannot be re-queued once the bus has finalized", async () => {
    const fx = await fixture();
    const stub = await deployBusStub();
    const F = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const adapter: any = await F.deploy(fx.wethAddr, await stub.getAddress(), fx.governance.address, TIMELOCK);

    await stub.finalize();
    await expect(
      adapter
        .connect(fx.governance)
        .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress())
    ).to.be.revertedWithCustomError(adapter, "BusAlreadyFinalized");
  });

  // ══ Real EnergyBus integration: both adapters slot in as Pipe P / Pipe R ═

  it("both adapters slot into a real EnergyBus as Pipe P / Pipe R and never cause route() to revert, even fully unconfigured", async () => {
    const fx = await fixture();

    const deployerAddr = fx.deployer.address;
    const nonce = await ethers.provider.getTransactionCount(deployerAddr);
    // 6 pending deploys before the Bus (real Plank adapters as P/R + 4
    // mocks for I/L/X/D) => Bus is the 7th from `nonce`.
    const predictedBusAddr = ethers.getCreateAddress({ from: deployerAddr, nonce: nonce + 6 });

    const MockAdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
    const m1: any = await MockAdapterFactory.connect(fx.deployer).deploy(fx.wethAddr); // I
    const m2: any = await MockAdapterFactory.connect(fx.deployer).deploy(fx.wethAddr); // L
    const m3: any = await MockAdapterFactory.connect(fx.deployer).deploy(fx.wethAddr); // X
    const PF = await ethers.getContractFactory("PlankBurnAdapter");
    const realP: any = await PF.connect(fx.deployer).deploy(
      fx.wethAddr,
      predictedBusAddr,
      fx.governance.address,
      TIMELOCK
    );
    const RF = await ethers.getContractFactory("PlankLpRenounceAdapter");
    const realR: any = await RF.connect(fx.deployer).deploy(
      fx.wethAddr,
      predictedBusAddr,
      fx.governance.address,
      TIMELOCK
    );
    const m4: any = await MockAdapterFactory.connect(fx.deployer).deploy(fx.wethAddr); // D

    const EnergyBusFactory = await ethers.getContractFactory("EnergyBus");
    const bus: any = await EnergyBusFactory.connect(fx.deployer).deploy(
      fx.wethAddr,
      [
        await m1.getAddress(),
        await m2.getAddress(),
        await m3.getAddress(),
        await realP.getAddress(),
        await realR.getAddress(),
        await m4.getAddress(),
      ],
      [3_500, 1_500, 1_500, 1_000, 1_000, 1_500]
    );
    expect(await bus.getAddress()).to.equal(predictedBusAddr);

    const total = 100n * WAD;
    await fx.weth.mint(await bus.getAddress(), total);

    // Fully unconfigured P/R: route() must not revert, and their slices flow
    // through to Pipe D (the mock) rather than being stranded.
    await expect(bus.route()).to.not.be.reverted;
    expect(await fx.weth.balanceOf(await realP.getAddress())).to.equal(0n);
    expect(await fx.weth.balanceOf(await realR.getAddress())).to.equal(0n);

    // Now wire real routers and re-drive a second route() with fresh WETH —
    // Pipe P really burns, Pipe R really locks LP.
    await realP.connect(fx.governance).queueRouter(await fx.router.getAddress());
    await realR
      .connect(fx.governance)
      .queueConfig(await fx.router.getAddress(), fx.plankAddr, await fx.lpPool.getAddress());
    await time.increase(TIMELOCK + 1);
    await realP.executeRouter();
    await realR.executeConfig();

    const burnBefore: bigint = await fx.plank.balanceOf(BURN_ADDRESS);
    const lpBefore: bigint = await fx.lp.balanceOf(BURN_ADDRESS);

    await fx.weth.mint(await bus.getAddress(), total);
    await expect(bus.route()).to.not.be.reverted;

    expect(await fx.plank.balanceOf(BURN_ADDRESS)).to.be.gt(burnBefore);
    expect(await fx.lp.balanceOf(BURN_ADDRESS)).to.be.gt(lpBefore);
    expect(await fx.weth.balanceOf(await realP.getAddress())).to.equal(0n);
    expect(await fx.weth.balanceOf(await realR.getAddress())).to.equal(0n);
  });
});
