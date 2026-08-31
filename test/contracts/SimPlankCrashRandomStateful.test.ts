/**
 * UNTRACKED ANALYSIS ARTIFACT — item 4: RANDOMIZED STATEFUL differential.
 *
 * For many PRNG seeds, applies a RANDOM sequence of legal actions
 * (fund / bet / lock(+void) / cashOut / reveal / settle / register / claim /
 * carryForward / voidStale / sweep / claimRake / sink-toggle, plus — for the
 * V2 proto — deliverOverflow and forced ETH) to BOTH the on-chain contract
 * and the Node engine, comparing EVERY reachable state variable after EVERY
 * action. This supersedes the scripted V1..V16 vectors as the fidelity
 * evidence: the scripted vectors are REGRESSION evidence (they pin known
 * paths), not a formal proof; the randomized stateful walk explores paths
 * nobody scripted.
 *
 * Phase 1: real PlankCrashDrand + ToggleableJackpotSink vs engine.mjs
 *          (strengthens the baseline fidelity claim).
 * Phase 2: PlankCrashOverflowV2Proto + FaultyJackpotSink vs engine-v2.mjs
 *          (pendingOverflow design under random interleaving, §8.1 identity
 *          asserted by the model on every transition).
 */
import { expect } from "chai";
// Typed bigint comparison helpers (chai's number|Date overloads don't accept bigint;
// hardhat-chai-matchers is not installed here). Assert on booleans to stay type-clean.
const bnLte = (a: bigint, b: bigint, msg?: string) => expect(a <= b, msg ?? `${a} <= ${b}`).to.equal(true);
const bnGt  = (a: bigint, b: bigint, msg?: string) => expect(a >  b, msg ?? `${a} > ${b}`).to.equal(true);
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";
// @ts-ignore — plain-JS models, no types
import { Engine, invertMultiplier } from "../../docs/marketplank/sim-plankcrash/engine.mjs";
// @ts-ignore
import { EngineV2 } from "../../docs/marketplank/sim-plankcrash/engine-v2.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SIM_DIR = join(__dir, "../../docs/marketplank/sim-plankcrash");

const DRAND_PERIOD = 3n;
const DRAND_GENESIS = 1727521075n;
const BETTING = 30;
const MAX_ELAPSED = 40;
const REG = 6;
const AWAIT = 60;
const E = (x: string) => ethers.parseEther(x);

const summary: any = { phase1: [], phase2: [] };

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rng: () => number, xs: T[]) => xs[Math.floor(rng() * xs.length)];

