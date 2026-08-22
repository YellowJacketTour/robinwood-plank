import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * PlankRakeDistributor's whole job is a real, exact three-way split of
 * whatever ETH lands on it -- these tests prove the arithmetic and the
 * real forwarding to each destination, including the special-cased
 * airdropPool.fund() call (not a plain transfer, since the pool needs to
 * know which epoch to credit -- see MockEthSink.fund(), which mirrors
 * that shape for this test's purposes; the real PlankAirdropPool has its
 * own dedicated fund()-crediting test in PlankAirdropPool.test.ts).
 */
describe("PlankRakeDistributor", () => {
  async function deployAll(burnBps = 4000n, airdropBps = 4000n) {
    const [deployer, treasury] = await ethers.getSigners();

    const EthSink = await ethers.getContractFactory("MockEthSink");
    const burnEngine: any = await EthSink.deploy();
    const airdropPool: any = await EthSink.deploy();

    const Distributor = await ethers.getContractFactory("PlankRakeDistributor");
    const distributor: any = await Distributor.deploy(
      await burnEngine.getAddress(),
      await airdropPool.getAddress(),
      treasury.address,
      burnBps,
      airdropBps
    );

    return { distributor, burnEngine, airdropPool, treasury, deployer };
  }

  it("rejects a burn+airdrop split exceeding 100%", async () => {
    const [, treasury] = await ethers.getSigners();
    const EthSink = await ethers.getContractFactory("MockEthSink");
    const burnEngine: any = await EthSink.deploy();
    const airdropPool: any = await EthSink.deploy();
    const Distributor = await ethers.getContractFactory("PlankRakeDistributor");
    await expect(
      Distributor.deploy(await burnEngine.getAddress(), await airdropPool.getAddress(), treasury.address, 6000n, 5000n)
    ).to.be.revertedWithCustomError(Distributor, "SplitExceeds100Percent");
  });

  it("splits incoming ETH exactly across burnEngine/airdropPool/treasury", async () => {
    const { distributor, burnEngine, airdropPool, treasury, deployer } = await deployAll(4000n, 3500n);

    const amount = ethers.parseEther("10");
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    await deployer.sendTransaction({ to: await distributor.getAddress(), value: amount });

    const expectedBurn = (amount * 4000n) / 10000n;
    const expectedAirdrop = (amount * 3500n) / 10000n;
    const expectedTreasury = amount - expectedBurn - expectedAirdrop;

    expect(await ethers.provider.getBalance(await burnEngine.getAddress())).to.equal(expectedBurn);
    expect(await ethers.provider.getBalance(await airdropPool.getAddress())).to.equal(expectedAirdrop);
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + expectedTreasury);

    expect(await distributor.totalReceived()).to.equal(amount);
    expect(await distributor.totalToBurn()).to.equal(expectedBurn);
    expect(await distributor.totalToAirdrop()).to.equal(expectedAirdrop);
    expect(await distributor.totalToTreasury()).to.equal(expectedTreasury);
  });

  it("a 0/0 split sends everything to treasury", async () => {
    const { distributor, burnEngine, airdropPool, treasury, deployer } = await deployAll(0n, 0n);
    const amount = ethers.parseEther("1");
    const before = await ethers.provider.getBalance(treasury.address);
    await deployer.sendTransaction({ to: await distributor.getAddress(), value: amount });
    expect(await ethers.provider.getBalance(await burnEngine.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await airdropPool.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(before + amount);
  });

  it("accumulates correctly across multiple deposits", async () => {
    const { distributor, deployer } = await deployAll(5000n, 2500n);
    await deployer.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
    await deployer.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("2") });
    expect(await distributor.totalReceived()).to.equal(ethers.parseEther("3"));
  });
});
