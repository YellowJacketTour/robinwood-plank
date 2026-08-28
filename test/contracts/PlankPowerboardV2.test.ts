import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

describe("PlankPowerboardV2", function () {
  const rulesHash = ethers.keccak256(ethers.toUtf8Bytes("plank-powerboard-v2-test-rules"));
  async function fixture() {
    const [settler, founder, funder, winner] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PlankPowerboardV2");
    const board = await Factory.deploy(
      settler.address,
      founder.address,
      500, // 5% recurring epoch fee
      100, // 1% consolation
      1_000n,
      10n,
      100n,
      1_000, // base grows by max(100, 10%)
      rulesHash,
    );
    return { board, settler, founder, funder, winner };
  }

  it("proves the exact minimumGross one-wei boundary", async function () {
    const { board } = await fixture();
    for (const target of [1n, 2n, 999n, 1_000n, 1_001n, 10_000n]) {
      const gross = await board.minimumGross(target);
      const net = gross - (gross * 500n) / 10_000n;
      expect(net).to.be.gte(target);
      if (gross > 0n) {
        const prior = gross - 1n;
        expect(prior - (prior * 500n) / 10_000n).to.be.lt(target);
      }
    }
  });

  it("will not seal without both monotonic growth and the next reset", async function () {
    const { board, funder } = await fixture();
    const growth = await board.minimumGross(1_000n);
    await board.connect(funder).fundGrowth({ value: growth });
    await expect(board.sealNextEpoch()).to.be.revertedWithCustomError(board, "ResetNotCovered");
    const reset = await board.requiredResetCoverage();
    await board.connect(funder).fundReset({ value: reset });
    await board.sealNextEpoch();
    expect((await board.epochs(1)).netPrize).to.equal(1_000n);
    expect(await board.accountedBalance()).to.equal(growth + reset);
  });

  it("charges rollover again but refuses a shrinking miss iteration", async function () {
    const { board, settler, funder, winner } = await fixture();
    const firstGross = await board.minimumGross(1_000n);
    await board.connect(funder).fundGrowth({ value: firstGross });
    await board.connect(funder).fundReset({ value: await board.requiredResetCoverage() });
    await board.sealNextEpoch();
    await board.connect(settler).settleEpoch(winner.address, false);

    const requiredFresh = await board.requiredFreshForNextEpoch();
    expect(requiredFresh).to.be.gt(0n);
    await board.connect(funder).fundGrowth({ value: requiredFresh - 1n });
    await expect(board.sealNextEpoch()).to.be.revertedWithCustomError(board, "InsufficientGrowthFunding");
    await board.connect(funder).fundGrowth({ value: 1n });
    await board.sealNextEpoch();
    const second = await board.epochs(2);
    expect(second.netPrize).to.be.gte(1_010n);
    expect(second.founderFeeOnRollover).to.equal((second.rolloverIn * 500n) / 10_000n);
  });

  it("pays a hit in full and restarts from a strictly higher covered base", async function () {
    const { board, settler, funder, winner } = await fixture();
    const firstGross = await board.minimumGross(1_000n);
    const resetGross = await board.requiredResetCoverage();
    await board.connect(funder).fundGrowth({ value: firstGross });
    await board.connect(funder).fundReset({ value: resetGross });
    await board.sealNextEpoch();
    await board.connect(settler).settleEpoch(winner.address, true);

    expect(await board.claimable(winner.address)).to.equal(1_000n);
    expect(await board.currentBase()).to.equal(1_100n);
    expect(await board.rolloverCredit()).to.equal(resetGross);
    expect(await board.cycle()).to.equal(1n);
    // The following cycle cannot become drawable until its own still-higher
    // reset is covered, even though its 1,100 net starting base is prefunded.
    await expect(board.sealNextEpoch()).to.be.revertedWithCustomError(board, "ResetNotCovered");
    await board.connect(funder).fundReset({ value: await board.requiredResetCoverage() });
    await board.sealNextEpoch();
    expect((await board.epochs(2)).netPrize).to.equal(1_100n);
  });

  it("keeps winner, founder, rollover, reset, and active-prize liabilities conserved", async function () {
    const { board, settler, founder, funder, winner } = await fixture();
    const growth = await board.minimumGross(1_000n);
    const reset = await board.requiredResetCoverage();
    await board.connect(funder).fundGrowth({ value: growth });
    await board.connect(funder).fundReset({ value: reset });
    await board.sealNextEpoch();
    expect(await board.accountedBalance()).to.equal(await ethers.provider.getBalance(board));
    await board.connect(settler).settleEpoch(winner.address, false);
    expect(await board.accountedBalance()).to.equal(await ethers.provider.getBalance(board));
    await expect(() => board.connect(winner).claim()).to.changeEtherBalance(ethers, winner, 10n);
    await expect(() => board.claimFounderFees()).to.changeEtherBalance(ethers, founder, growth - 1_000n);
    expect(await board.accountedBalance()).to.equal(await ethers.provider.getBalance(board));
  });
});
