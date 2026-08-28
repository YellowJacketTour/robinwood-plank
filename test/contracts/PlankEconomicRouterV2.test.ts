import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

describe("PlankEconomicRouterV2", function () {
  const rulesHash = ethers.keccak256(ethers.toUtf8Bytes("plank-router-v2-test-rules"));
  it("routes the ratified split once from the same post-keeper base", async function () {
    const [source, burn, community, founders, keeper] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PlankEconomicRouterV2");
    const router = await Factory.deploy(
      burn.address,
      community.address,
      founders.address,
      [source.address],
      100,
      rulesHash,
    );
    const gross = 10_001n;
    await router.connect(source).routeRake(keeper.address, { value: gross });

    const keeperAmount = (gross * 100n) / 10_000n;
    const net = gross - keeperAmount;
    const burnAmount = (net * 2_000n) / 10_000n;
    const communityAmount = (net * 4_000n) / 10_000n;
    const foundersAmount = net - burnAmount - communityAmount;
    expect(await router.keeperEscrow(keeper.address)).to.equal(keeperAmount);
    expect(await router.burnEscrow()).to.equal(burnAmount);
    expect(await router.communityEscrow()).to.equal(communityAmount);
    expect(await router.founderEscrow()).to.equal(foundersAmount);
    expect(await router.accountedBalance()).to.equal(gross);
    expect(burnAmount + communityAmount + foundersAmount + keeperAmount).to.equal(gross);
  });

  it("rejects unapproved sources and preserves zero-value/rounding conservation", async function () {
    const [source, outsider, burn, community, founders] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PlankEconomicRouterV2");
    const router = await Factory.deploy(burn.address, community.address, founders.address, [source.address], 0, rulesHash);
    await expect(router.connect(outsider).routeRake(ethers.ZeroAddress, { value: 1n }))
      .to.be.revertedWithCustomError(router, "UnauthorizedSource");
    await router.connect(source).routeRake(ethers.ZeroAddress, { value: 1n });
    expect(await router.burnEscrow()).to.equal(0n);
    expect(await router.communityEscrow()).to.equal(0n);
    expect(await router.founderEscrow()).to.equal(1n);
  });

  it("keeps each leg claimable without coupling destination liveness", async function () {
    const [source, burn, community, founders] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PlankEconomicRouterV2");
    const router = await Factory.deploy(burn.address, community.address, founders.address, [source.address], 0, rulesHash);
    await router.connect(source).routeRake(ethers.ZeroAddress, { value: 10_000n });
    await expect(() => router.claimBurn()).to.changeEtherBalance(ethers, burn, 2_000n);
    expect(await router.accountedBalance()).to.equal(8_000n);
    await expect(() => router.claimCommunity()).to.changeEtherBalance(ethers, community, 4_000n);
    await expect(() => router.claimFounders()).to.changeEtherBalance(ethers, founders, 4_000n);
    expect(await router.accountedBalance()).to.equal(0n);
  });
});
