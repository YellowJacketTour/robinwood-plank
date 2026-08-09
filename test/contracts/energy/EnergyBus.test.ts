import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * PR2 (ONESHOT §7) — EnergyBus + mock adapters.
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md BUS-1..BUS-8.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("EnergyBus — 6-pipe WETH splitter (PR2)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const BPS_DENOM = 10_000n;
  const INV_BPS = 3500n;
  const CLP_BPS = 1500n;
  const IDX_BURN_BPS = 1500n;
  const PLANK_BURN_BPS = 1000n;
  const PLANK_LP_BPS = 1000n;
  const DIV_BPS = 1500n;

  const MAX_ROUTE_WEI = ethers.parseEther("10");
  const MIN_ROUTE_WEI = ethers.parseEther("0.001");

  async function deployFixture() {
    const [deployer, stranger] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();

    const AdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
    const inv: any = await AdapterFactory.deploy(await weth.getAddress());
    const clp: any = await AdapterFactory.deploy(await weth.getAddress());
    const idxBurn: any = await AdapterFactory.deploy(await weth.getAddress());
    const plankBurn: any = await AdapterFactory.deploy(await weth.getAddress());
    const plankLp: any = await AdapterFactory.deploy(await weth.getAddress());
    const div: any = await AdapterFactory.deploy(await weth.getAddress());

    const bus: any = await (await ethers.getContractFactory("EnergyBus")).deploy(
      await weth.getAddress(),
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

    return { deployer, stranger, weth, inv, clp, idxBurn, plankBurn, plankLp, div, bus };
  }

  async function fund(weth: any, bus: any, amount: bigint) {
    await weth.mint(await bus.getAddress(), amount);
  }

  it("BUS-1: route with balance < MIN is a documented no-op (spent=0, no revert)", async () => {
    const { weth, bus } = await deployFixture();
    await fund(weth, bus, MIN_ROUTE_WEI - 1n);

    const spent = await bus.route.staticCall();
    expect(spent).to.equal(0n);

    await expect(bus.route()).to.not.be.reverted;
    // Balance untouched.
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(MIN_ROUTE_WEI - 1n);
  });

  it("BUS-2: route splits exact bps — each adapter received correct WETH (remainder on last pipe D)", async () => {
    const { weth, bus, inv, clp, idxBurn, plankBurn, plankLp, div } = await deployFixture();
    const total = ethers.parseEther("1"); // < MAX_ROUTE_WEI
    await fund(weth, bus, total);

    // Default mode SPEND_ALL on every adapter.
    await bus.route();

    const expInv = (total * INV_BPS) / BPS_DENOM;
    const expClp = (total * CLP_BPS) / BPS_DENOM;
    const expIdx = (total * IDX_BURN_BPS) / BPS_DENOM;
    const expPlankBurn = (total * PLANK_BURN_BPS) / BPS_DENOM;
    const expPlankLp = (total * PLANK_LP_BPS) / BPS_DENOM;
    const expDiv = total - expInv - expClp - expIdx - expPlankBurn - expPlankLp;

    expect(await inv.lastAmountIn()).to.equal(expInv);
    expect(await clp.lastAmountIn()).to.equal(expClp);
    expect(await idxBurn.lastAmountIn()).to.equal(expIdx);
    expect(await plankBurn.lastAmountIn()).to.equal(expPlankBurn);
    expect(await plankLp.lastAmountIn()).to.equal(expPlankLp);
    expect(await div.lastAmountIn()).to.equal(expDiv);

    // Every adapter consumed exactly what it received (SPEND_ALL); Bus is drained.
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(0n);
  });

  it("BUS-3: adapter skip -> remainder reaches DividendAdapter, never an admin address", async () => {
    const { weth, bus, inv, div } = await deployFixture();
    const total = ethers.parseEther("1");
    await fund(weth, bus, total);

    const MockEnergyAdapterMode = { SKIP_ALL: 1 };
    await inv.setMode(MockEnergyAdapterMode.SKIP_ALL);

    const expInv = (total * INV_BPS) / BPS_DENOM;

    await bus.route();

    // Pipe I skipped; div's lastAmountIn must include I's slice on top of its own.
    const expClp = (total * CLP_BPS) / BPS_DENOM;
    const expIdx = (total * IDX_BURN_BPS) / BPS_DENOM;
    const expPlankBurn = (total * PLANK_BURN_BPS) / BPS_DENOM;
    const expPlankLp = (total * PLANK_LP_BPS) / BPS_DENOM;
    const baseDiv = total - expInv - expClp - expIdx - expPlankBurn - expPlankLp;
    const expDivFinal = baseDiv + expInv;

    expect(await div.lastAmountIn()).to.equal(expDivFinal);
    expect(await inv.totalReceived()).to.equal(expInv);
    // Inv adapter must have returned everything (skip = no consumption).
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(0n);
  });

  it("BUS-3b: a reverting adapter is caught (route() itself does not revert), and its slice is neither lost to D nor sent to any admin address", async () => {
    const { weth, bus, plankBurn, div } = await deployFixture();
    const total = ethers.parseEther("1");
    await fund(weth, bus, total);

    const MockEnergyAdapterMode = { REVERT: 3 };
    await plankBurn.setMode(MockEnergyAdapterMode.REVERT);

    const expPlankBurn = (total * PLANK_BURN_BPS) / BPS_DENOM;
    const expInv = (total * INV_BPS) / BPS_DENOM;
    const expClp = (total * CLP_BPS) / BPS_DENOM;
    const expIdx = (total * IDX_BURN_BPS) / BPS_DENOM;
    const expPlankLp = (total * PLANK_LP_BPS) / BPS_DENOM;
    const baseDiv = total - expInv - expClp - expIdx - expPlankBurn - expPlankLp;

    // The Bus's per-pipe try/catch means one reverting adapter never halts
    // the other 5 pipes or the whole route() call.
    await expect(bus.route()).to.not.be.reverted;

    // The WETH the Bus pushed to the reverting adapter BEFORE calling
    // execute() is a separate, already-committed transfer — a revert inside
    // execute() cannot claw it back. It is stuck at the adapter's own
    // address (immutable, non-admin contract), never rerouted to D and
    // never reaching any admin-controlled address. Every other pipe,
    // including D's own direct slice, is unaffected.
    expect(await weth.balanceOf(await plankBurn.getAddress())).to.equal(expPlankBurn);
    expect(await div.lastAmountIn()).to.equal(baseDiv);
  });

  it("BUS-3c: hostile adapter that keeps WETH but reports skipped=true cannot double-route via balance reconciliation", async () => {
    const { weth, bus, clp, div } = await deployFixture();
    const total = ethers.parseEther("1");
    await fund(weth, bus, total);

    const MockEnergyAdapterMode = { LIE_SKIP_BUT_KEEP: 4 };
    await clp.setMode(MockEnergyAdapterMode.LIE_SKIP_BUT_KEEP);

    const expClp = (total * CLP_BPS) / BPS_DENOM;
    const expInv = (total * INV_BPS) / BPS_DENOM;
    const expIdx = (total * IDX_BURN_BPS) / BPS_DENOM;
    const expPlankBurn = (total * PLANK_BURN_BPS) / BPS_DENOM;
    const expPlankLp = (total * PLANK_LP_BPS) / BPS_DENOM;
    const baseDiv = total - expInv - expClp - expIdx - expPlankBurn - expPlankLp;

    await bus.route();

    // Div did NOT get clp's slice a second time — the adapter actually kept
    // the WETH (observed balance delta = full amount), so nothing extra
    // flows to D despite the adapter's lie.
    expect(await div.lastAmountIn()).to.equal(baseDiv);
    expect(await weth.balanceOf(await clp.getAddress())).to.equal(expClp);
  });

  it("BUS-4: MAX_ROUTE caps spend — multiple routes drain a large balance safely", async () => {
    const { weth, bus } = await deployFixture();
    const total = MAX_ROUTE_WEI * 3n + ethers.parseEther("0.5");
    await fund(weth, bus, total);

    const spent1 = await bus.route.staticCall();
    expect(spent1).to.equal(MAX_ROUTE_WEI);
    await bus.route();
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(total - MAX_ROUTE_WEI);

    await bus.route();
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(total - 2n * MAX_ROUTE_WEI);

    // Third route: remaining is MAX_ROUTE_WEI + 0.5 ether, still > MAX_ROUTE_WEI,
    // so it caps again at MAX_ROUTE_WEI.
    await bus.route();
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(total - 3n * MAX_ROUTE_WEI);

    // Fourth route: remaining is exactly 0.5 ether (< MAX_ROUTE_WEI, > MIN),
    // fully drained in one call.
    await bus.route();
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(0n);
  });

  it("BUS-5: reentrancy on route is blocked", async () => {
    const { weth, bus, inv } = await deployFixture();
    const total = ethers.parseEther("1");
    await fund(weth, bus, total);

    await inv.armReenter(await bus.getAddress());

    // The adapter's mid-pipe attempt to re-enter route() hits the Bus's
    // nonReentrant guard (OZ: "ReentrancyGuard: reentrant call") and
    // reverts. That revert is caught by the Bus's per-pipe try/catch (same
    // path a hostile/broken adapter takes) so the outer route() call itself
    // completes rather than reverting the whole transaction — but the
    // reentrant call demonstrably never executed a second route(): only one
    // attempt was recorded, and no double-spend of the Bus's balance
    // occurred (routed exactly once, total spend accounted for).
    await expect(bus.route()).to.not.be.reverted;

    expect(await inv.reenterAttempts()).to.equal(1n);
    expect(await inv.callCount()).to.equal(1n);
    // The nonReentrant guard actually fired: the swallowed inner route()
    // call failed, it did not silently succeed a second time.
    expect(await inv.reenterSucceeded()).to.equal(false);
  });

  it("BUS-6: unauthorized adapter swap — no function exists to replace an adapter, before or after finalize", async () => {
    const { bus } = await deployFixture();
    const fragment = (bus.interface as any).fragments.find((f: any) => f.type === "function");
    const names = (bus.interface as any).fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const n of names) {
      expect(n.includes("setadapter")).to.equal(false);
      expect(n.includes("replaceadapter")).to.equal(false);
      expect(n.includes("swapadapter")).to.equal(false);
    }
    expect(fragment).to.not.equal(undefined);

    // Adapters are immutable getters returning the same addresses forever.
    const invBefore = await bus.invAdapter();
    await bus.finalize();
    const invAfter = await bus.invAdapter();
    expect(invBefore).to.equal(invAfter);
  });

  it("BUS-7: finalize — admin zeroed, bps frozen (immutable, unaffected by finalize)", async () => {
    const { bus, deployer } = await deployFixture();

    expect(await bus.finalized()).to.equal(false);
    expect(await bus.deployer()).to.equal(deployer.address);

    await bus.finalize();

    expect(await bus.finalized()).to.equal(true);
    expect(await bus.deployer()).to.equal(ethers.ZeroAddress);

    // bps are immutable constructor values; still readable and unchanged.
    expect(await bus.invBps()).to.equal(INV_BPS);
    expect(await bus.divBps()).to.equal(DIV_BPS);

    // Cannot finalize twice.
    await expect(bus.finalize()).to.be.revertedWithCustomError(bus, "AlreadyFinalized");
  });

  it("BUS-8: permissionless route — any address can call it, including a total stranger", async () => {
    const { weth, bus, stranger } = await deployFixture();
    await fund(weth, bus, ethers.parseEther("1"));

    await expect(bus.connect(stranger).route()).to.not.be.reverted;
  });

  it("bps sum must equal 10_000 at construction, else revert", async () => {
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const AdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
    const adapters = [];
    for (let i = 0; i < 6; i++) {
      adapters.push(await AdapterFactory.deploy(await weth.getAddress()));
    }
    const addrs = await Promise.all(adapters.map((a: any) => a.getAddress()));

    const EnergyBusFactory = await ethers.getContractFactory("EnergyBus");
    await expect(
      EnergyBusFactory.deploy(
        await weth.getAddress(),
        addrs,
        [INV_BPS, CLP_BPS, IDX_BURN_BPS, PLANK_BURN_BPS, PLANK_LP_BPS, DIV_BPS + 1n] // sum now 10_001
      )
    ).to.be.revertedWithCustomError(EnergyBusFactory, "BpsSumInvalid");
  });

  it("TRUSTED_CAP_BPS is hard-coded to 0 (no spendable team treasury in the Bus)", async () => {
    const { bus } = await deployFixture();
    expect(await bus.TRUSTED_CAP_BPS()).to.equal(0n);
  });
});
