import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

describe("Plank objective settlement primitives", () => {
  async function deploy(size = 256) {
    return (await (await ethers.getContractFactory("PlankSettlementHarness")).deploy(size)) as any;
  }

  it("computes objective survivor stake and risk-weight prefixes", async () => {
    const harness = await deploy();
    await harness.add(5, 100, 15_000);
    await harness.add(10, 200, 20_000);
    await harness.add(20, 300, 30_000);

    expect(await harness.prefix(4)).to.deep.equal([0n, 0n]);
    expect(await harness.prefix(5)).to.deep.equal([100n, 500_000n]);
    expect(await harness.prefix(10)).to.deep.equal([300n, 2_500_000n]);
    expect(await harness.prefix(20)).to.deep.equal([600n, 8_500_000n]);
  });

  it("moves both aggregates exactly once during a target replacement", async () => {
    const harness = await deploy();
    await harness.add(5, 100, 15_000);
    await harness.replace(5, 15_000, 25, 40_000, 100);
    expect(await harness.prefix(24)).to.deep.equal([0n, 0n]);
    expect(await harness.prefix(25)).to.deep.equal([100n, 3_000_000n]);
  });

  it("reverts rather than allowing aggregate underflow", async () => {
    const harness = await deploy();
    await harness.add(5, 100, 15_000);
    await expect(harness.replace(5, 15_000, 25, 40_000, 101)).to.be.revert(ethers);
  });

  it("matches PFSS base plus risk-surplus arithmetic", async () => {
    const harness = await deploy();
    const safe = await harness.payout(330, 200, 3_500_000, 100, 15_000);
    const hunt = await harness.payout(330, 200, 3_500_000, 100, 40_000);
    expect(safe[0]).to.equal(100n);
    expect(hunt[0]).to.equal(100n);
    expect(hunt[1]).to.be.greaterThan(safe[1]);
    expect(safe[2] + hunt[2]).to.be.at.most(330n);
  });

  it("leaves surplus undistributed when aggregate risk weight is zero", async () => {
    const harness = await deploy();
    const result = await harness.payout(150, 100, 0, 100, 10_000);
    expect(result).to.deep.equal([100n, 0n, 100n]);
  });

  it("rejects nonzero claimant risk against a zero aggregate", async () => {
    const harness = await deploy();
    await expect(harness.payout(150, 100, 0, 100, 20_000)).to.be.revert(ethers);
  });
});