async function deployPair(kind: "baseline" | "v2") {
  const signers = await ethers.getSigners();
  const [deployer, treasury, ...players] = signers;
  const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
  const sink: any = await (await ethers.getContractFactory(kind === "baseline" ? "ToggleableJackpotSink" : "FaultyJackpotSink")).deploy();
  const cfg: Record<string, any> = {
    bettingDurationSeconds: BETTING, roundIntervalSeconds: 0, maxAwaitBlocks: AWAIT,
    maxElapsedBlocks: MAX_ELAPSED, registrationWindowBlocks: REG, rakeBps: 450n,
    minParticipants: 2n, minPoolSize: E("0.001"), maxStakePerWalletBps: 10000n,
    keeperRewardBps: 500n, seedNumerator: 1n, seedDenominator: 2n, reserveShareBps: 5000n,
    reserveFloorWei: 0n, reserveCap: E("2"), jackpotSink: await sink.getAddress(),
    treasury: treasury.address, beacon: await beacon.getAddress(),
    ...hardeningFor(MAX_ELAPSED), seedBootstrapBudgetWei: E("0.2"),
  };
  const factory = kind === "baseline" ? "PlankCrashDrand" : "PlankCrashOverflowV2Proto";
  const crash: any = await (await ethers.getContractFactory(factory)).deploy(cfg);
  if (kind === "v2") await sink.setTarget(await crash.getAddress());
  const rcpt = await crash.deploymentTransaction()!.wait();
  const blk = await ethers.provider.getBlock(rcpt!.blockNumber);
  const ecfg = {
    rakeBps: cfg.rakeBps, minParticipants: cfg.minParticipants, minPoolSize: cfg.minPoolSize,
    maxStakePerWalletBps: cfg.maxStakePerWalletBps, keeperRewardBps: cfg.keeperRewardBps,
    keeperRevealBps: cfg.keeperRevealBps, keeperLockBps: cfg.keeperLockBps,
    seedNumerator: cfg.seedNumerator, seedDenominator: cfg.seedDenominator,
    reserveShareBps: cfg.reserveShareBps, reserveFloorWei: cfg.reserveFloorWei,
    reserveCap: cfg.reserveCap, jackpotSink: cfg.jackpotSink,
    seedMaxBps: cfg.seedMaxBps, singlePayoutCapBps: cfg.singlePayoutCapBps,
    dailyDrawdownBps: cfg.dailyDrawdownBps, hwmDrawdownBps: cfg.hwmDrawdownBps,
    maxMultiplierBps: cfg.maxMultiplierBps, registrationWindowBlocks: BigInt(REG),
    seedBootstrapBudgetWei: cfg.seedBootstrapBudgetWei,
  };
  // CANONICAL BRANCH: the real PlankCrashDrand now carries pendingOverflow, so BOTH the "baseline"
  // (canonical contract) and the proto are modeled by EngineV2. Phase 1 is now a live differential
  // on the CANONICAL contract itself; phase 2 keeps the proto for redundancy. (The old Engine —
  // pre-pendingOverflow — is retained for the SUPERSEDED-precanonical differential only.)
  void Engine;
  const model: any = new EngineV2(ecfg, BigInt(blk!.timestamp));
  return { kind, crash, beacon, sink, cfg, model, deployer, treasury, players: players.slice(0, 4) };
}

