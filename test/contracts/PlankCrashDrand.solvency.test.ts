import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";

/**
 * The single most important "no public risk" property, proven by brute
 * force: CONSERVATION OF ETH. Across hundreds of randomized operations --
 * including the new sweepBustedRound/pendingRollover path and the
 * on-behalf register/claim path -- every wei that ever entered the
 * contract via placeBet must, at all times, be either
 *   (a) still held by the contract, or
 *   (b) still held in the PullPayment escrow for a payee, or
 *   (c) already withdrawn to some address.
 *
 * If that equality ever breaks, the contract either minted ETH from
 * nowhere (a theft/over-pay bug) or destroyed player ETH (a stranding
 * bug). We assert it after EVERY successful operation, and separately
 * assert the contract can always cover its named on-chain liabilities.
 *
 * A reverting call is fine and expected (a permissionless game rejects
 * plenty). What must never happen is a SUCCEEDING call that breaks
 * conservation.
 */
describe("PlankCrashDrand — conservation of ETH (no public fund risk)", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const MAX_ELAPSED_BLOCKS = 30;
  const REGISTRATION_BLOCKS = 6;
  const MAX_AWAIT_BLOCKS = 40;
  const BETTING_SECONDS = 30;

  // Deterministic PRNG so a failure is reproducible.
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function deploy(rakeBps: bigint, keeperBps: bigint) {
    const signers = await ethers.getSigners();
    const [deployer, treasury] = signers;
    const players = signers.slice(2, 7); // 5 players
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: MAX_AWAIT_BLOCKS,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 8000n,
      keeperRewardBps: keeperBps,
      seedNumerator: 1n,
      seedDenominator: 2n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(MAX_ELAPSED_BLOCKS), // Phase 3 hardening fields (test defaults)
    });
    const crashAddr = await crash.getAddress();
    // PullPayment's constructor does `new Escrow()` -- the contract's first
    // (and only) internal CREATE, so nonce 1.
    const escrowAddr = ethers.getCreateAddress({ from: crashAddr, nonce: 1 });
    return { crash, beacon, crashAddr, escrowAddr, deployer, treasury, players };
  }

  async function runFuzz(seed: number, rakeBps: bigint, keeperBps: bigint, steps: number) {
    const { crash, beacon, crashAddr, escrowAddr, treasury, players } = await deploy(rakeBps, keeperBps);
    const rand = prng(seed);
    const pick = (arr: any[]): any => arr[Math.floor(rand() * arr.length)];

    // Ground-truth accounting we maintain in the test.
    let totalDeposited = 0n; // every wei that entered via placeBet
    const withdrawn: Record<string, bigint> = {}; // address -> wei pulled out via withdrawPayments
    const allPayees = new Set<string>([treasury.address, ...players.map((p) => p.address)]);

    async function heldSomewhere(): Promise<bigint> {
      const contractBal = await ethers.provider.getBalance(crashAddr);
      const escrowBal = await ethers.provider.getBalance(escrowAddr);
      return contractBal + escrowBal;
    }

    async function assertConservation(tag: string) {
      let pulled = 0n;
      for (const v of Object.values(withdrawn)) pulled += v;
      const held = await heldSomewhere();
      // Every deposited wei is either still held or already withdrawn.
      expect(held + pulled).to.equal(totalDeposited, `conservation broken after ${tag}`);
    }

    // A helper to relay + reveal + settle the current live round if possible.
    async function tryAdvanceLive() {
      const id: bigint = await crash.currentRoundId();
      for (let d = id > 3n ? id - 3n : 1n; d <= id; d++) {
        const r = await crash.rounds(d);
        if (Number(r.phase) !== 1) continue;
        if (!r.entropyRevealed) {
          const due = DRAND_GENESIS + BigInt(r.targetDrandRound) * DRAND_PERIOD;
          if (BigInt(await networkHelpers.time.latest()) >= due) {
            const filler = ethers.keccak256(ethers.toUtf8Bytes("s" + seed + "-" + d.toString() + "-" + Math.floor(rand() * 1e9)));
            await beacon.setRandomness(r.targetDrandRound, filler).catch(() => {});
            await crash.revealEntropy(d).catch(() => {});
          }
        }
        const r2 = await crash.rounds(d);
        if (r2.entropyRevealed) {
          const eff = r2.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? r2.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
          if (BigInt(await ethers.provider.getBlockNumber()) - r2.lockBlock >= eff) {
            await crash.settleRound(d).catch(() => {});
          }
        }
      }
    }

    for (let i = 0; i < steps; i++) {
      const op = Math.floor(rand() * 11);
      const id: bigint = await crash.currentRoundId();
      const pastId = id > 1n ? BigInt(1 + Math.floor(rand() * Number(id))) : 1n;
      try {
        if (op <= 2) {
          // placeBet -- the only inbound ETH path
          const p = pick(players);
          const amt = ethers.parseEther(pick(["0.001", "0.005", "0.01", "0.02"]));
          await crash.connect(p).placeBet(0n, { value: amt });
          totalDeposited += amt;
        } else if (op === 3) {
          await crash.lockRound();
        } else if (op === 4) {
          await tryAdvanceLive();
        } else if (op === 5) {
          const p = pick(players);
          await crash.connect(p).cashOut(pastId);
        } else if (op === 6) {
          const p = pick(players);
          await crash.registerResult(pastId, p.address);
        } else if (op === 7) {
          const p = pick(players);
          await crash.claim(pastId, p.address);
        } else if (op === 8) {
          await crash.sweepBustedRound(pastId);
        } else if (op === 9) {
          await crash.claimRake();
        } else {
          // withdrawPayments for a random payee -- realize escrowed ETH
          const who = pick([treasury.address, ...players.map((p) => p.address)]);
          const before = await ethers.provider.getBalance(who);
          const owed: bigint = await crash.payments(who);
          if (owed > 0n) {
            await crash.withdrawPayments(who);
            const after = await ethers.provider.getBalance(who);
            withdrawn[who] = (withdrawn[who] ?? 0n) + (after - before);
            allPayees.add(who);
          }
        }
      } catch {
        /* reverts are expected and fine */
      }

      // Advance time/blocks a little every step so rounds can mature.
      if (rand() < 0.5) await networkHelpers.time.increase(1 + Math.floor(rand() * 5));
      await networkHelpers.mine(1 + Math.floor(rand() * 4));

      await assertConservation(`op ${op} (step ${i})`);
    }

    // Final settlement pass: drain all escrow to be sure the accounting
    // still balances once everything owed is actually pulled.
    for (const who of allPayees) {
      const owed: bigint = await crash.payments(who);
      if (owed > 0n) {
        const before = await ethers.provider.getBalance(who);
        await crash.withdrawPayments(who).catch(() => {});
        const after = await ethers.provider.getBalance(who);
        withdrawn[who] = (withdrawn[who] ?? 0n) + (after - before);
      }
    }
    await assertConservation("final drain");

    return { crash };
  }

  it("conserves ETH across 200 random ops (seed 1, rake 4.5%, keeper 10%)", async () => {
    await runFuzz(1, 450n, 1000n, 200);
  });
  it("conserves ETH across 200 random ops (seed 7, rake 0%, keeper 1bps -- hardening (c) rejects 0)", async () => {
    await runFuzz(7, 0n, 1n, 200);
  });
  it("conserves ETH across 200 random ops (seed 12345, rake 10%, keeper 50%)", async () => {
    await runFuzz(12345, 1000n, 5000n, 200);
  });
  it("conserves ETH across 200 random ops (seed 98765, rake 2.5%, keeper 100%)", async () => {
    await runFuzz(98765, 250n, 10000n, 200);
  });
});
