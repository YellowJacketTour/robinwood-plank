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

  // =====================================================================
  // AUDIT H-5 — the per-block CUMULATIVE rate limit.
  //
  // BUS-4 above proves a per-call cap. H-5's point is that a per-call cap on
  // a permissionless, unlimited-frequency function is a STEP SIZE, not a
  // limit. These tests bound the CUMULATIVE figure, which is the only figure
  // a sandwich cares about.
  //
  // Every test below states, in a comment, exactly how it goes RED if the
  // budget mechanism is deleted from EnergyBus.route(). If deleting the
  // mechanism leaves a test green, that test is proving nothing — which is
  // the meta-finding of this audit.
  // =====================================================================

  async function withAutomineOff(fn: () => Promise<void>) {
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await fn();
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  }

  it("BUS-9 (H-5, THE ATTACK): looping route() inside ONE transaction cannot exceed the per-block budget", async () => {
    const { weth, bus } = await deployFixture();
    const looper: any = await (await ethers.getContractFactory("EnergyRouteLooper")).deploy();

    // Far more than one block's budget sitting in the Bus — exactly the
    // situation an attacker waits for before opening a sandwich.
    const total = ethers.parseEther("100");
    await fund(weth, bus, total);

    const BUDGET = await bus.BLOCK_BUDGET_WEI();
    expect(BUDGET).to.equal(MAX_ROUTE_WEI);

    // 20 sequential (NOT reentrant) route() calls in a single transaction.
    // The nonReentrant guard is irrelevant here: each call returns before the
    // next begins. That is why H-5 survived BUS-5.
    const spent = await looper.loopRoute.staticCall(await bus.getAddress(), 20);

    // Executed for real, with an INDEPENDENT direct caller batched into the
    // very same block, to prove the budget is shared by the block rather than
    // per-caller or per-contract.
    await withAutomineOff(async () => {
      await looper.loopRoute(await bus.getAddress(), 20);
      await bus.route();
      await ethers.provider.send("evm_mine", []);
    });

    // GOES RED IF THE MECHANISM IS REMOVED: without the per-block budget,
    // each of the 20 calls takes MAX_ROUTE_WEI until the Bus is empty, so
    // `spent` is 100 WETH (10 calls x 10) and the balance below is 0. The
    // whole accumulated balance is extractable inside one sandwich.
    expect(spent).to.equal(BUDGET);
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(total - BUDGET);
  });

  it("BUS-10 (H-5): many separate transactions in ONE block share the same budget", async () => {
    const { weth, bus, deployer, stranger } = await deployFixture();
    const total = ethers.parseEther("100");
    await fund(weth, bus, total);

    const before = await weth.balanceOf(await bus.getAddress());

    // Batching route() calls into one block from two different senders is the
    // same attack without a helper contract (a searcher's bundle).
    await withAutomineOff(async () => {
      await bus.connect(deployer).route();
      await bus.connect(stranger).route();
      await bus.connect(deployer).route();
      await bus.connect(stranger).route();
      await ethers.provider.send("evm_mine", []);
    });

    // GOES RED IF THE MECHANISM IS REMOVED: four calls x 10 WETH = 40 WETH
    // routed in one block instead of 10.
    const after = await weth.balanceOf(await bus.getAddress());
    expect(before - after).to.equal(MAX_ROUTE_WEI);
  });

  it("BUS-11 (H-5): a partially-consumed budget grants only the remainder, and reports it", async () => {
    const { weth, bus, deployer } = await deployFixture();

    // Start with less than a full budget so the first route under-consumes.
    await fund(weth, bus, ethers.parseEther("6"));

    let secondRouteTx: any;
    await withAutomineOff(async () => {
      await bus.route(); // takes 6 (balance-limited), leaving 4 of budget
      await weth.mint(await bus.getAddress(), ethers.parseEther("100"));
      secondRouteTx = await bus.route(); // requests 10, may only have 4
      await ethers.provider.send("evm_mine", []);
    });
    await secondRouteTx.wait();

    // GOES RED IF THE MECHANISM IS REMOVED: with no budget the second call
    // takes a full MAX_ROUTE_WEI, so the block total is 16 WETH not 10, the
    // remaining balance is 90 not 96, and RouteBudgetLimited is never emitted
    // (the event does not even exist without the mechanism).
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(ethers.parseEther("96"));
    await expect(secondRouteTx)
      .to.emit(bus, "RouteBudgetLimited")
      .withArgs(deployer.address, ethers.parseEther("10"), ethers.parseEther("4"));
  });

  it("BUS-12 (H-5, GRIEFING): an exhausted budget is a NO-OP returning 0, never a revert", async () => {
    const { weth, bus, stranger } = await deployFixture();
    await fund(weth, bus, ethers.parseEther("100"));

    let secondTx: any;
    await withAutomineOff(async () => {
      await bus.route(); // consumes the whole block budget
      secondTx = await bus.connect(stranger).route(); // budget now 0
      await ethers.provider.send("evm_mine", []);
    });
    const rcpt = await secondTx.wait();

    // This is the anti-griefing property. If exhaustion reverted, anyone
    // could burn the block's budget to revert any transaction that
    // opportunistically calls route() inside a user action — turning a rate
    // limit into a general DoS amplifier. It must fail SOFT.
    //
    // GOES RED IF THE NO-OP BRANCH IS REPLACED BY A REVERT: status becomes 0
    // / the await throws.
    expect(rcpt.status).to.equal(1);
    await expect(secondTx).to.emit(bus, "RouteBudgetLimited").withArgs(stranger.address, MAX_ROUTE_WEI, 0n);
  });

  it("BUS-13 (H-5, ANTI-VACUITY CONTROL): legitimate routing is NOT blocked — the budget refills every block", async () => {
    const { weth, bus, inv, div } = await deployFixture();
    const total = ethers.parseEther("35");
    await fund(weth, bus, total);

    // Three ordinary keeper routes in three ordinary blocks (automine on, so
    // one block per transaction). A rate limit that blocked these would be a
    // denial of service dressed up as a fix, not a fix.
    for (let i = 1n; i <= 3n; i++) {
      // NOTE (real semantics, not a workaround): `eth_call` executes against
      // the LATEST block, so simulating route() in the same block a route
      // already landed in correctly reports that block's remaining budget.
      // Mine first so the simulation reflects the block the tx would land in.
      await ethers.provider.send("evm_mine", []);
      const spent = await bus.route.staticCall();
      expect(spent).to.equal(MAX_ROUTE_WEI); // full throughput, every block
      await bus.route();
      expect(await weth.balanceOf(await bus.getAddress())).to.equal(total - i * MAX_ROUTE_WEI);
    }

    // Fourth block drains the 5 WETH tail in one go, and the pipes really did
    // fire — this is not a suite that passes because nothing happened.
    await bus.route();
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(0n);
    expect(await inv.totalReceived()).to.be.gt(0n);
    expect(await div.totalReceived()).to.be.gt(0n);

    // And a small routine route, far under the budget, is completely
    // unaffected by the limit.
    await fund(weth, bus, ethers.parseEther("0.25"));
    await ethers.provider.send("evm_mine", []);
    expect(await bus.route.staticCall()).to.equal(ethers.parseEther("0.25"));
  });

  it("BUS-14 (H-5): blockBudgetRemaining() reports the live budget and refills across blocks", async () => {
    const { weth, bus } = await deployFixture();
    const BUDGET = await bus.BLOCK_BUDGET_WEI();

    expect(await bus.blockBudgetRemaining()).to.equal(BUDGET);

    await fund(weth, bus, ethers.parseEther("4"));
    await bus.route();

    // `eth_call` runs against the LATEST block — the very block the route
    // landed in — so it correctly reports 4 WETH already drawn there.
    // GOES RED IF THE MECHANISM IS REMOVED: the function does not exist; and
    // if the tally were not actually written, this reads BUDGET instead.
    expect(await bus.blockBudgetRemaining()).to.equal(BUDGET - ethers.parseEther("4"));

    // One block later the tally is stale-by-design and the budget is full
    // again with no clearing write. GOES RED IF THE REFILL IS REMOVED
    // (e.g. a cumulative-forever counter): this stays at 6.
    await ethers.provider.send("evm_mine", []);
    expect(await bus.blockBudgetRemaining()).to.equal(BUDGET);

    // Measure it mid-block instead, via a static call evaluated at the
    // pending state after a route lands in the current block.
    await fund(weth, bus, ethers.parseEther("100"));
    let observed = 0n;
    await withAutomineOff(async () => {
      const tx = await bus.route();
      await ethers.provider.send("evm_mine", []);
      const blk = (await tx.wait()).blockNumber;
      observed = await bus.blockBudgetRemaining({ blockTag: blk });
    });
    expect(observed).to.equal(0n);
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