/** Full-state differential compare (superset of the scripted harness's sync). */
async function sync(label: string, ctx: any) {
  const { crash, sink, model, kind } = ctx;
  const s = model.snapshot();
  const checks: [string, bigint, bigint][] = [
    ["reserve", await crash.reserve(), s.reserve],
    ["seedBudget", await crash.seedBudget(), s.seedBudget],
    ["reserveHighWaterMark", await crash.reserveHighWaterMark(), s.reserveHighWaterMark],
    ["drawdownWindowStart", await crash.drawdownWindowStart(), s.drawdownWindowStart],
    ["drawdownWindowPeak", await crash.drawdownWindowPeak(), s.drawdownWindowPeak],
    ["accumulatedRake", await crash.accumulatedRake(), s.accumulatedRake],
    ["currentRoundId", await crash.currentRoundId(), s.currentRoundId],
    ["sinkBalance", await ethers.provider.getBalance(await sink.getAddress()), s.sinkBalance],
  ];
  if (kind === "v2") {
    checks.push(["pendingOverflow", await crash.pendingOverflow(), s.pendingOverflow]);
    // V2 hard invariants under random interleaving:
    const cap = model.cfg.reserveCap;
    if (s.reserve > cap || s.pendingOverflow < 0n) throw new Error(`${label}: V2 cap invariant broken`);
  }
  const bal = await ethers.provider.getBalance(await crash.getAddress());
  const expectedBal: bigint = BigInt(model.totalDeposits) + BigInt(model.forcedEth ?? 0n) - BigInt(s.sinkBalance) - BigInt(model.escrowTotal()) - BigInt(model.paidOut ?? 0n);
  checks.push(["contractBalance", bal, expectedBal]);
  for (const [id, mr] of model.rounds) {
    const cr = await crash.rounds(id);
    checks.push(
      [`r${id}.phase`, BigInt(cr.phase), BigInt(mr.phase)],
      [`r${id}.pool`, cr.pool, mr.pool],
      [`r${id}.rolledOver`, cr.rolledOverFromPrevious, mr.rolledOverFromPrevious],
      [`r${id}.distributable`, cr.distributable, mr.distributable],
      [`r${id}.totalWinningWeight`, cr.totalWinningWeight, mr.totalWinningWeight],
      [`r${id}.provWinningWeight`, cr.provisionalWinningWeight, mr.provisionalWinningWeight],
      [`r${id}.provProfitWeight`, cr.provisionalProfitWeight, mr.provisionalProfitWeight],
      [`r${id}.totalWinningProfitWeight`, cr.totalWinningProfitWeight, mr.totalWinningProfitWeight],
      [`r${id}.reserveAtLock`, cr.reserveAtLock, mr.reserveAtLock],
      [`r${id}.crashElapsedBlocks`, cr.crashElapsedBlocks, mr.crashElapsedBlocks]
    );
    for (const [addr, p] of mr.players) {
      checks.push(
        [`r${id}.stakeOf(${addr.slice(0, 8)})`, await crash.stakeOf(id, addr), p.stake],
        [`r${id}.cashOutBlockOf(${addr.slice(0, 8)})`, await crash.cashOutBlockOf(id, addr), p.cashOutBlock],
        [`r${id}.registered(${addr.slice(0, 8)})`, BigInt((await crash.registered(id, addr)) ? 1 : 0), BigInt(p.registered ? 1 : 0)],
        [`r${id}.claimed(${addr.slice(0, 8)})`, BigInt((await crash.claimed(id, addr)) ? 1 : 0), BigInt(p.claimed ? 1 : 0)]
      );
    }
  }
  for (const [who, owed] of model.escrow) {
    checks.push([`payments(${who.slice(0, 8)})`, await crash.payments(who), owed]);
  }
  const mism = checks.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n}: chain=${a} model=${b}`);
  if (mism.length) throw new Error(`RANDOM-STATEFUL MISMATCH at "${label}": ${mism.join("; ")}`);
}

/** One randomized walk of `steps` actions. Returns per-action counts. */
async function randomWalk(ctx: any, seed: number, steps: number) {
  const { kind, crash, beacon, sink, model, deployer, players } = ctx;
  const rng = mulberry32(seed);
  const counts: Record<string, number> = {};
  const maxMultBps: bigint = model.cfg.maxMultiplierBps;
  const maxMultElapsed: bigint = model.maxMultiplierElapsedBlocks;
  let sinkOk = true;
  const sweptRounds = new Set<string>();

  // prime the vault so seeding paths are live
  await crash.connect(deployer).fundVault({ value: E("1.5") });
  model.fundVault(E("1.5"));
  await sync("prime", ctx);

  for (let step = 0; step < steps; step++) {
    const id: bigint = model.currentRoundId;
    const r = model.round(id);
    const nextBlock = BigInt(await ethers.provider.getBlockNumber()) + 1n;
    const now = BigInt(await networkHelpers.time.latest());
    const cr = await crash.rounds(id);

    // ── enumerate legal actions from current (model) state ──────────────
    const actions: { name: string; run: () => Promise<void> }[] = [];

    actions.push({
      name: "fund",
      run: async () => {
        const amt = E((0.05 + rng() * 1.5).toFixed(6));
        await crash.connect(deployer).fundVault({ value: amt });
        model.fundVault(amt);
      },
    });
    actions.push({
      name: "sinkToggle",
      run: async () => {
        sinkOk = !sinkOk;
        if (kind === "baseline") {
          await sink.setReverting(!sinkOk);
        } else {
          await sink.setMode(sinkOk ? 0 : 1); // OK / REVERT
        }
        model.sinkOk = sinkOk;
      },
    });
    if (model.accumulatedRake > 0n) {
      actions.push({
        name: "claimRake",
        run: async () => {
          await crash.claimRake();
          model.claimRake(ctx.treasury.address);
        },
      });
    }

    if (r.phase === 0 /* BETTING */ && now + 1n < cr.bettingEndsAt) {
      const fresh: any[] = (players as any[]).filter((p: any) => !r.players.has(p.address));
      if (fresh.length) {
        actions.push({
          name: "bet",
          run: async () => {
            const who: any = pick(rng, fresh);
            const amt = E((0.05 + rng() * 0.8).toFixed(6));
            const auto = rng() < 0.5 ? 0n : 10001n + BigInt(Math.floor(rng() * Number(maxMultBps - 10001n)));
            await crash.connect(who).placeBet(auto, { value: amt });
            model.placeBet(who.address, amt, auto);
          },
        });
        // carry-forward from a voided round, if one exists for this player
        for (const [vid, vr] of model.rounds) {
          if (!vr.voided) continue;
          for (const who of fresh) {
            const vp = vr.players.get(who.address);
            if (vp && !vp.carried && vp.stake > 0n) {
              actions.push({
                name: "carryForward",
                run: async () => {
                  await crash.connect(who).carryForwardStake(vid);
                  model.carryForwardStake(vid, who.address);
                },
              });
            }
          }
        }
      }
      actions.push({
        name: "lock",
        run: async () => {
          await networkHelpers.time.increase(BETTING + 1);
          const tx = await crash.lockRound();
          const rc = await tx.wait();
          const blk = await ethers.provider.getBlock(rc.blockNumber);
          const cr2 = await crash.rounds(id);
          model.lockRound({
            blockNumber: BigInt(rc.blockNumber), timestamp: BigInt(blk!.timestamp),
            targetDrandRound: cr2.targetDrandRound, revealNotBefore: cr2.revealNotBefore,
            keeper: deployer.address,
          });
        },
      });
    }

    if (r.phase === 1 /* LIVE */ && !r.entropyRevealed) {
      // manual cash-out while the window is provably open
      if (now + 2n < r.revealNotBefore) {
        for (const who of players) {
          const p = r.players.get(who.address);
          if (!p || p.stake === 0n || p.cashOutBlock !== 0n) continue;
          const elapsed = nextBlock - r.lockBlock;
          if (elapsed > maxMultElapsed) continue;
          if (p.auto !== 0n && elapsed >= invertMultiplier(p.auto)) continue;
          actions.push({
            name: "cashOut",
            run: async () => {
              const tx = await crash.connect(who).cashOut(id);
              const rc = await tx.wait();
              model.cashOut(id, who.address, BigInt(rc.blockNumber));
            },
          });
          break; // one candidate per step is enough
        }
      }
      actions.push({
        name: "reveal",
        run: async () => {
          const rnd = ethers.keccak256(ethers.toUtf8Bytes(`rnd-${seed}-${step}`));
          const nowT = BigInt(await networkHelpers.time.latest());
          if (r.revealNotBefore > nowT) await networkHelpers.time.increaseTo(r.revealNotBefore);
          await beacon.setRandomness(r.targetDrandRound, rnd);
          await crash.revealEntropy(id);
          model.revealEntropy(id, BigInt(rnd), deployer.address);
        },
      });
      if (rng() < 0.5) {
        actions.push({
          name: "voidStale",
          run: async () => {
            const cur = BigInt(await ethers.provider.getBlockNumber());
            const need = r.lockBlock + BigInt(AWAIT) + 1n;
            if (need > cur) await networkHelpers.mine(Number(need - cur));
            const tx = await crash.voidStaleRound(id);
            const rc = await tx.wait();
            const blk = await ethers.provider.getBlock(rc.blockNumber);
            model.voidStaleRound(id, BigInt(blk!.timestamp));
          },
        });
      }
    }

    if (r.phase === 1 && r.entropyRevealed) {
      actions.push({
        name: "settle",
        run: async () => {
          const eff = r.trueCrashElapsedBlocks < maxMultElapsed ? r.trueCrashElapsedBlocks : maxMultElapsed;
          const cur = BigInt(await ethers.provider.getBlockNumber());
          const target = r.lockBlock + eff;
          if (target > cur) await networkHelpers.mine(Number(target - cur));
          const tx = await crash.settleRound(id);
          const rc = await tx.wait();
          const blk = await ethers.provider.getBlock(rc.blockNumber);
          model.settleRound(id, { blockNumber: BigInt(rc.blockNumber), timestamp: BigInt(blk!.timestamp), keeper: deployer.address });
        },
      });
    }

    // past crashed rounds: register / claim / sweep
    for (const [pid, pr] of model.rounds) {
      if (pr.phase !== 2 /* CRASHED */) continue;
      for (const who of players) {
        const p = pr.players.get(who.address);
        if (!p) continue;
        if (!p.registered && nextBlock <= pr.registrationDeadlineBlock) {
          actions.push({
            name: "register",
            run: async () => {
              await crash.registerResult(pid, who.address);
              model.registerResult(pid, who.address);
            },
          });
        }
        if (p.registered && !p.claimed && p.weight > 0n && nextBlock > pr.registrationDeadlineBlock) {
          actions.push({
            name: "claim",
            run: async () => {
              await crash.claim(pid, who.address);
              model.claim(pid, who.address);
            },
          });
        }
      }
      if (pr.totalWinningWeight === 0n && !sweptRounds.has(pid.toString()) && nextBlock > pr.registrationDeadlineBlock) {
        actions.push({
          name: "sweep",
          run: async () => {
            await crash.sweepBustedRound(pid);
            model.sweepBustedRound(pid);
            sweptRounds.add(pid.toString());
          },
        });
      }
    }

    if (kind === "v2") {
      actions.push({
        name: "deliver",
        run: async () => {
          const before: bigint = await crash.pendingOverflow();
          await (await crash.deliverOverflow()).wait();
          const after: bigint = await crash.pendingOverflow();
          if (before > 0n) {
            if (after !== 0n && after !== before) throw new Error("partial restore on deliverOverflow");
            model.deliverOverflow(after === 0n);
          }
        },
      });
      if (rng() < 0.1) {
        actions.push({
          name: "forceEth",
          run: async () => {
            const amt = E((0.01 + rng() * 0.5).toFixed(6));
            const Force = await ethers.getContractFactory("ForceSend");
            await (await Force.deploy(await crash.getAddress(), { value: amt })).waitForDeployment();
            model.forceEth(amt);
          },
        });
      }
    }

    const act = pick(rng, actions);
    counts[act.name] = (counts[act.name] ?? 0) + 1;
    await act.run();
    await sync(`seed${seed} step${step} ${act.name}`, ctx);
  }
  return counts;
}

describe("SimPlankCrashRandomStateful: randomized stateful differential (item 4)", () => {
  after(() => {
    mkdirSync(SIM_DIR, { recursive: true });
    writeFileSync(
      join(SIM_DIR, "random-stateful-summary.json"),
      JSON.stringify(
        {
          classification:
            "This randomized stateful differential is the fidelity evidence; the scripted V1..V16 vectors in SimPlankCrashDifferential.test.ts are REGRESSION evidence, not formal proof.",
          ...summary,
        },
        null,
        1
      )
    );
  });

  for (const seed of [11, 23, 47, 89, 131]) {
    it(`phase 1 baseline fuzz seed=${seed}: real PlankCrashDrand vs engine — every state var after every action`, async function () {
      this.timeout(300000);
      const ctx = await deployPair("baseline");
      const counts = await randomWalk(ctx, seed, 60);
      summary.phase1.push({ seed, steps: 60, counts });
      expect(ctx.model.incomeBoundHolds()).to.equal(true);
    });
  }

  for (const seed of [7, 61, 199]) {
    it(`phase 2 V2-proto fuzz seed=${seed}: PlankCrashOverflowV2Proto vs engine-v2 (deliver + forced ETH in the mix)`, async function () {
      this.timeout(300000);
      const ctx = await deployPair("v2");
      const counts = await randomWalk(ctx, seed, 60);
      summary.phase2.push({ seed, steps: 60, counts });
      // V2 invariants held every step via sync(); final spot checks:
      bnLte(await ctx.crash.reserve(), E("2"));
      bnLte(await ctx.crash.drawdownWindowPeak(), E("2"));
      bnLte(await ctx.crash.reserveHighWaterMark(), E("2"));
      expect(ctx.model.incomeBoundHolds()).to.equal(true);
    });
  }
});
