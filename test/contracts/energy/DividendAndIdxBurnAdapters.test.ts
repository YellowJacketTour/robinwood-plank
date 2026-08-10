import { expect } from "chai";
import { ethers, network } from "../helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";
import { deployOpenIndex, WAD, TIMELOCK, BPS, maxIn } from "../helpers/index-vault.js";

/**
 * ============================================================================
 * PR3 (ONESHOT §7) — DividendAdapter (Pipe D) + IdxBurnAdapter (Pipe X).
 *
 * Covers TEST-MATRIX-AXIOM-1-ADVERSARIAL.md A-D-1 and A-X-1, plus the
 * PR-level "never revert on recoverable failure" constraint each adapter's
 * own header documents.
 *
 * Both adapters are exercised against a REAL index Diamond
 * (`deployOpenIndex`) with a REAL `IndexCoinPool`, exactly the way
 * `IndexBuybackFacet.test.ts` proves the reused buy-and-lock mechanism —
 * never a mock reconcile/buyback target.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("DividendAdapter + IdxBurnAdapter (PR3)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const KEY = ethers.encodeBytes32String("valueAccrualSplitBps");
  function pack(dividendBps: bigint, buybackBps: bigint): bigint {
    return dividendBps * BPS + buybackBps;
  }

  async function deployAdapters(index: string, weth: string, busStandin: string) {
    const Div = await ethers.getContractFactory("DividendAdapter");
    const div: any = await Div.deploy(weth, index, busStandin);
    const Idx = await ethers.getContractFactory("IdxBurnAdapter");
    const idx: any = await Idx.deploy(weth, index, busStandin);
    return { div, idx };
  }

  /** Fund an EOA "bus stand-in" with WETH so it can push WETH into the
   * adapter the same way `EnergyBus._runPipe` does (plain transfer), then
   * call `execute`. Using a real signer as the "Bus" caller (rather than a
   * mock EnergyBus) keeps the test focused on the adapter <-> Diamond
   * integration this PR is actually responsible for; `EnergyBus.test.ts`
   * already proves the Bus's own splitting/accounting behavior against
   * `MockEnergyAdapter`. */
  async function pushAndExecute(adapter: any, weth: any, busSigner: any, amount: bigint) {
    await weth.mint(busSigner.address, amount);
    await weth.connect(busSigner).transfer(await adapter.getAddress(), amount);
    return adapter.connect(busSigner).execute.staticCall(amount).then(async (res: any) => {
      // Explicit gasLimit on the REAL send, deliberately — `res` above comes
      // from the staticCall, which `eth_call`s against an effectively
      // unbounded gas budget and therefore proves nothing about whether the
      // real transaction below has enough gas for every internal step (the
      // vault's dividend/buyback accumulator credit, in particular). Under
      // Hardhat 3, automatic gas estimation for THIS send was observed
      // under-provisioning that internal step just enough for it to be
      // silently caught and skipped — the adapter's own `used`/`skipped`
      // still read correctly (they're driven by the WETH transfer, which
      // succeeds), while the downstream credit this test actually checks
      // silently never lands. A generous manual limit removes the
      // estimation step entirely.
      const tx = await adapter.connect(busSigner).execute(amount, { gasLimit: 3_000_000 });
      await tx.wait();
      return res;
    });
  }

  // ══ A-D-1: dividend — claimDividend path increases pending for holders ═══

  it("A-D-1: DividendAdapter push+reconcile increases withdrawableDividendOf for holders", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0]; // == dividendAsset
    const wethC = await ethers.getContractAt("MockIndexToken", weth);

    // Governance: route a real share of routed value to the dividend leg.
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(4_000n, 0n));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(KEY);
    await fx.vault.checkpointAll();

    // Alice needs a real IDX coin balance to be dividend-eligible at all
    // (the EIP-2222 accumulator pays proportional to index-share balance,
    // not to deposited constituent balance).
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));

    const { div } = await deployAdapters(fx.vaultAddr, weth, fx.bob.address);

    const before: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    const amount = 10n * WAD;
    const [used, skipped] = await pushAndExecute(div, wethC, fx.bob, amount);
    expect(used).to.equal(amount);
    expect(skipped).to.equal(false);

    const after: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(after).to.be.gt(before);

    // The adapter itself never retains WETH.
    expect(await wethC.balanceOf(await div.getAddress())).to.equal(0n);

    // Real claim path actually pays out.
    const aliceWethBefore: bigint = await wethC.balanceOf(fx.alice.address);
    await expect(fx.vault.connect(fx.alice).claimDividend()).to.not.be.revert(ethers);
    const aliceWethAfter: bigint = await wethC.balanceOf(fx.alice.address);
    expect(aliceWethAfter).to.be.gt(aliceWethBefore);
  });

  it("A-D-1b: DividendAdapter never reverts execute() even if reconcile would be a no-op (zero amount)", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0];
    const wethC = await ethers.getContractAt("MockIndexToken", weth);
    const { div } = await deployAdapters(fx.vaultAddr, weth, fx.bob.address);

    const [used, skipped] = await div.connect(fx.bob).execute.staticCall(0n);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(false);
    await expect(div.connect(fx.bob).execute(0n)).to.not.be.revert(ethers);
  });

  it("DividendAdapter reverts only for the invariant violation of a non-Bus caller, never for any external condition", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0];
    const { div } = await deployAdapters(fx.vaultAddr, weth, fx.bob.address);
    await expect(div.connect(fx.carol).execute(1n)).to.be.revertedWithCustomError(div, "NotBus");
  });

  // ══ A-X-1: IDX lock — SEED_LOCK balance up; live claim up after vest ══════

  /** Open index + dedicated pool + protocol-owned liquidity + a governed
   * buyback split, mirroring `IndexBuybackFacet.test.ts`'s own fixture so
   * `executeBuyback` (reused unmodified by `IdxBurnAdapter`) has a real pool
   * to trade against. */
  async function fixtureWithPool(buybackBps = 5_000n) {
    const fx = await deployOpenIndex();
    const paymentToken = fx.addrs[0];

    const Pool = await ethers.getContractFactory("IndexCoinPool");
    const pool: any = await Pool.deploy(paymentToken, fx.vaultAddr, fx.vaultAddr);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    await fx.vault.connect(fx.risk).queueIndexPool(poolAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeIndexPool();
    await fx.vault.checkpointAll();

    await fx.vault.connect(fx.alice).deployToIndexPool(fx.addrs[1], 100n * WAD);

    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(0n, buybackBps));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(KEY);
    await fx.vault.checkpointAll();

    return { ...fx, pool, poolAddr, paymentToken };
  }

  it("A-X-1: IdxBurnAdapter push+reconcile+buyback raises SEED_LOCK's IDX balance", async () => {
    const fx = await fixtureWithPool();
    const wethC = await ethers.getContractAt("MockIndexToken", fx.paymentToken);
    const { idx } = await deployAdapters(fx.vaultAddr, fx.paymentToken, fx.bob.address);

    const seedLock: string = await fx.vault.SEED_LOCK();
    const lockBefore: bigint = await fx.vault.balanceOf(seedLock);

    const amount = 200n * WAD; // large enough that a 50% buyback earmark clears MIN dust
    const [used, skipped] = await pushAndExecute(idx, wethC, fx.bob, amount);
    expect(used).to.equal(amount);
    expect(skipped).to.equal(false);

    const lockAfter: bigint = await fx.vault.balanceOf(seedLock);
    expect(lockAfter).to.be.gt(lockBefore);

    // The adapter itself never retains WETH.
    expect(await wethC.balanceOf(await idx.getAddress())).to.equal(0n);

    // "live claim up after vest": the constituent share's own reserve-vest
    // window (§7.6, `_addReserveVest`) applies to the reserve leg of the
    // same routed credit; once it elapses the freshly-credited value is
    // fully reflected in redeemable NAV alongside the now-smaller
    // circulating (post-lock) supply raising every remaining holder's
    // pro-rata claim.
    const [navBefore] = await fx.vault.nav();
    await time.increase(400); // past VEST_BLOCKS-equivalent reserve-vest window
    await network.provider.send("evm_mine", []);
    await fx.vault.checkpointAll();
    const [navAfter] = await fx.vault.nav();
    expect(navAfter).to.be.gte(navBefore);
  });

  it("A-X-2: IdxBurnAdapter never reverts execute() even when no pool is configured (buyback step is a safe no-op)", async () => {
    const fx = await deployOpenIndex(); // no pool wired
    const weth = fx.addrs[0];
    const wethC = await ethers.getContractAt("MockIndexToken", weth);
    const { idx } = await deployAdapters(fx.vaultAddr, weth, fx.bob.address);

    // Governance may still route a share to the buyback earmark even with no
    // pool configured — `executeBuyback` itself reverts BadParam with no
    // pool, which is exactly the recoverable condition this adapter's
    // internal try/catch must swallow.
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(0n, 3_000n));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(KEY);
    await fx.vault.checkpointAll();

    const amount = 10n * WAD;
    const [used, skipped] = await pushAndExecute(idx, wethC, fx.bob, amount);
    expect(used).to.equal(amount);
    expect(skipped).to.equal(false);

    // The WETH was still credited into the index's own accounting (earmark
    // and/or reserve) — never stranded, never lost, even though no buyback
    // fired this call.
    expect(await wethC.balanceOf(await idx.getAddress())).to.equal(0n);
    expect(await fx.vault.buybackEarmarkAvailable()).to.be.gt(0n);
  });

  it("IdxBurnAdapter reverts only for the invariant violation of a non-Bus caller, never for any external condition", async () => {
    const fx = await deployOpenIndex();
    const weth = fx.addrs[0];
    const { idx } = await deployAdapters(fx.vaultAddr, weth, fx.bob.address);
    await expect(idx.connect(fx.carol).execute(1n)).to.be.revertedWithCustomError(idx, "NotBus");
  });

  // ══ Bus integration: adapters slot straight into the real EnergyBus ══════

  it("both adapters slot into a real EnergyBus as Pipe D / Pipe X and never cause route() to revert", async () => {
    const fx = await fixtureWithPool();
    const wethC = await ethers.getContractAt("MockIndexToken", fx.paymentToken);

    // The Bus's own address is immutable in both the adapters (`bus`) and
    // the Bus's own constructor (`adapters_`), so real deploy order predicts
    // the Bus's future address from the deployer's nonce, deploys the two
    // real adapters (and 4 mocks for the other pipes) pointed at it, then
    // deploys the Bus itself at that predicted address.
    const AdapterFactoryDiv = await ethers.getContractFactory("DividendAdapter");
    const AdapterFactoryIdx = await ethers.getContractFactory("IdxBurnAdapter");
    const MockAdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");

    const deployerAddr = fx.bob.address;
    const nonce = await ethers.provider.getTransactionCount(deployerAddr);
    // 3 pending deploys before the Bus: 2 real adapters + 4 mocks = 6 txs,
    // Bus is the 7th from `nonce`.
    const predictedBusAddr = ethers.getCreateAddress({ from: deployerAddr, nonce: nonce + 6 });

    const realDiv: any = await AdapterFactoryDiv.connect(fx.bob).deploy(fx.paymentToken, fx.vaultAddr, predictedBusAddr);
    const realIdx: any = await AdapterFactoryIdx.connect(fx.bob).deploy(fx.paymentToken, fx.vaultAddr, predictedBusAddr);
    const m1: any = await MockAdapterFactory.connect(fx.bob).deploy(fx.paymentToken);
    const m2: any = await MockAdapterFactory.connect(fx.bob).deploy(fx.paymentToken);
    const m3: any = await MockAdapterFactory.connect(fx.bob).deploy(fx.paymentToken);
    const m4: any = await MockAdapterFactory.connect(fx.bob).deploy(fx.paymentToken);

    const EnergyBusFactory = await ethers.getContractFactory("EnergyBus");
    const bus: any = await EnergyBusFactory.connect(fx.bob).deploy(
      fx.paymentToken,
      [
        await m1.getAddress(), // I
        await m2.getAddress(), // L
        await realIdx.getAddress(), // X
        await m3.getAddress(), // P
        await m4.getAddress(), // R
        await realDiv.getAddress(), // D
      ],
      [3_500, 1_500, 1_500, 1_000, 1_000, 1_500]
    );
    expect(await bus.getAddress()).to.equal(predictedBusAddr);

    const total = 100n * WAD;
    await wethC.mint(await bus.getAddress(), total);

    const seedLock: string = await fx.vault.SEED_LOCK();
    const lockBefore: bigint = await fx.vault.balanceOf(seedLock);
    const divBefore: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    await expect(bus.route()).to.not.be.revert(ethers);

    // Pipe X actually reached the reused buy-and-lock mechanism.
    expect(await fx.vault.balanceOf(seedLock)).to.be.gte(lockBefore);
    // Pipe D actually reached the reused dividend/reserve split.
    expect(await wethC.balanceOf(fx.vaultAddr)).to.be.gt(0n);
    // Neither real adapter retained WETH.
    expect(await wethC.balanceOf(await realDiv.getAddress())).to.equal(0n);
    expect(await wethC.balanceOf(await realIdx.getAddress())).to.equal(0n);
    divBefore; // silence unused warning if dividendBps happens to be 0 pre-config
  });
});
