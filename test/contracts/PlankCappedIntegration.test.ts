import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { deployCasino, closeBetting, findRandomness, settleCurrent, assertConserved } from "./helpers/casino.js";

describe("Capped pool funded integration at monetary extremes", () => {
  for (const stake of [1n, 10n ** 12n, 10n ** 18n, 10n ** 28n]) {
    it(`honors full 2x, keeps protected funds and reconciles withdrawal at stake ${stake}`, async () => {
      const e = await deployCasino({ crash: { minStakeWei: 1n, emissionBufferCapWei: 0n } });
      await networkHelpers.setBalance(e.deployer.address, 100n * stake + ethers.parseEther("10"));
      await e.crash.fundVault({ value: 30n * stake });
      await closeBetting(e); await e.crash.lockRound();
      const r = await e.crash.currentRound(), id = await e.crash.currentRoundId();
      expect(r.seed).eq(3n * stake);
      await networkHelpers.setBalance(e.alice.address, stake + ethers.parseEther("1"));
      await e.crash.connect(e.alice).placeBet(20000n, { value: stake });
      const entropy = await findRandomness(e, id, r.targetDrandRound, c => c >= 20000n);
      const before = await e.crash.protectedPrincipal();
      await settleCurrent(e, entropy);
      expect(await e.crash.paidOf(id, e.alice.address)).eq(2n * stake);
      expect(await e.crash.protectedPrincipal()).at.least(before);
      await assertConserved(e, expect);
      await e.crash.connect(e.alice).withdraw();
      expect(await e.crash.owed(e.alice.address)).eq(0n);
      await assertConserved(e, expect);
    });
  }
  it("cannot reprice a committed round through a post-outcome donation", async () => {
    const e = await deployCasino({ crash: { minStakeWei: 1n, emissionBufferCapWei: 0n } });
    const id = await e.crash.currentRoundId(), r = await e.crash.currentRound();
    await e.crash.connect(e.alice).placeBet(20000n, { value: 10000n });
    const entropy = await findRandomness(e, id, r.targetDrandRound, c => c >= 20000n);
    await closeBetting(e); await e.beacon.setRandomness(r.targetDrandRound, entropy);
    const before = await e.crash.previewSettlement(id, 20000n);
    await e.crash.fundVault({ value: ethers.parseEther("1") });
    const after = await e.crash.previewSettlement(id, 20000n);
    expect([...after.playerPayouts]).deep.eq([...before.playerPayouts]);
    expect([...after.bonuses]).deep.eq([...before.bonuses]);
    await e.crash.settleRound();
    expect(await e.crash.paidOf(id, e.alice.address)).eq(9550n);
    expect((await e.crash.currentRound()).seed).greaterThan(0n);
    await assertConserved(e, expect);
  });
});
