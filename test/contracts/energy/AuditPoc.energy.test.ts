import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * AUDIT PROOF-OF-CONCEPT — added by a pre-deployment security audit pass.
 *
 * PoC-1 still asserts the C-1 bug shape ON A MOCK ADAPTER (see its own note).
 * PoC-2 and PoC-3 have been INVERTED, not deleted, as Phase 1 closed C-2:
 * they now assert the FIX using the same fixtures and the same measured
 * quantities that proved the bug, so the coverage survives the fix and the
 * numbers stay directly comparable to the audit report.
 */
describe("AUDIT PoC — EnergyBus / adapters", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n;

  // ────────────────────────────────────────────────────────────────────
  // PoC 1 — permanent route() DoS via an unsolicited WETH donation to any
  // adapter that refunds `weth.balanceOf(address(this))`.
  // ────────────────────────────────────────────────────────────────────
  it("PoC-1 (FIXED): 1 WETH donated to PlankBurnAdapter no longer bricks EnergyBus.route()", async () => {
    const [deployer, gov, attacker] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const router: any = await (await ethers.getContractFactory("MockExternalSwapRouter")).deploy(
      ethers.parseEther("1")
    );

    const AdapterF = await ethers.getContractFactory("MockEnergyAdapter");
    const inv: any = await AdapterF.deploy(wethAddr);
    const clp: any = await AdapterF.deploy(wethAddr);
    const idx: any = await AdapterF.deploy(wethAddr);
    const plankLp: any = await AdapterF.deploy(wethAddr);
    const div: any = await AdapterF.deploy(wethAddr);

    // Predict the Bus address: PlankBurnAdapter is deployed at nonce N, the
    // Bus at nonce N+1.
    const n = await ethers.provider.getTransactionCount(deployer.address);
    const predictedBus = ethers.getCreateAddress({ from: deployer.address, nonce: n + 1 });

    const plankBurn: any = await (await ethers.getContractFactory("PlankBurnAdapter")).deploy(
      wethAddr,
      predictedBus,
      gov.address,
      0
    );
    const bus: any = await (await ethers.getContractFactory("EnergyBus")).deploy(
      wethAddr,
      [
        await inv.getAddress(),
        await clp.getAddress(),
        await idx.getAddress(),
        await plankBurn.getAddress(),
        await plankLp.getAddress(),
        await div.getAddress(),
      ],
      [3500n, 1500n, 1500n, 1000n, 1000n, 1500n]
    );
    expect(await bus.getAddress()).to.equal(predictedBus);

    // Configure the PLANK router (timelock delay 0) and make it fail — the
    // realistic "external venue reverts" state.
    await plankBurn.connect(gov).queueRouter(await router.getAddress());
    await plankBurn.executeRouter();
    await router.setMode(1); // REVERT

    // Baseline: route() works.
    await weth.mint(await bus.getAddress(), ethers.parseEther("1"));
    await expect(bus.route()).to.not.be.reverted;

    // ATTACK: attacker donates 1 WETH directly to the adapter address.
    await weth.mint(attacker.address, ethers.parseEther("1"));
    await weth.connect(attacker).transfer(await plankBurn.getAddress(), ethers.parseEther("1"));

    // INVERTED (C-1 closed). Pre-fix, `beforeBal - afterBal <= amount ?
    // beforeBal - afterBal : amount` evaluated the subtraction INSIDE the
    // ternary condition, so a donation that made `afterBal > beforeBal`
    // panicked on underflow — outside the try/catch, so ALL of route()
    // reverted, permanently, on an immutable contract with no rescue path.
    // The clamp is now `afterBal >= beforeBal ? 0 : beforeBal - afterBal`,
    // and every adapter caps its refund at `min(balance, amountIn)`.
    await weth.mint(await bus.getAddress(), ethers.parseEther("1"));
    await expect(bus.route()).to.not.be.reverted;
    await weth.mint(await bus.getAddress(), ethers.parseEther("5"));
    await expect(bus.route()).to.not.be.reverted;

    // The Bus drains normally: the donation became protocol value instead of
    // a weapon, and nothing is stranded behind a permanent revert.
    expect(await weth.balanceOf(await bus.getAddress())).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────────────
  // PoC 2 — INVERTED. Was: "buys at >80% price impact and MAX_IMPACT_BPS
  // passes it". Now: the inert guard is gone and a depth-adaptive leg cap
  // plus a real minSharesOut hold the executed impact to a bounded figure.
  // ────────────────────────────────────────────────────────────────────
  it("PoC-2 (FIXED): a 500 WETH slice into a 50 WETH pool no longer buys at 90% impact — the leg is capped to pool depth", async () => {
    const [deployer, treasury, alice, busEoa] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (await ethers.getContractFactory("CollectionVaultFactory")).deploy(
      treasury.address,
      wethAddr,
      TIMELOCK
    );
    const vaultAddr: string = await factory.deployVault.staticCall(
      await nft.getAddress(),
      treasury.address,
      SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), treasury.address, SINK_BPS);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    // Open the pool: 50 WETH / 1 S seeded.
    await weth.mint(alice.address, ethers.parseEther("500"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    for (let i = 1; i <= 3; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
    }
    await vault.connect(alice).deposit(1);
    const seed = ethers.parseEther("50");
    await weth.mint(treasury.address, seed);
    await weth.connect(treasury).approve(vaultAddr, seed);
    await vault.connect(treasury).seedLiquidity(seed);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();

    const wm: any = await (await ethers.getContractFactory("MockWeightModuleWeights")).deploy(
      vaultAddr,
      10_000n
    );
    const index: any = await (await ethers.getContractFactory("MockIndexEnergyCredit")).deploy();
    const adapter: any = await (await ethers.getContractFactory("InventoryBuyAdapter")).deploy(
      wethAddr,
      await index.getAddress(),
      busEoa.address,
      await wm.getAddress()
    );

    const pr0: bigint = await vault.paymentReserve();
    const sr0: bigint = await vault.shareReserve();

    // Adapter spends 500 WETH into a 50-WETH pool — a ~10x-reserve trade.
    const amount = ethers.parseEther("500");
    await weth.mint(busEoa.address, amount);
    await weth.connect(busEoa).transfer(await adapter.getAddress(), amount);
    const [used, skipped] = await adapter.connect(busEoa).execute.staticCall(amount);
    await adapter.connect(busEoa).execute(amount);

    // The leg still fills — Pipe I must never brick — but it fills SMALL.
    expect(skipped).to.equal(false);

    // MAX_LEG_POOL_FRACTION_BPS = 200 => at most 2% of the pool's 50 WETH
    // payment reserve, i.e. 1 WETH, regardless of the 500 WETH budget.
    // PRE-FIX this was `used == amount` (the full 500 WETH).
    const maxLeg = (pr0 * 200n) / 10_000n;
    expect(used).to.equal(maxLeg);
    expect(used).to.be.lt(amount / 100n);

    // Every unspent wei went straight back to the Bus — nothing stranded.
    const busRefund: bigint = await weth.balanceOf(busEoa.address);
    expect(busRefund).to.equal(amount - used);

    const sharesBought: bigint = await vault.balanceOf(await index.getAddress());
    expect(sharesBought).to.be.gt(0n);

    // True price impact vs the PRE-TRADE spot price, measured EXACTLY as the
    // audit measured it. The audit recorded 9,092 bps here.
    const fairSharesAtSpot = (used * sr0) / pr0;
    const impactBps = ((fairSharesAtSpot - sharesBought) * 10_000n) / fairSharesAtSpot;
    console.log(`   >> true price impact now = ${impactBps} bps (audit measured 9092 bps)`);
    expect(impactBps).to.be.lt(500n);

    // And the guard that could never fire is genuinely GONE from the ABI —
    // not repaired, deleted, per DESIGN-HONEST-INDEX §1.3.
    const inv = await ethers.getContractFactory("InventoryBuyAdapter");
    const names = inv.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name);
    expect(names).to.not.include("MAX_IMPACT_BPS");
    expect(names).to.include("MAX_LEG_POOL_FRACTION_BPS");
  });

  it("PoC-2b (FIXED): buyShares now receives a REAL minSharesOut derived from quoteBuyShares", async () => {
    // The audit's second half of C-2: `buyShares(budget, 0)` meant there was
    // no slippage defence at all. This proves the adapter now transacts
    // against the vault's own realizable quote by making the vault's fill
    // deliberately worse than its quote — the leg must then soft-fail rather
    // than accept the short fill.
    const [deployer, treasury, alice, busEoa] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();
    const shortVault: any = await (
      await ethers.getContractFactory("MockShortFillVault")
    ).deploy(wethAddr, 9_000n); // fills at 90% of its own quote (1000 bps short)

    const wm: any = await (await ethers.getContractFactory("MockWeightModuleWeights")).deploy(
      await shortVault.getAddress(),
      10_000n
    );
    const index: any = await (await ethers.getContractFactory("MockIndexEnergyCredit")).deploy();
    const adapter: any = await (await ethers.getContractFactory("InventoryBuyAdapter")).deploy(
      wethAddr,
      await index.getAddress(),
      busEoa.address,
      await wm.getAddress()
    );

    const amount = ethers.parseEther("10");
    await weth.mint(busEoa.address, amount);
    await weth.connect(busEoa).transfer(await adapter.getAddress(), amount);

    const [used, skipped] = await adapter.connect(busEoa).execute.staticCall(amount);
    await adapter.connect(busEoa).execute(amount);

    // A fill 1000 bps below the pre-trade quote breaches QUOTE_TOLERANCE_BPS
    // (50), so `buyShares` reverts on its own minSharesOut check, the leg
    // unwinds atomically, and the whole budget returns to the Bus.
    // PRE-FIX (minSharesOut = 0) this short fill was accepted silently.
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);
    expect(await weth.balanceOf(busEoa.address)).to.equal(amount);

    // And a vault that honours its own quote is still bought from normally.
    await shortVault.setFillBps(10_000n);
    await weth.mint(busEoa.address, amount);
    await weth.connect(busEoa).transfer(await adapter.getAddress(), amount);
    const [used2] = await adapter.connect(busEoa).execute.staticCall(amount);
    expect(used2).to.be.gt(0n);
  });

  // ────────────────────────────────────────────────────────────────────
  // PoC 3 — INVERTED. Was: "sandwiching a permissionless route() is
  // atomically profitable" (audit measured +2.686 WETH on a 3.5 WETH slice,
  // 77%). Now: the same search over front-run sizes must not find a
  // materially profitable sandwich, because the leg's spend is capped at
  // MAX_LEG_POOL_FRACTION_BPS of live pool depth.
  //
  // HONEST SCOPE OF THIS PROOF. This bounds the sandwich; it does not
  // abolish it. A same-transaction `quoteBuyShares` is read AFTER the
  // front-run, so the minSharesOut it yields is satisfiable by construction
  // and cannot be what defends us — see InventoryBuyAdapter's own constants,
  // which say so in the source. What defends us is trade SIZE relative to
  // depth: sandwich profit scales with (victim size)^2 / depth, so capping
  // the victim at 2% of depth caps extraction near 2% of the slice.
  // ────────────────────────────────────────────────────────────────────
  it("PoC-3 (FIXED): sandwiching a permissionless route() is no longer materially profitable", async () => {
    const [deployer, treasury, alice, busEoa, attacker] = await ethers.getSigners();

    async function build() {
      const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
      const wethAddr = await weth.getAddress();
      const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
      const factory: any = await (await ethers.getContractFactory("CollectionVaultFactory")).deploy(
        treasury.address,
        wethAddr,
        TIMELOCK
      );
      const vaultAddr: string = await factory.deployVault.staticCall(
        await nft.getAddress(),
        treasury.address,
        810n // FLOOR_SINK_SPLIT_BPS — attacker picks the cheapest sink
      );
      await factory.deployVault(await nft.getAddress(), treasury.address, 810n);
      const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
      await weth.mint(alice.address, ethers.parseEther("100"));
      await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
      for (let i = 1; i <= 3; i++) {
        await nft.mint(alice.address, i);
        await nft.connect(alice).approve(vaultAddr, i);
      }
      await vault.connect(alice).deposit(1);
      const seed = ethers.parseEther("10");
      await weth.mint(treasury.address, seed);
      await weth.connect(treasury).approve(vaultAddr, seed);
      await vault.connect(treasury).seedLiquidity(seed);
      await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
      await vault.connect(treasury).seedShares(ethers.parseEther("1"));
      await vault.connect(treasury).openPool();

      const wm: any = await (await ethers.getContractFactory("MockWeightModuleWeights")).deploy(
        vaultAddr,
        10_000n
      );
      const index: any = await (await ethers.getContractFactory("MockIndexEnergyCredit")).deploy();
      const adapter: any = await (await ethers.getContractFactory("InventoryBuyAdapter")).deploy(
        wethAddr,
        await index.getAddress(),
        busEoa.address,
        await wm.getAddress()
      );
      await weth.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
      return { weth, vault, vaultAddr, adapter };
    }

    // Pipe I slice at MAX_ROUTE_WEI: 35% of 10 WETH = 3.5 WETH, into a 10 WETH pool.
    const victim = ethers.parseEther("3.5");
    let best = -1n;
    let bestSize = 0n;
    for (const frontrunEth of ["1", "2", "4", "8", "16"]) {
      const f = await build();
      const frontrun = ethers.parseEther(frontrunEth);
      await f.weth.mint(attacker.address, frontrun);
      const start: bigint = await f.weth.balanceOf(attacker.address);

      await f.vault.connect(attacker).buyShares(frontrun, 0n);
      const sHeld: bigint = await f.vault.balanceOf(attacker.address);

      await f.weth.mint(busEoa.address, victim);
      await f.weth.connect(busEoa).transfer(await f.adapter.getAddress(), victim);
      await f.adapter.connect(busEoa).execute(victim); // the permissionless route()

      await f.vault.connect(attacker).sellShares(sHeld, 0n);
      const end: bigint = await f.weth.balanceOf(attacker.address);
      const pnl = end - start;
      console.log(`   >> frontrun ${frontrunEth} WETH -> attacker PnL ${ethers.formatEther(pnl)} WETH`);
      if (pnl > best) {
        best = pnl;
        bestSize = frontrun;
      }
    }
    console.log(
      `   >> BEST: frontrun ${ethers.formatEther(bestSize)} WETH nets ${ethers.formatEther(best)} WETH per route() ` +
        `(audit measured +2.686 WETH on this exact 3.5 WETH slice)`
    );
    // PRE-FIX this was `expect(best).to.be.gt(0n)` and measured +2.686 WETH,
    // 77% of the slice. The bound we can now genuinely defend: an attacker
    // cannot extract even 5% of the routed slice, at ANY front-run size in
    // the search — because the leg never takes more than 2% of live depth.
    const bound = (victim * 500n) / 10_000n;
    expect(best).to.be.lt(bound);
  });

  // ────────────────────────────────────────────────────────────────────
  // PoC 3b — the residual PoC-3 leaves behind, and its closure.
  //
  // Sizing against the LIVE reserve alone is not enough: a front-runner
  // inflates `paymentReserve`, which inflates our cap, so their extraction
  // grows with their own capital (visible in PoC-3's own log — 0.009 WETH at
  // a 1 WETH front-run rising to 0.152 WETH at 16 WETH). Measuring the cap
  // against `WeightModule.windowMinDepth` instead — a multi-hour MINIMUM that
  // nothing in the attacker's own block can move — makes the extraction stop
  // scaling with the attacker's capital entirely.
  // ────────────────────────────────────────────────────────────────────
  it("PoC-3b (FIXED): with the cap tied to windowed-minimum depth, sandwich extraction stops scaling with attacker capital", async () => {
    const [deployer, treasury, alice, busEoa, attacker] = await ethers.getSigners();

    async function build() {
      const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
      const wethAddr = await weth.getAddress();
      const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
      const factory: any = await (await ethers.getContractFactory("CollectionVaultFactory")).deploy(
        treasury.address,
        wethAddr,
        TIMELOCK
      );
      const vaultAddr: string = await factory.deployVault.staticCall(
        await nft.getAddress(),
        treasury.address,
        810n
      );
      await factory.deployVault(await nft.getAddress(), treasury.address, 810n);
      const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
      await weth.mint(alice.address, ethers.parseEther("100"));
      await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
      for (let i = 1; i <= 3; i++) {
        await nft.mint(alice.address, i);
        await nft.connect(alice).approve(vaultAddr, i);
      }
      await vault.connect(alice).deposit(1);
      const seed = ethers.parseEther("10");
      await weth.mint(treasury.address, seed);
      await weth.connect(treasury).approve(vaultAddr, seed);
      await vault.connect(treasury).seedLiquidity(seed);
      await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
      await vault.connect(treasury).seedShares(ethers.parseEther("1"));
      await vault.connect(treasury).openPool();

      // The honest, pre-manipulation depth the window has actually observed.
      const wm: any = await (await ethers.getContractFactory("MockWeightModuleCapped")).deploy(
        vaultAddr,
        10_000n,
        ethers.parseEther("10")
      );
      const index: any = await (await ethers.getContractFactory("MockIndexEnergyCredit")).deploy();
      const adapter: any = await (await ethers.getContractFactory("InventoryBuyAdapter")).deploy(
        wethAddr,
        await index.getAddress(),
        busEoa.address,
        await wm.getAddress()
      );
      await weth.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
      return { weth, vault, adapter };
    }

    const victim = ethers.parseEther("3.5");
    const pnls: bigint[] = [];
    for (const frontrunEth of ["1", "16"]) {
      const f = await build();
      const frontrun = ethers.parseEther(frontrunEth);
      await f.weth.mint(attacker.address, frontrun);
      const start: bigint = await f.weth.balanceOf(attacker.address);

      await f.vault.connect(attacker).buyShares(frontrun, 0n);
      const sHeld: bigint = await f.vault.balanceOf(attacker.address);

      await f.weth.mint(busEoa.address, victim);
      await f.weth.connect(busEoa).transfer(await f.adapter.getAddress(), victim);
      await f.adapter.connect(busEoa).execute(victim);

      await f.vault.connect(attacker).sellShares(sHeld, 0n);
      pnls.push((await f.weth.balanceOf(attacker.address)) - start);
      console.log(`   >> frontrun ${frontrunEth} WETH -> attacker PnL ${ethers.formatEther(pnls[pnls.length - 1])} WETH`);
    }

    // A 16x larger front-run must NOT buy a 16x larger extraction. With the
    // cap tied to live depth (PoC-3) it did, almost exactly. With the cap
    // tied to windowed-minimum depth our trade size is invariant to the
    // attacker's capital, so their extra capital only buys them extra swap
    // fees on their own round-trip.
    expect(pnls[1]).to.be.lte(pnls[0]);
    expect(pnls[1]).to.be.lt((victim * 100n) / 10_000n); // < 1% of the slice
  });
});
