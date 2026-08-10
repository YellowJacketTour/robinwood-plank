import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";

import { deployIndexVault, TIMELOCK, paramsTuple, defaultParams } from "./helpers/index-vault.js";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  AUDIT H-2 — the zap credited a SELF-REPORTED number, and handed an
 *  UNVALIDATED address an allowance over the diamond's WETH.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `IndexZapFacet.sol:203` was `c.reserve += _routeDevFundBuy(t, want)` — no
 * `_pullCredited`, no balance delta, no `ShortDelivery` check, alone among
 * every mint path in this diamond. `:227-228` then "validated" a leg by asking
 * the untrusted address about itself, and `:233` granted it an allowance.
 *
 * Both are tested here against a leg that behaves EXACTLY like the failure
 * mode: `MockZapVault` returns the honest constant-product output from
 * `buyShares` and transfers `shortBps` less than it returned.
 *
 * THE CONTROL MATTERS. Test 1 asserts a revert; a revert is easy to produce by
 * accident (a broken fixture reverts too). Test 0 runs the identical zap
 * against the identical fixture with `shortBps = 0` and asserts it SUCCEEDS and
 * credits the reserve, so test 1's revert is attributable to the shortfall and
 * nothing else.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("AUDIT H-2 — the zap credits an observed delta and validates provenance first", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  /**
   * A one-constituent index whose single leg is a `MockZapVault`, vouched for
   * by a `MockVaultFactory` standing in for `CollectionVaultFactory`.
   */
  async function setup(shortBps: bigint) {
    const [, roleAdmin, seeder, alice, , admission, risk, allocation] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("WETH", "WETH");
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr } = await deployIndexVault({
      name: "ZapCredit",
      symbol: "ZC",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: wethAddr,
    });

    const leg: any = await (
      await ethers.getContractFactory("MockZapVault")
    ).deploy("LEG", "LEG", wethAddr);
    const legAddr = await leg.getAddress();

    // A deep pool, so nothing below is bounded by impact or liquidity.
    await weth.mint(seeder.address, ethers.parseEther("100000"));
    await weth.connect(seeder).approve(legAddr, ethers.MaxUint256);
    await leg.connect(seeder).seedPool(ethers.parseEther("1000"), ethers.parseEther("1000"));
    await leg.setShortBps(shortBps);

    const src: any = await (
      await ethers.getContractFactory("MockIndexPriceSource")
    ).deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    await vault.connect(seeder).seedConstituent(legAddr, await src.getAddress(), 10_000n);
    await leg.mint(seeder.address, ethers.parseEther("100"));
    await leg.connect(seeder).approve(vaultAddr, ethers.MaxUint256);
    await vault.connect(seeder).seedDeposit(legAddr, ethers.parseEther("100"));
    await vault.connect(seeder).openIndex(ethers.parseEther("1000"));

    const registry: any = await (await ethers.getContractFactory("MockVaultFactory")).deploy();
    await registry.setVault(legAddr, true);
    await vault.connect(admission).queueVaultFactory(await registry.getAddress());
    await time.increase(TIMELOCK + 1);
    await vault.executeVaultFactory();

    await weth.mint(alice.address, ethers.parseEther("1000"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    return { vault, vaultAddr, weth, leg, legAddr, alice, admission, registry };
  }

  it("0. CONTROL: an honest leg zaps successfully and its delivery lands in the reserve", async () => {
    const { vault, legAddr, alice } = await setup(0n);

    const before: bigint = await vault.reserveOf(legAddr);
    await vault.connect(alice).zapMint(ethers.parseEther("1"), ethers.parseEther("50"));

    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther("1"));
    expect(await vault.reserveOf(legAddr)).to.be.greaterThan(before);
  });

  it("1. a leg that REPORTS more than it DELIVERS is refused — ShortDelivery, not a silent dilution", async () => {
    // 10% short. Under the old code the diamond credited the full computed
    // `want` and minted the full `desiredSharesOut` against a 90% deposit,
    // diluting every existing holder by the difference, silently.
    const { vault, alice } = await setup(1_000n);

    await expect(
      vault.connect(alice).zapMint(ethers.parseEther("1"), ethers.parseEther("50"))
    ).to.be.revertedWithCustomError(vault, "ShortDelivery");
  });

  it("2. a leg the registry does not vouch for never receives an allowance — provenance is checked FIRST", async () => {
    const { vault, alice, legAddr, admission, registry } = await setup(0n);

    // De-register the leg. Everything else is unchanged and the leg still
    // answers `poolOpen()`/`paymentToken()` exactly as before — which is the
    // point: those are its own claims about itself and are worth nothing.
    await registry.setVault(legAddr, false);

    await expect(vault.connect(alice).zapMint(ethers.parseEther("1"), ethers.parseEther("50")))
      .to.be.revertedWithCustomError(vault, "ZapUnverifiedLeg")
      .withArgs(legAddr);
  });

  it("3. with NO registry configured at all, the zap cannot run — fail closed", async () => {
    const { vault, alice, admission } = await setup(0n);

    await vault.connect(admission).queueVaultFactory(ethers.ZeroAddress);
    await time.increase(TIMELOCK + 1);
    await vault.executeVaultFactory();

    await expect(
      vault.connect(alice).zapMint(ethers.parseEther("1"), ethers.parseEther("50"))
    ).to.be.revertedWithCustomError(vault, "ZapUnverifiedLeg");
  });
});
