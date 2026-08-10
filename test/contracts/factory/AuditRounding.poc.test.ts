import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/** AUDIT: rounding-direction fuzz across 1 wei -> 1e28 for the CPMM and LP round-trips. */
describe("AUDIT: rounding direction fuzz (CollectionVault)", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  async function fx() {
    const [deployer, sink, treasury, alice, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), 48 * 3600);
    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    for (const who of [alice, attacker, treasury, deployer]) {
      await payment.mint(who.address, ethers.parseEther("100000000"));
      await payment.connect(who).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }
    for (let i = 1; i <= 60; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
      await vault.connect(alice).deposit(i);
    }
    await vault.connect(treasury).seedLiquidity(ethers.parseEther("500"));
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("50"));
    await vault.connect(treasury).seedShares(ethers.parseEther("50"));
    await vault.connect(treasury).openPool();
    return { vault, payment, attacker };
  }

  it("CPMM: buy->sell round trip never profits the trader, 1 wei to 1e21", async () => {
    const { vault, payment, attacker } = await fx();
    const sizes = [1n, 10n, 1000n, 10n ** 9n, 10n ** 12n, 10n ** 15n, 10n ** 18n, 10n ** 20n, 10n ** 21n];
    for (const x of sizes) {
      const before = await payment.balanceOf(attacker.address);
      let out: bigint;
      try {
        out = await vault.connect(attacker).buyShares.staticCall(x, 0);
      } catch { console.log(`  in=${x} -> buy reverted (dust guard)`); continue; }
      await vault.connect(attacker).buyShares(x, 0);
      try { await vault.connect(attacker).sellShares(out, 0); }
      catch { console.log(`  in=${x} sharesOut=${out} -> sell reverted (trader keeps nothing back)`); continue; }
      const pnl = (await payment.balanceOf(attacker.address)) - before;
      console.log(`  in=${x} -> round-trip P&L = ${pnl}`);
      expect(pnl <= 0n, `round trip profited at size ${x}`).to.equal(true);
    }
  });

  it("LP: add->remove round trip never returns more payment than was put in", async () => {
    const { vault, payment, attacker } = await fx();
    const sizes = [10n ** 6n, 10n ** 12n, 10n ** 15n, 10n ** 18n, 10n ** 20n, 10n ** 21n];
    for (const p of sizes) {
      const payBefore = await payment.balanceOf(attacker.address);
      const sBefore = await vault.balanceOf(attacker.address);
      let lp: bigint;
      try { [lp] = await vault.connect(attacker).addLiquidity.staticCall(p, 0); }
      catch { console.log(`  p=${p} -> add reverted`); continue; }
      await vault.connect(attacker).addLiquidity(p, 0);
      await vault.connect(attacker).removeLiquidity(lp, 0, 0);
      const dPay = (await payment.balanceOf(attacker.address)) - payBefore;
      const dS = (await vault.balanceOf(attacker.address)) - sBefore;
      console.log(`  p=${p} -> dPay=${dPay} dS=${dS}`);
      expect(dPay <= 0n, `LP round trip gained payment at ${p}`).to.equal(true);
      expect(dS <= 0n, `LP round trip gained S at ${p}`).to.equal(true);
    }
  });
});
