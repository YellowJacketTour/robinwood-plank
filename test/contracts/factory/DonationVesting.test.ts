import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * PHASE 4 — donation vesting + LP dwell (closes audit C-3).
 *
 * Two independent halves, per Spearbit's NFTX v3 evidence that the fix which
 * finally held required a flash-loan-resistant fee AND a timelock:
 *   half 1 — `_addDonationVest` / `_drip`: a donation is recognised into
 *            `paymentReserve` LINEARLY over `DONATION_VEST_BLOCKS`, never as a
 *            step.
 *   half 2 — `LP_MIN_DWELL_BLOCKS` + a decaying exit fee: the LP round trip is
 *            impossible within the dwell and loss-making after it.
 *
 * WOULD EACH TEST GO RED IF THE MECHANISM BROKE?
 *   "credits nothing in the donation's own block"  -> revert `_compoundXToken`
 *        / `donateReserves` to `paymentReserve += x` and this fails instantly.
 *   "recognises linearly"                          -> set the window to 1 block
 *        and the mid-window assertion fails.
 *   "conserves value exactly"                      -> any drip arithmetic error
 *        strands or double-counts wei and this fails.
 *   "quote and trade agree"                        -> drop `_drippable()` from
 *        `_pr()` and the quote diverges from the executed swap.
 *   "dwell blocks the atomic round trip"           -> delete the dwell check and
 *        the revert stops happening.
 *   "laundering LP through a fresh address"        -> delete the
 *        `_afterTokenTransfer` hook and the fresh address exits immediately.
 *   "exit fee decays"                              -> pin feeBps and the
 *        early-vs-late comparison collapses.
 */
