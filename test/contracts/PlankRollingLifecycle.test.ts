import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { assertConserved, bet, closeBetting, deployCasino, increaseToAtLeast, settleCurrent, findRandomness } from "./helpers/casino.js";

describe("Rolling lifecycle conservation soak", () => {
  it("rolls 96 funded, empty and beacon-timeout rounds without losing obligations or reducing protected principal", async function () {
    this.timeout(120000);
    const env = await deployCasino({ cycleLottery: true, crash: { maxVaultBonusBps: 2500n, vaultBonusDecayWad: 999000000000000000n }, lottery: { contributionBps: 4485n, carveDecayWad: 999000000000000000n, carveHalfSaturationCeilingWei: 2500000n * 10n ** 12n } });
    await env.crash.fundVault({value: ethers.parseEther("0.1")});
    await env.lottery.fund({value: ethers.parseEther("0.001")});
    let principal = await env.crash.protectedPrincipal(), settled = 0, voided = 0, recovered = 0;
    const targets = [10100n, 12500n, 20000n, 50000n, 100000n, 1000000n];
    for (let i = 0; i < 96; i++) {
      const id = await env.crash.currentRoundId();
      if (i % 16 === 0) {
        await closeBetting(env); await env.crash.lockRound(); voided++;
      } else {
        await bet(env, env.alice, "0.001", targets[i % targets.length]);
        await bet(env, env.bob, "0.002", targets[(i + 1) % targets.length]);
        await bet(env, env.carol, "0.003", targets[(i + 2) % targets.length]);
        if (i % 16 === 1) {
          await closeBetting(env); await env.crash.lockRound();
          const round = await env.crash.rounds(id);
          await increaseToAtLeast(round.revealNotBefore + env.crashConfig.refundTimeoutSeconds);
          await expect(env.crash.refundRound()).revertedWithCustomError(env.crash,"CommittedRoundCannotBeCancelled");
          await env.crash.freezeStalledRound();
          await settleCurrent(env,ethers.toBeHex(i+1,32));
          settled++;
          recovered++;
        } else {
          let randomness=ethers.toBeHex(i+1,32);
          if(i===2){
            // Guarantee payout coverage independently of deployment address,
            // which changes the domain-separated seed when bytecode changes.
            const r=await env.crash.rounds(id);
            const rake=await env.crash.effectiveRakeBps(),gross=r.playerPool-r.playerPool*(10000n-rake)/10000n;
            const net=gross-gross*env.crashConfig.keeperRewardBps/10000n;
            const quote=await env.lottery.quote(),count=await env.lottery.ballCountFor(net,quote[0]);expect(count).greaterThan(0n);
            randomness=await findRandomness(env,id,r.targetDrandRound,(_crash,seed)=>BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32'],[ethers.id('PLANK_NUMBERED_BALL_V1'),seed])))%count===count-1n);
          }
          const result = await settleCurrent(env, randomness);
          expect(result.receipt.logs.some((log: any) => { try { return env.lottery.interface.parseLog(log)?.name === "Draw"; } catch { return false; } }), `draw ${id} must complete`).eq(true);
          settled++;
        }
      }
      await env.crash.flushRake();
      expect(await env.crash.currentRoundId()).eq(id + 1n);
      expect((await env.crash.currentRound()).phase).eq(0n);
      expect(await env.crash.protectedPrincipal()).at.least(principal);
      principal = await env.crash.protectedPrincipal();
      expect(await env.crash.reserve()).at.least(principal);
      const quote = await env.lottery.quote();
      const breakdown = await env.lottery.quoteBreakdown();
      expect(quote[1] + quote[2] + breakdown[3]).eq(quote[0]);
      expect(await ethers.provider.getBalance(await env.lottery.getAddress())).eq(await env.lottery.accountedBalance());
      expect(quote[0]).at.most(await env.lottery.pool());
      await assertConserved(env, expect);
    }
    expect({settled, voided, recovered}).deep.eq({settled: 90, voided: 6, recovered: 6});
    expect(await env.lottery.hits(), "seeded deterministic run exercises actual payouts").greaterThan(0n);
  });
});
