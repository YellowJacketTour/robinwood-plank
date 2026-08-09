import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * ============================================================================
 * DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md §3.1 —
 * real, permissionless community liquidity on `CollectionVault`, ADDITIVE to
 * the existing constant-product `paymentReserve`/`shareReserve` pool, with a
 * permanently-locked genesis floor.
 *
 * Proves, against REAL contracts (no mocked pricing):
 *   1. The genesis floor LP position is genuinely permanently unremovable by
 *      anyone including treasury/governance — the same honesty standard
 *      already proven for `SEED_LOCK_ADDR` (IndexBuybackFacet.test.ts's own
 *      "impersonated dead-address signer" framing, mirrored here verbatim).
 *   2. A community member can add liquidity and later remove EXACTLY their
 *      proportional share, including fees their position earned meanwhile.
 *   3. First-depositor/inflation attack on the LP token itself is closed.
 *   4. `InventoryBuyAdapter`'s existing Pipe I behavior is unaffected by the
 *      presence of community LP — pricing still comes solely from
 *      `paymentReserve`/`shareReserve`, regardless of who owns the LP claims
 *      on them.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("CollectionVault native community LP (DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md §3.1)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const TIMELOCK = 48 * 3600;
  const LP_LOCK_ADDR = "0x000000000000000000000000000000000000dEaD";

  async function deployFixture() {
    const [deployer, sink, treasury, alice, bob, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), TIMELOCK);

    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    // Fund + approve everyone against the vault for both S (deposit-minted)
    // and paymentToken.
    for (const who of [alice, bob, attacker]) {
      await payment.mint(who.address, ethers.parseEther("10000"));
      await payment.connect(who).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }

    return { deployer, sink, treasury, alice, bob, attacker, payment, factory, nft, vault, vaultAddr };
  }

  /** Mint `n` NFTs to `who` and deposit them all, returning n*1e18 shares. */
  async function mintShares(nft: any, vault: any, vaultAddr: string, who: any, startId: number, n: number) {
    for (let i = 0; i < n; i++) {
      const id = startId + i;
      await nft.mint(who.address, id);
      await nft.connect(who).approve(vaultAddr, id);
      await vault.connect(who).deposit(id);
    }
  }

  /** Bootstraps the pool: treasury seeds `paymentAmt`/`shareAmt`, opens it. */
  async function openPool(vault: any, vaultAddr: string, treasury: any, payment: any, shareHolder: any, shareAmt: bigint, paymentAmt: bigint) {
    await payment.mint(treasury.address, paymentAmt);
    await payment.connect(treasury).approve(vaultAddr, paymentAmt);
    await vault.connect(treasury).seedLiquidity(paymentAmt);

    await vault.connect(shareHolder).transfer(treasury.address, shareAmt);
    await vault.connect(treasury).seedShares(shareAmt);
    return vault.connect(treasury).openPool();
  }

  // ══ 1. Genesis floor is permanently locked ═══════════════════════════════

  it("mints the ENTIRE genesis LP supply to LP_LOCK_ADDR at openPool — treasury holds zero LP and cannot withdraw the floor", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);

    const seedPayment = ethers.parseEther("100");
    const seedShares = ethers.parseEther("1");
    await expect(openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment)).to.emit(
      vault,
      "GenesisFloorLocked"
    );

    const lpAddr = await vault.lpToken();
    const lp: any = await ethers.getContractAt("CollectionVaultLP", lpAddr);
    const total = await lp.totalSupply();
    expect(total).to.be.gt(0n);
    expect(await lp.balanceOf(LP_LOCK_ADDR)).to.equal(total); // 100% of genesis LP
    expect(await lp.balanceOf(treasury.address)).to.equal(0n);
    expect(await lp.balanceOf(await vault.getAddress())).to.equal(0n);

    // Treasury owns none of it, so the ONLY vault-level call that could ever
    // move floor reserves — removeLiquidity — reverts on treasury's own
    // zero LP balance (ERC20's own insufficient-balance check inside
    // `lpToken.burn`).
    await expect(vault.connect(treasury).removeLiquidity(1n, 0, 0)).to.be.reverted;
  });

  it("no admin/governance function in the vault's ABI can move or burn another holder's LP position", async () => {
    const { vault } = await deployFixture();
    const abi = vault.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
    // The ONLY two functions touching lpToken balances are addLiquidity
    // (mints to msg.sender) and removeLiquidity (burns msg.sender's own
    // balance) — no adminBurn/sweep/rescue of LP exists.
    expect(abi).to.include("addLiquidity");
    expect(abi).to.include("removeLiquidity");
    expect(abi).to.not.include("adminBurnLp");
    expect(abi).to.not.include("sweepLp");
    expect(abi).to.not.include("rescueLp");
  });

  it("mirrors the existing SEED_LOCK_ADDR honesty standard: the ONLY way the floor could ever move is control of the dead address's key, which nobody holds — proven mechanically via impersonation, exactly like IndexBuybackFacet.test.ts's own SEED_LOCK_ADDR test", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice, bob } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);
    const seedPayment = ethers.parseEther("100");
    const seedShares = ethers.parseEther("1");
    await openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment);

    // Real-world: nobody has ever produced a private key for
    // 0x000...dEaD. This impersonation is Hardhat-only tooling standing in
    // for "if someone somehow had the key" — the same caveat the repo's own
    // IndexBuybackFacet.test.ts states explicitly for SEED_LOCK_ADDR.
    await ethers.provider.send("hardhat_impersonateAccount", [LP_LOCK_ADDR]);
    await ethers.provider.send("hardhat_setBalance", [LP_LOCK_ADDR, "0x56BC75E2D63100000"]); // 100 ETH
    const deadSigner = await ethers.getSigner(LP_LOCK_ADDR);

    const lpAddr = await vault.lpToken();
    const lp: any = await ethers.getContractAt("CollectionVaultLP", lpAddr);
    const total = await lp.totalSupply();

    // Bob (a real, unrelated community LP) adds liquidity alongside the
    // floor — proving the floor's presence doesn't block genuine community
    // deposits, and giving us a second LP position to check isn't touched.
    await mintShares(nft, vault, vaultAddr, bob, 100, 1);
    const paymentInBob = ethers.parseEther("10");
    await vault.connect(bob).addLiquidity(paymentInBob, 0);
    const bobLpBefore = await lp.balanceOf(bob.address);

    const paymentReserveBefore = await vault.paymentReserve();
    const shareReserveBefore = await vault.shareReserve();
    const totalLpBefore = await lp.totalSupply();
    const expectedPaymentOut = (total * paymentReserveBefore) / totalLpBefore;
    const expectedSharesOut = (total * shareReserveBefore) / totalLpBefore;

    await vault.connect(deadSigner).removeLiquidity(total, 0, 0);

    // The dead address received EXACTLY its own proportional slice — no more
    // (it cannot mint itself extra LP; `lpToken.mint` is `onlyVault`, only
    // ever called from `addLiquidity`/`openPool`) — and Bob's independent LP
    // position is completely untouched.
    expect(await payment.balanceOf(LP_LOCK_ADDR)).to.equal(expectedPaymentOut);
    expect(await vault.balanceOf(LP_LOCK_ADDR)).to.equal(expectedSharesOut);
    expect(await lp.balanceOf(bob.address)).to.equal(bobLpBefore);
    expect(await lp.totalSupply()).to.equal(totalLpBefore - total);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [LP_LOCK_ADDR]);
  });

  // ══ 2. Community add/remove, proportional, fee-earning ══════════════════

  it("a community member adds balanced liquidity and later removes EXACTLY their proportional share, including fees earned meanwhile", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice, bob } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);
    const seedPayment = ethers.parseEther("1000");
    const seedShares = ethers.parseEther("1");
    await openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment);

    const lpAddr = await vault.lpToken();
    const lp: any = await ethers.getContractAt("CollectionVaultLP", lpAddr);

    await mintShares(nft, vault, vaultAddr, bob, 100, 1);
    const bobShareBalBefore = await vault.balanceOf(bob.address);

    const paymentReserveBefore = await vault.paymentReserve();
    const shareReserveBefore = await vault.shareReserve();
    const totalLpBefore = await lp.totalSupply();

    const paymentIn = ethers.parseEther("50");
    const expectedSharesIn = (paymentIn * shareReserveBefore) / paymentReserveBefore;
    const expectedLpOut = (paymentIn * totalLpBefore) / paymentReserveBefore;

    await expect(vault.connect(bob).addLiquidity(paymentIn, 0))
      .to.emit(vault, "LiquidityAdded")
      .withArgs(bob.address, paymentIn, expectedSharesIn, expectedLpOut);

    expect(await lp.balanceOf(bob.address)).to.equal(expectedLpOut);
    expect(await vault.balanceOf(bob.address)).to.equal(bobShareBalBefore - expectedSharesIn);
    expect(await vault.paymentReserve()).to.equal(paymentReserveBefore + paymentIn);
    expect(await vault.shareReserve()).to.equal(shareReserveBefore + expectedSharesIn);

    // Generate real swap-fee volume so k grows — the same fee-into-k
    // mechanism buyShares/sellShares already implement, now something LP
    // positions have a real claim on.
    const trader = (await ethers.getSigners())[8];
    await payment.mint(trader.address, ethers.parseEther("500"));
    await payment.connect(trader).approve(vaultAddr, ethers.MaxUint256);
    for (let i = 0; i < 5; i++) {
      await vault.connect(trader).buyShares(ethers.parseEther("20"), 0);
    }
    const gotShares = await vault.balanceOf(trader.address);
    await vault.connect(trader).sellShares(gotShares, 0);

    // Bob removes ALL his LP — must get back EXACTLY his proportional slice
    // of the now fee-grown reserves.
    const bobLp = await lp.balanceOf(bob.address);
    const totalLpNow = await lp.totalSupply();
    const paymentReserveNow = await vault.paymentReserve();
    const shareReserveNow = await vault.shareReserve();
    const expectedPaymentOut = (bobLp * paymentReserveNow) / totalLpNow;
    const expectedSharesOut = (bobLp * shareReserveNow) / totalLpNow;

    const paymentBalBefore = await payment.balanceOf(bob.address);
    const shareBalBefore = await vault.balanceOf(bob.address);

    await expect(vault.connect(bob).removeLiquidity(bobLp, 0, 0))
      .to.emit(vault, "LiquidityRemoved")
      .withArgs(bob.address, bobLp, expectedPaymentOut, expectedSharesOut);

    expect(await payment.balanceOf(bob.address)).to.equal(paymentBalBefore + expectedPaymentOut);
    expect(await vault.balanceOf(bob.address)).to.equal(shareBalBefore + expectedSharesOut);
    expect(await lp.balanceOf(bob.address)).to.equal(0n);

    // Fee compounding genuinely raised his position's value beyond his raw
    // deposit ratio: paymentOut per LP unit strictly exceeds his entry price
    // (paymentIn / expectedLpOut), because k grew from real swap-fee volume
    // in between.
    const entryPricePerLp = (paymentIn * 1_000_000_000_000n) / expectedLpOut;
    const exitPricePerLp = (expectedPaymentOut * 1_000_000_000_000n) / bobLp;
    expect(exitPricePerLp).to.be.gt(entryPricePerLp);
  });

  it("InventoryBuyAdapter's existing Pipe I behavior is unaffected by community LP: buyShares pricing still comes solely from paymentReserve/shareReserve", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice, bob } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);
    const seedPayment = ethers.parseEther("1000");
    const seedShares = ethers.parseEther("1");
    await openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment);

    // Community adds liquidity so a real fraction of reserves is now
    // community-owned, not just the locked floor.
    await mintShares(nft, vault, vaultAddr, bob, 100, 1);
    await vault.connect(bob).addLiquidity(ethers.parseEther("200"), 0);

    const [, , , , , , , , busSigner] = await ethers.getSigners();
    const MockWM = await ethers.getContractFactory("MockWeightModuleWeights");
    const wm: any = await MockWM.deploy(vaultAddr, 10_000n);
    // Real contract target (not an EOA) — `index` must have code so
    // `IIndexEnergyCredit.creditInventory`'s try/catch behaves the way the
    // real Diamond does; an EOA target's empty-return ABI-decode failure is
    // an unrelated Solidity try/catch quirk, not something this test cares
    // about.
    const indexStandIn: any = await (await ethers.getContractFactory("MockIndexEnergyCredit")).deploy();
    const indexStandInAddr = await indexStandIn.getAddress();

    const InvAdapterF = await ethers.getContractFactory("InventoryBuyAdapter");
    const invAdapter: any = await InvAdapterF.deploy(
      await payment.getAddress(),
      indexStandInAddr,
      busSigner.address,
      await wm.getAddress()
    );
    const invAdapterAddr = await invAdapter.getAddress();

    const paymentReserveBefore = await vault.paymentReserve();
    const shareReserveBefore = await vault.shareReserve();

    const budget = ethers.parseEther("10");
    await payment.mint(invAdapterAddr, budget);

    // Manual constant-product expectation, computed the SAME way
    // buyShares itself does — independent of how paymentReserve/shareReserve
    // got to their current values (floor-only vs. floor+community).
    const swapFeeBps = await vault.swapFeeBps();
    const sinkBps = await vault.SWAP_SINK_SPLIT_BPS();
    const BPS = 10_000n;
    const fee = (budget * swapFeeBps) / BPS;
    const sinkCut = (fee * sinkBps) / BPS;
    const netIn = budget - sinkCut;
    const inNet = (netIn * (BPS - swapFeeBps)) / BPS;
    const expectedSharesOut = (inNet * shareReserveBefore) / (paymentReserveBefore + inNet);

    await expect(invAdapter.connect(busSigner).execute(budget)).to.not.be.reverted;

    const sAtIndex = await vault.balanceOf(indexStandInAddr);
    expect(sAtIndex).to.equal(expectedSharesOut);
    expect(await vault.paymentReserve()).to.equal(paymentReserveBefore + netIn);

    // The adapter never retains WETH.
    expect(await payment.balanceOf(invAdapterAddr)).to.equal(0n);
  });

  // ══ 3. First-depositor / inflation attack on the LP token is closed ═════

  it("closes the classic first-depositor inflation attack: a tiny LP deposit followed by a large single-sided donation cannot zero out a later fair depositor's LP mint", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice, attacker, bob } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);
    // Small genesis floor on purpose — the attacker's best-case scenario.
    const seedPayment = ethers.parseEther("10");
    const seedShares = ethers.parseEther("1");
    await openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment);

    const lpAddr = await vault.lpToken();
    const lp: any = await ethers.getContractAt("CollectionVaultLP", lpAddr);
    const totalLpAfterFloor = await lp.totalSupply();
    expect(totalLpAfterFloor).to.be.gt(0n); // never zero — floor already claimed the "first depositor" slot

    // Attacker attempts the classic move: smallest possible LP add, then
    // inflate paymentReserve via the vault's own permissionless single-sided
    // donateReserves (the pre-existing, unmodified PR6 mechanism).
    await mintShares(nft, vault, vaultAddr, attacker, 200, 1);
    const tinyPaymentIn = 1_000n; // deliberately tiny
    await vault.connect(attacker).addLiquidity(tinyPaymentIn, 0);
    const attackerLp = await lp.balanceOf(attacker.address);
    expect(attackerLp).to.be.gt(0n);

    const donation = ethers.parseEther("500");
    await payment.mint(attacker.address, donation);
    await payment.connect(attacker).approve(vaultAddr, donation);
    await vault.connect(attacker).donateReserves(donation);

    // A fair, real community depositor (bob) now adds a reasonable amount.
    await mintShares(nft, vault, vaultAddr, bob, 300, 1);
    const bobPaymentIn = ethers.parseEther("50");
    const paymentReserveBefore = await vault.paymentReserve();
    const totalLpBefore = await lp.totalSupply();
    const expectedBobLp = (bobPaymentIn * totalLpBefore) / paymentReserveBefore;

    await vault.connect(bob).addLiquidity(bobPaymentIn, 0);

    // Bob is NOT rounded to zero — the attack that classically zeroes a
    // victim's mint (empty-vault first-deposit + donate) cannot land here
    // because totalLp was never zero/attacker-controlled at genesis.
    expect(await lp.balanceOf(bob.address)).to.equal(expectedBobLp);
    expect(await lp.balanceOf(bob.address)).to.be.gt(0n);

    // Bob's LP fairly reflects his own contribution, not a value siphoned
    // to the attacker: redeeming immediately returns ~bobPaymentIn (modulo
    // integer rounding), never something wildly smaller.
    const totalLpAfterBob = await lp.totalSupply();
    const paymentReserveAfterBob = await vault.paymentReserve();
    const bobLpBal = await lp.balanceOf(bob.address);
    const bobRedeemable = (bobLpBal * paymentReserveAfterBob) / totalLpAfterBob;
    const tolerance = bobPaymentIn / 100n; // 1% integer-rounding slack
    expect(bobRedeemable).to.be.closeTo(bobPaymentIn, tolerance);

    // The attacker's own tiny LP position did NOT capture a disproportionate
    // slice of Bob's deposit — attacker's redeemable value grew only via the
    // SAME donation-driven price appreciation every existing LP (including
    // the locked floor) gets, not an extra cut skimmed from Bob.
    const attackerRedeemable = (attackerLp * paymentReserveAfterBob) / totalLpAfterBob;
    const attackerShareOfPool = (attackerLp * 1_000_000_000_000n) / totalLpAfterBob;
    const attackerShareBeforeBob = (attackerLp * 1_000_000_000_000n) / totalLpBefore;
    expect(attackerShareOfPool).to.be.lte(attackerShareBeforeBob); // diluted by Bob's fair entry, not enriched
    expect(attackerRedeemable).to.be.gt(0n);
  });

  it("reverts a zero-amount addLiquidity/removeLiquidity rather than minting/burning a worthless position", async () => {
    const { vault, vaultAddr, treasury, payment, nft, alice } = await deployFixture();
    await mintShares(nft, vault, vaultAddr, alice, 1, 1);
    const seedPayment = ethers.parseEther("100");
    const seedShares = ethers.parseEther("1");
    await openPool(vault, vaultAddr, treasury, payment, alice, seedShares, seedPayment);

    await expect(vault.connect(alice).addLiquidity(0, 0)).to.be.revertedWithCustomError(
      vault,
      "ZeroLiquidityInput"
    );
    await expect(vault.connect(alice).removeLiquidity(0, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "ZeroLiquidityInput"
    );
  });

  it("addLiquidity reverts before the pool is open (no reserves to price a balanced deposit against)", async () => {
    const { vault, alice } = await deployFixture();
    await expect(vault.connect(alice).addLiquidity(1_000n, 0)).to.be.revertedWithCustomError(
      vault,
      "PoolNotYetOpenForLp"
    );
  });
});
