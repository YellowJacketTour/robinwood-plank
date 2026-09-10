import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { bet, deployCasino, netRakeOf, settleCurrent, increaseToAtLeast } from "./helpers/casino.js";

async function matureCrash(crash: any) {
  // Test-only maturity fast-forward, discovering and validating the getter's
  // slot rather than assuming a storage layout. Every other slot is restored.
  const addr = await crash.getAddress();
  for (let i = 0; i < 60; i++) {
    const slot = ethers.toBeHex(i, 32), old = await ethers.provider.getStorage(addr, slot);
    await ethers.provider.send("hardhat_setStorageAt", [addr, slot, ethers.toBeHex(4000n, 32)]);
    if (await crash.roundsContributed() === 4000n) return;
    await ethers.provider.send("hardhat_setStorageAt", [addr, slot, old]);
  }
  throw new Error("maturity slot not found");
}

describe("Lottery board terms are committed before entropy", () => {
  for (const numberedLottery of [false, true]) it(`${numberedLottery ? "numbered" : "legacy"}: public post-reveal donations cannot reprice the current draw`, async () => {
    const env = await deployCasino({ numberedLottery, lottery: { contributionBps: 4485n, carveDecayWad: 999000000000000000n, carveHalfSaturationCeilingWei: 2500000n * 10n ** 12n } });
    await env.lottery.fund({ value: ethers.parseEther("1") });
    await bet(env, env.alice, "0.01", 10100n); await bet(env, env.bob, "0.01", 10100n);
    await settleCurrent(env, ethers.toBeHex(1, 32)); // commits the first funded board
    await matureCrash(env.crash);
    const before = await env.lottery.quote();
    const rake = netRakeOf(ethers.parseEther("0.02"));
    const threshold = await env.lottery.hitThreshold(rake, before[0]);
    const count = numberedLottery ? await env.lottery.ballCountFor(rake, before[0]) : 0n;
    await bet(env, env.alice, "0.01", 10100n); await bet(env, env.bob, "0.01", 10100n);
    const id = await env.crash.currentRoundId(), round = await env.crash.rounds(id);
    await increaseToAtLeast(round.revealNotBefore);
    await env.beacon.setRandomness(round.targetDrandRound, ethers.toBeHex(42, 32));
    const age = await env.lottery.roundsContributed();
    // Actual permissionless attack entry point, after entropy is public.
    await env.crash.connect(env.carol).fundVault({ value: 1n });
    expect(await env.lottery.roundsContributed()).eq(age + 1n);
    expect((await env.lottery.carve(before[0]))[0]).greaterThan(before[1]); // live curve DID change
    expect(await env.lottery.quote()).deep.eq(before);
    expect(await env.lottery.hitThreshold(rake, before[0])).eq(threshold);
    if (numberedLottery) expect(await env.lottery.ballCountFor(rake, before[0])).eq(count);
    const receipt = await (await env.crash.settleRound()).wait();
    const draw = receipt.logs.map((log: any) => { try { return env.lottery.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "Draw");
    expect(draw, "draw completed instead of being swallowed").not.eq(undefined);
    expect(draw.args.threshold).eq(threshold);
    if (draw.args.hit) { expect(draw.args.winnerPaid).eq(before[1]); expect(draw.args.seeded).eq(before[2]); }
    const next = await env.lottery.quote();
    expect(next[1] + next[2]).eq(next[0]);
    expect(await ethers.provider.getBalance(await env.lottery.getAddress())).eq(await env.lottery.accountedBalance());
  });
});
