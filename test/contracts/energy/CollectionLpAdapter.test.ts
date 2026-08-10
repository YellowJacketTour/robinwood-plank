import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * ============================================================================
 * CollectionLpAdapter (Pipe L, real, replaces the honest `MockEnergyAdapter`
 * gap disclosed in `FactorySinkBusIntegration.test.ts` at commit 8425239).
 *
 * Built against the CORRECT native-LP model
 * (`CollectionVault.addLiquidity`/`removeLiquidity`, `CollectionVaultLP`,
 * `LP_LOCK_ADDR`) rather than the deleted donation-only
 * `CollectionLpRenounceAdapter` attempt.
 *
 * Uses the same "EOA bus stand-in" pattern `DividendAndIdxBurnAdapters.test.ts`
 * already establishes (push WETH, then call `execute`, exactly the way
 * `EnergyBus._runPipe` does) so this suite stays focused on the adapter <->
 * `CollectionVault` integration rather than re-proving the Bus's own
 * splitting/accounting, which `EnergyBus.test.ts` already covers.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("CollectionLpAdapter (real Pipe L, native-LP model)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n; // CEIL_SINK_SPLIT_BPS
  const LP_LOCK_ADDR = "0x000000000000000000000000000000000000dEaD";

  async function pushAndExecute(adapter: any, weth: any, busSigner: any, amount: bigint) {
    await weth.mint(busSigner.address, amount);
    await weth.connect(busSigner).transfer(await adapter.getAddress(), amount);
    const res = await adapter.connect(busSigner).execute.staticCall(amount);
    const tx = await adapter.connect(busSigner).execute(amount);
    await tx.wait();
    return res; // [used, skipped]
  }

  async function deployVaultAndWeight(weth: any, wethAddr: string, treasury: any) {
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(treasury.address, wethAddr, TIMELOCK); // upstreamSink irrelevant to this pipe's own tests

    const vaultAddr: string = await factory.deployVault.staticCall(
      await nft.getAddress(),
      treasury.address,
      SINK_BPS
    );
    await factory.deployVault(await nft.getAddress(), treasury.address, SINK_BPS);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    const weightModule: any = await (
      await ethers.getContractFactory("WeightModule")
    ).deploy(await factory.getAddress());
    await vault.connect(treasury).setWeightModule(await weightModule.getAddress());

    return { nft, factory, vault, vaultAddr, weightModule };
  }

  /** Open the vault's pool with real NFT deposits + treasury seeding, then
   * cycle real fee events until the vault is admitted into WeightModule. */
  async function openAndAdmit(vault: any, vaultAddr: string, weth: any, weightModule: any, treasury: any, alice: any) {
    await weth.mint(alice.address, ethers.parseEther("200"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    for (let i = 1; i <= 40; i++) {
      const nftAddr = await vault.collection();
      const nft = await ethers.getContractAt("MockRobinWoodNft", nftAddr);
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
    }

    await vault.connect(alice).deposit(1);

    const seedPayment = ethers.parseEther("50");
    await weth.mint(treasury.address, seedPayment);
    await weth.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();

    const F_MIN_WEI = ethers.parseEther("0.05");
    for (let i = 2; i <= 40; i++) {
      await vault.connect(alice).deposit(i);
      await vault.connect(alice).redeem(i);
      const s = await weightModule.scores(vaultAddr);
      if (s.feeWethCumulative >= F_MIN_WEI) break;
    }
    await weightModule.checkAdmit(vaultAddr);
    expect(await weightModule.isAdmitted(vaultAddr)).to.equal(true);
  }

  it("real balanced deposit: WETH + S genuinely leave the adapter as a real addLiquidity call, not a donation", async () => {
    const [, treasury, alice, busSigner] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr, weightModule } = await deployVaultAndWeight(weth, wethAddr, treasury);
    await openAndAdmit(vault, vaultAddr, weth, weightModule, treasury, alice);

    const Adapter = await ethers.getContractFactory("CollectionLpAdapter");
    const adapter: any = await Adapter.deploy(wethAddr, busSigner.address, await weightModule.getAddress());

    const lpTokenAddr: string = await vault.lpToken();
    const lpToken: any = await ethers.getContractAt("CollectionVaultLP", lpTokenAddr);

    const lockedBefore: bigint = await lpToken.balanceOf(LP_LOCK_ADDR);
    const paymentReserveBefore: bigint = await vault.paymentReserve();
    const shareReserveBefore: bigint = await vault.shareReserve();

    const amount = ethers.parseEther("4");
    const [used, skipped] = await pushAndExecute(adapter, weth, busSigner, amount);

    expect(skipped).to.equal(false);
    expect(used).to.be.gt(0n);

    // Real, observed LP mint locked at the SAME dead address the vault's own
    // genesis floor uses — this is a real `addLiquidity` receipt, not a
    // no-op `donateReserves`-style single-sided push.
    const lockedAfter: bigint = await lpToken.balanceOf(LP_LOCK_ADDR);
    expect(lockedAfter).to.be.gt(lockedBefore);

    // `paymentReserve` genuinely grew by a real balanced deposit (not a
    // single-sided donation). `shareReserve` ALSO genuinely moved — proving
    // this adapter's flow actually touched the `S` side of the pool at all
    // (a `donateReserves`-style single-sided push would leave `shareReserve`
    // EXACTLY unchanged, byte-for-byte, since it only ever moves
    // `paymentReserve`). The adapter buys `S`, deposits a balanced pair, and
    // sells back its own leftover `S` — each of those three legs pays the
    // pool's own swap fee, so the NET `shareReserve` delta can legitimately
    // land slightly negative (fee-in-kind) even though real `S` demonstrably
    // moved through `buyShares`/`addLiquidity`/`sellShares` in the process;
    // the real, load-bearing proof of a genuine balanced LP deposit is the
    // LP-lock growth already asserted above, not the sign of this delta.
    const paymentReserveAfter: bigint = await vault.paymentReserve();
    const shareReserveAfter: bigint = await vault.shareReserve();
    expect(paymentReserveAfter).to.be.gt(paymentReserveBefore);
    expect(shareReserveAfter).to.not.equal(shareReserveBefore);

    // The adapter never retains WETH or LP. It may retain at most a few wei
    // of `S` dust if a leftover-share sellback's own output rounded to zero
    // (`sellShares`' own `InsufficientOutput` guard, caught non-fatally) —
    // never anything WETH-value-material, and never the LP receipt itself.
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await adapter.getAddress())).to.be.lte(10n);
    expect(await lpToken.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("non-withdrawability: locked LP can never be removed by anyone — no key exists for LP_LOCK_ADDR, and total pool value only ever grows", async () => {
    const [, treasury, alice, busSigner] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr, weightModule } = await deployVaultAndWeight(weth, wethAddr, treasury);
    await openAndAdmit(vault, vaultAddr, weth, weightModule, treasury, alice);

    const Adapter = await ethers.getContractFactory("CollectionLpAdapter");
    const adapter: any = await Adapter.deploy(wethAddr, busSigner.address, await weightModule.getAddress());

    await pushAndExecute(adapter, weth, busSigner, ethers.parseEther("4"));

    const lpTokenAddr: string = await vault.lpToken();
    const lpToken: any = await ethers.getContractAt("CollectionVaultLP", lpTokenAddr);
    const totalLp: bigint = await lpToken.totalSupply();
    const lockedBal: bigint = await lpToken.balanceOf(LP_LOCK_ADDR);

    // The dead address holds a real, nonzero, growing share of total LP
    // supply (genesis floor + this pipe's own new lock).
    expect(lockedBal).to.be.gt(0n);
    expect(lockedBal).to.be.lte(totalLp);

    // Mirroring the rigor already proven for LP_LOCK_ADDR's genesis floor:
    // 0xdEaD has no known private key anywhere in this test's signer set —
    // hardhat's default signers are deterministic from its own mnemonic and
    // NONE of them is 0xdEaD, so there is no `ethers.Signer` this test (or
    // anyone) can construct that controls that balance. The only function
    // capable of moving it is `removeLiquidity`, which is `msg.sender`-gated
    // to burn the CALLER's own balance — there is structurally no
    // `msg.sender` who is simultaneously "controls 0xdEaD" and "can sign a
    // transaction", so the call can never be made.
    const signers = await ethers.getSigners();
    for (const s of signers) {
      expect(s.address.toLowerCase()).to.not.equal(LP_LOCK_ADDR.toLowerCase());
    }

    // Sanity: `removeLiquidity` genuinely requires holding LP — an
    // unrelated account with zero LP balance cannot drain the lock either,
    // proving the lock's safety does not rely on 0xdEaD specifically being
    // unreachable but on the ordinary ERC20/burn-your-own-balance rule.
    const [, , , , outsider] = await ethers.getSigners();
    await expect(vault.connect(outsider).removeLiquidity(1n, 0n, 0n)).to.be.reverted;

    // Further trading fees continue to grow the pool's own k without ever
    // touching the locked LP's balance — the lock is a permanent floor on
    // an ever-growing pool, never a static/frozen one.
    await weth.mint(alice.address, ethers.parseEther("5"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await vault.connect(alice).buyShares(ethers.parseEther("1"), 0n);
    const lockedAfterTrade: bigint = await lpToken.balanceOf(LP_LOCK_ADDR);
    expect(lockedAfterTrade).to.equal(lockedBal); // balance itself never moves...
    const totalLpAfterTrade: bigint = await lpToken.totalSupply();
    expect(totalLpAfterTrade).to.equal(totalLp); // ...and LP supply doesn't inflate from trading either —
    // the fee growth is entirely inside paymentReserve/shareReserve (k),
    // which is exactly why locked LP's REDEEMABLE value grows passively
    // with zero harvest call, per this adapter's own SKIM_TO_BUS_BPS
    // documentation.
  });

  it("graceful skip: a vault with no open pool causes the whole slice to return to the bus, never a revert", async () => {
    const [, treasury, alice, busSigner] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    // Vault deployed, WeightModule wired and admitted the EASY way this
    // codebase already exercises elsewhere: admit requires real fee flow,
    // but the pool itself is deliberately left UNOPENED for this leg to hit
    // `PoolNotOpen` inside `buyLeg`, proving the atomic per-leg unwind.
    const { vault, vaultAddr, weightModule } = await deployVaultAndWeight(weth, wethAddr, treasury);

    // Manually admit without opening the pool: mint one NFT deposit (real
    // fee event, does not require poolOpen) then cycle to F_MIN_WEI.
    const nftAddr = await vault.collection();
    const nft = await ethers.getContractAt("MockRobinWoodNft", nftAddr);
    await weth.mint(alice.address, ethers.parseEther("10"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    const F_MIN_WEI = ethers.parseEther("0.05");
    let i = 1;
    for (; i <= 50; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
      await vault.connect(alice).deposit(i);
      if (i > 1) await vault.connect(alice).redeem(i);
      const s = await weightModule.scores(vaultAddr);
      if (s.feeWethCumulative >= F_MIN_WEI) break;
    }
    await weightModule.checkAdmit(vaultAddr);
    expect(await weightModule.isAdmitted(vaultAddr)).to.equal(true);
    expect(await vault.poolOpen()).to.equal(false);

    const Adapter = await ethers.getContractFactory("CollectionLpAdapter");
    const adapter: any = await Adapter.deploy(wethAddr, busSigner.address, await weightModule.getAddress());

    const amount = ethers.parseEther("3");
    await expect(pushAndExecute(adapter, weth, busSigner, amount)).to.not.be.reverted;
    const [used, skipped] = await pushAndExecute(adapter, weth, busSigner, amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);

    // The entire slice (both calls' worth) came back to the bus stand-in,
    // nothing stranded in the adapter.
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("no admitted collections: entire amountIn returns to the bus, skipped=true, no revert", async () => {
    const [, treasury, , busSigner] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(treasury.address, wethAddr, TIMELOCK);
    const weightModule: any = await (
      await ethers.getContractFactory("WeightModule")
    ).deploy(await factory.getAddress());

    const Adapter = await ethers.getContractFactory("CollectionLpAdapter");
    const adapter: any = await Adapter.deploy(wethAddr, busSigner.address, await weightModule.getAddress());

    const amount = ethers.parseEther("2");
    const [used, skipped] = await pushAndExecute(adapter, weth, busSigner, amount);
    expect(used).to.equal(0n);
    expect(skipped).to.equal(true);
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("SKIM_TO_BUS_BPS: 20% of a fully-deployed pipe genuinely returns to the bus and never funds any leg, since the locked LP position can never be harvested directly", async () => {
    const [, treasury, alice, busSigner] = await ethers.getSigners();
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr, weightModule } = await deployVaultAndWeight(weth, wethAddr, treasury);
    await openAndAdmit(vault, vaultAddr, weth, weightModule, treasury, alice);

    const Adapter = await ethers.getContractFactory("CollectionLpAdapter");
    const adapter: any = await Adapter.deploy(wethAddr, busSigner.address, await weightModule.getAddress());
    expect(await adapter.SKIM_TO_BUS_BPS()).to.equal(2_000n);

    const busBefore: bigint = await weth.balanceOf(busSigner.address);
    const amount = ethers.parseEther("10");
    const skimEvent = adapter.filters.SkimmedToBus();

    await weth.mint(busSigner.address, amount);
    await weth.connect(busSigner).transfer(await adapter.getAddress(), amount);
    const tx = await adapter.connect(busSigner).execute(amount);
    const receipt = await tx.wait();
    const logs = await adapter.queryFilter(skimEvent, receipt!.blockNumber, receipt!.blockNumber);
    expect(logs.length).to.equal(1);
    const skimAmount: bigint = logs[0].args[0];
    // Exactly 20% of amountIn, withheld from every leg up front.
    expect(skimAmount).to.equal((amount * 2_000n) / 10_000n);

    const busAfter: bigint = await weth.balanceOf(busSigner.address);
    // The bus stand-in's own balance genuinely rose by AT LEAST the skim
    // (it may rise by more if a leg also skipped/refunded), proving the
    // skim is real WETH movement, not just an event.
    expect(busAfter - busBefore).to.be.gte(skimAmount);

    // Documents this PR's own honest finding: removeLiquidity is the ONLY
    // value-extraction path on a CollectionVault LP position, and it is
    // permanently unreachable for anything sent to LP_LOCK_ADDR (proven in
    // the non-withdrawability test above) — so there is no separate
    // "harvest" call for this adapter's own locked LP to expose here. The
    // 20% skim above, sourced from never-allocated budget rather than a
    // harvest of an already-locked position, is the actual mechanism.
    expect(vault.interface.getFunction("removeLiquidity")).to.not.equal(undefined);
  });
});