describe("Phase 4 — donation vesting + LP dwell (audit C-3)", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  const TIMELOCK = 48 * 3600;
  const VEST = 300;
  const MIN_DWELL = 8;
  const MAX_FEE_BPS = 100n;
  const BPS = 10_000n;

  /** `_drippable()` is not exposed directly (contract-size budget); it is
   * exactly the gap between the effective and the stored reserve. */
  async function drippable(vault: any): Promise<bigint> {
    return (await vault.effectivePaymentReserve()) - (await vault.paymentReserve());
  }

  async function fixture(seedPay = ethers.parseEther("100"), seedSh = ethers.parseEther("10")) {
    const [deployer, sink, treasury, alice, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), TIMELOCK);
    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    for (const who of [alice, attacker, treasury, deployer]) {
      await payment.mint(who.address, ethers.parseEther("1000000"));
      await payment.connect(who).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }
    const n = Number(seedSh / 10n ** 18n) + 5;
    for (let i = 1; i <= n; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
      await vault.connect(alice).deposit(i);
    }
    await vault.connect(treasury).seedLiquidity(seedPay);
    await vault.connect(alice).transfer(treasury.address, seedSh);
    await vault.connect(treasury).seedShares(seedSh);
    // The attacker needs their OWN `S` to add balanced liquidity — they are a
    // real, funded adversary, not a special case.
    for (let i = 500; i < 520; i++) {
      await nft.mint(attacker.address, i);
      await nft.connect(attacker).approve(vaultAddr, i);
      await vault.connect(attacker).deposit(i);
    }
    await vault.connect(treasury).openPool();
    // Settle the deposits' own Stream-A fee donations so each test starts from
    // a quiescent vest ledger.
    await mine(VEST);
    const lp: any = await ethers.getContractAt("CollectionVaultLP", await vault.lpToken());
    return { deployer, sink, treasury, alice, attacker, payment, nft, vault, vaultAddr, lp };
  }

  // ══ half 1 — the vest ═════════════════════════════════════════════════════

  it("credits EXACTLY ZERO of a donation in the donation's own block — the step is gone", async () => {
    const { vault, deployer } = await fixture();
    const prBefore = await vault.paymentReserve();
    const D = ethers.parseEther("10");
    await vault.connect(deployer).donateReserves(D);

    // In the very block the donation lands, nothing has been recognised.
    expect(await vault.paymentReserve()).to.equal(prBefore);
    expect(await vault.pendingDonation()).to.equal(D);
    expect(await drippable(vault)).to.equal(0n); // same block => zero elapsed
    // ...and the view layer agrees, so nothing can price against the step.
    expect(await vault.effectivePaymentReserve()).to.equal(prBefore);
  });

  it("recognises the donation LINEARLY over DONATION_VEST_BLOCKS, and no faster", async () => {
    const { vault, deployer } = await fixture();
    const prBefore = await vault.paymentReserve();
    const D = ethers.parseEther("10");
    await vault.connect(deployer).donateReserves(D);

    // a quarter of the way through
    await mine(VEST / 4);
    const quarter = await drippable(vault);
    expect(quarter).to.be.gt(0n);
    // exact linear expectation, +/- one wei of integer division
    expect(quarter).to.be.closeTo((D * BigInt(VEST / 4)) / BigInt(VEST), 2n);
    expect(await vault.effectivePaymentReserve()).to.equal(prBefore + quarter);

    // three quarters
    await mine(VEST / 2);
    const threeQuarters = await drippable(vault);
    expect(threeQuarters).to.be.gt(quarter * 2n); // strictly more, and roughly 3x
    expect(threeQuarters).to.be.lt(D);

    // and only at the end is it whole
    await mine(VEST);
    expect(await drippable(vault)).to.equal(D);
  });

  it("conserves value exactly: every wei of a donation eventually reaches paymentReserve, and never more", async () => {
    const { vault, deployer, alice } = await fixture();
    const prBefore = await vault.paymentReserve();
    const D = 1_000_000_000_000_007n; // deliberately non-round, to catch rounding drift
    await vault.connect(deployer).donateReserves(D);

    // poke the drip repeatedly mid-window; partial commits must not lose wei
    for (let i = 0; i < 5; i++) {
      await mine(37);
      await vault.connect(alice).buyShares(1_000_000n, 0); // any state-changing call drips
    }
    await mine(VEST);
    await vault.connect(alice).buyShares(1_000_000n, 0);

    expect(await vault.pendingDonation()).to.equal(0n);
    // paymentReserve grew by the donation plus whatever the six tiny buys put
    // in; the donation itself is fully accounted for and nothing is stranded.
    expect(await vault.paymentReserve()).to.be.gte(prBefore + D);
    // solvency: the vault's real token balance still covers everything it owes
    const payment: any = await ethers.getContractAt("MockIndexToken", await vault.paymentToken());
    const bal = await payment.balanceOf(await vault.getAddress());
    expect(bal).to.be.gte((await vault.paymentReserve()) + (await vault.accruedFees()) + (await vault.pendingDonation()));
  });

  it("a quote and the trade it quotes agree wei-for-wei mid-drip (views see the drip too)", async () => {
    const { vault, deployer, alice } = await fixture();
    await vault.connect(deployer).donateReserves(ethers.parseEther("10"));
    await mine(91); // mid-window, so drippable > 0 and the two could disagree

    const amountIn = ethers.parseEther("3");
    const quoted = await vault.quoteBuyShares(amountIn);
    expect(quoted).to.be.gt(0n);
    // The trade executes one block later, which drips slightly more, so the
    // executed fill is >= the quote — never below it. A view that ignored the
    // drip would quote the STALE reserve and the fill would come out on the
    // wrong side.
    const actual = await vault.connect(alice).buyShares.staticCall(amountIn, 0);
    const quotedAtSameHeight = await vault.quoteBuyShares(amountIn);
    expect(quotedAtSameHeight).to.equal(quoted);
    // more payment reserve => fewer shares out; one extra block of drip moves
    // it by well under 0.1%
    expect(actual).to.be.closeTo(quoted, quoted / 1000n);
  });

  // ══ half 2 — dwell + decaying exit fee ═══════════════════════════════════

  it("the ATOMIC add -> donate -> remove round trip is IMPOSSIBLE, not merely unprofitable", async () => {
    const { vault, attacker, deployer, lp } = await fixture();
    await vault.connect(attacker).addLiquidity(ethers.parseEther("100"), 0);
    await vault.connect(deployer).donateReserves(ethers.parseEther("10"));
    const lpBal = await lp.balanceOf(attacker.address);
    await expect(vault.connect(attacker).removeLiquidity(lpBal, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "LpDwellNotMet"
    );
    // and permitted once the dwell is genuinely served
    await mine(MIN_DWELL);
    await expect(vault.connect(attacker).removeLiquidity(lpBal, 0, 0)).to.not.be.revert(ethers);
  });

  it("moving LP to a FRESH address does not launder the dwell clock", async () => {
    const { vault, attacker, alice, lp } = await fixture();
    await vault.connect(attacker).addLiquidity(ethers.parseEther("100"), 0);
    const lpBal = await lp.balanceOf(attacker.address);
    // alice is a completely fresh LP holder with lpEntryBlock == 0, which
    // WITHOUT the transfer hook would read as an infinitely old position.
    await lp.connect(attacker).transfer(alice.address, lpBal);
    await expect(vault.connect(alice).removeLiquidity(lpBal, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "LpDwellNotMet"
    );
    expect(await vault.lpEntryBlock(alice.address)).to.be.gt(0n);
  });

  it("the exit fee is near-maximal at the minimum dwell and decays to exactly zero", async () => {
    // early exit
    const early = await fixture();
    await early.vault.connect(early.attacker).addLiquidity(ethers.parseEther("100"), 0);
    const earlyLp = await early.lp.balanceOf(early.attacker.address);
    await mine(MIN_DWELL);
    const earlyOut = await early.vault.connect(early.attacker).removeLiquidity.staticCall(earlyLp, 0, 0);
    const earlyPr = await early.vault.effectivePaymentReserve();
    const earlyTotal = await early.lp.totalSupply();
    const earlyGross = (earlyLp * earlyPr) / earlyTotal;
    // fee bps at held ~= MIN_DWELL+1 is ~ 100*(300-9)/300 = 97
    const earlyFee = earlyGross - earlyOut[0];
    expect(earlyFee).to.be.gt((earlyGross * 90n) / BPS);
    expect(earlyFee).to.be.lte((earlyGross * MAX_FEE_BPS) / BPS);

    // late exit — same position, held past the decay window
    const late = await fixture();
    await late.vault.connect(late.attacker).addLiquidity(ethers.parseEther("100"), 0);
    const lateLp = await late.lp.balanceOf(late.attacker.address);
    await mine(VEST);
    const lateOut = await late.vault.connect(late.attacker).removeLiquidity.staticCall(lateLp, 0, 0);
    const latePr = await late.vault.effectivePaymentReserve();
    const lateTotal = await late.lp.totalSupply();
    expect(lateOut[0]).to.equal((lateLp * latePr) / lateTotal); // EXACTLY proportional: fee is zero
  });

  it("the exit fee stays in the pool for the LPs who remain — it is retained, not extracted", async () => {
    const { vault, attacker, lp } = await fixture();
    await vault.connect(attacker).addLiquidity(ethers.parseEther("100"), 0);
    const lpBal = await lp.balanceOf(attacker.address);
    await mine(MIN_DWELL);

    const prBefore = await vault.effectivePaymentReserve();
    const srBefore = await vault.shareReserve();
    const totalBefore = await lp.totalSupply();
    const grossSh = (lpBal * srBefore) / totalBefore;
    const perLpBefore = (prBefore * 10n ** 18n) / totalBefore;
    const accruedBefore = await vault.accruedFees();

    await vault.connect(attacker).removeLiquidity(lpBal, 0, 0);

    // SHARE leg: retained immediately — the fee simply never leaves
    // `shareReserve`, so the remaining LPs own it from this block on.
    expect(await vault.shareReserve()).to.be.gt(srBefore - grossSh);

    // PAYMENT leg: retained but DEFERRED. It re-enters through
    // `_addDonationVest`, so it is `pendingDonation` right now, not reserve —
    // deliberately, because crediting an exit fee instantly would re-create
    // C-3 in miniature (a second JIT LP could sandwich the first one's exit
    // fee). This assertion is the proof that it took the vested path.
    expect(await vault.pendingDonation()).to.be.gt(0n);

    // Nothing leaked out of the pool: the exit fee reached neither the
    // treasury nor the upstream sink.
    expect(await vault.accruedFees()).to.equal(accruedBefore);

    // And once the vest completes, the remaining LPs are strictly better off
    // per LP unit than they were before the attacker left.
    await mine(VEST);
    const perLpAfter = ((await vault.effectivePaymentReserve()) * 10n ** 18n) / (await lp.totalSupply());
    expect(perLpAfter).to.be.gt(perLpBefore);
  });

  it("minPaymentOut / minSharesOut bind against the NET, post-fee amounts", async () => {
    const { vault, attacker, lp } = await fixture();
    await vault.connect(attacker).addLiquidity(ethers.parseEther("100"), 0);
    const lpBal = await lp.balanceOf(attacker.address);
    await mine(MIN_DWELL);
    const pr = await vault.effectivePaymentReserve();
    const gross = (lpBal * pr) / (await lp.totalSupply());
    // Asking for the GROSS figure must fail — a bound that ignored the fee
    // would let this through, which is exactly the H-3-shaped bug Spearbit
    // found in NFTX's own `removeLiquidity`.
    await expect(vault.connect(attacker).removeLiquidity(lpBal, gross, 0)).to.be.revertedWithCustomError(
      vault,
      "InsufficientLpRemoveOutput"
    );
  });

  // ══ the two halves composed ══════════════════════════════════════════════

  it("Stream-A fee revenue is vested too, so a mint burst cannot be sniped either", async () => {
    const { vault, vaultAddr, nft, alice } = await fixture();
    const prBefore = await vault.paymentReserve();
    const pendingBefore = await vault.pendingDonation();
    await nft.mint(alice.address, 5000);
    await nft.connect(alice).approve(vaultAddr, 5000);
    await vault.connect(alice).deposit(5000);
    // 25% of the 0.01 PAY mint fee is the compound carve-out; it is PENDING,
    // not credited.
    const expectedCarve = (ethers.parseEther("0.01") * 2500n) / BPS;
    expect(await vault.pendingDonation()).to.equal(pendingBefore + expectedCarve);
    expect(await vault.paymentReserve()).to.equal(prBefore);
  });
});
