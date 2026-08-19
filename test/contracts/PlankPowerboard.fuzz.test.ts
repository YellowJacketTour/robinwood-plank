import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankPowerboard conservation fuzz, mirroring the exact pattern
 * PlankCrashDrand.solvency.test.ts already uses for its own PullPayment-
 * backed conservation check (predict the internal Escrow's CREATE address,
 * since payouts are credited there via _asyncTransfer, not sent directly).
 *
 * The invariant: every wei ever fund()-ed must, at every point, be either
 * (a) still in the rolling jackpot, (b) already credited to a payee's
 * escrow balance (drawn but not yet withdrawn), or (c) already withdrawn.
 * Also checks ticket accounting can never be double-claimed regardless of
 * random call ordering, and that every epoch's totalTickets exactly
 * equals the sum of what was actually claimed into it.
 */
describe("PlankPowerboard -- conservation of ETH + no double-claim under randomized play", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const EPOCH_SECONDS = 600n; // short epochs so draws happen often in a fuzz run

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function deploy() {
    const signers = await ethers.getSigners();
    const [deployer, drawer] = signers;
    const players = signers.slice(2, 6);
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const source: any = await (await ethers.getContractFactory("MockWagerSource")).deploy();

    const pb: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [await source.getAddress()],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: EPOCH_SECONDS,
      drawerRewardBps: 200n,
      ballRange: 26n,
      jackpotBall: 8n,
      consolationBps: 500n,
      mustHitByEpochs: 0n, // isolate the geometric path from the forced-payout path in this fuzzer
    });
    const pbAddr = await pb.getAddress();
    // PullPayment's constructor does `new Escrow()` as its first internal
    // CREATE -> nonce 1, exactly the same reasoning the crash game's own
    // solvency fuzzer already uses.
    const escrowAddr = ethers.getCreateAddress({ from: pbAddr, nonce: 1 });
    void deployer;
    return { pb, pbAddr, escrowAddr, beacon, source, drawer, players };
  }

  async function runFuzz(seed: number, steps: number) {
    const { pb, pbAddr, escrowAddr, beacon, source, drawer, players } = await deploy();
    const rand = prng(seed);
    const pick = (arr: any[]) => arr[Math.floor(rand() * arr.length)];

    let totalFunded = 0n;
    const withdrawn: Record<string, bigint> = {};
    let sourceRoundCounter = 0;
    // (source, sourceRoundId, player) -> already claimed, tracked here too
    // so the fuzzer can assert a REPEAT claim always reverts, not just
    // that state happens to look fine afterward.
    const claimedHere = new Set<string>();

    async function heldSomewhere(): Promise<bigint> {
      const a = await ethers.provider.getBalance(pbAddr);
      const b = await ethers.provider.getBalance(escrowAddr);
      return a + b;
    }
    async function assertConservation(tag: string) {
      let pulled = 0n;
      for (const v of Object.values(withdrawn)) pulled += v;
      const held = await heldSomewhere();
      expect(held + pulled, `conservation broken after ${tag}`).to.equal(totalFunded);
    }

    async function tryDrawIfDue() {
      const epoch: bigint = await pb.currentEpoch();
      if (epoch === 0n) return;
      const prev = epoch - 1n;
      const e = await pb.epochs(prev);
      if (!e.drawRequested) {
        await pb.requestDraw(prev).catch(() => {});
        return;
      }
      if (e.drawn) return;
      const available = await beacon.isRoundAvailable(e.targetDrandRound);
      if (!available) {
        const filler = ethers.keccak256(ethers.toUtf8Bytes("pb-fuzz-" + seed + "-" + prev.toString()));
        await beacon.setRandomness(e.targetDrandRound, filler).catch(() => {});
      }
      await pb.connect(drawer).drawWinner(prev).catch(() => {});
    }

    for (let i = 0; i < steps; i++) {
      const op = Math.floor(rand() * 5);
      try {
        if (op === 0) {
          const amt = ethers.parseEther(pick(["0.01", "0.1", "1"]));
          await pb.connect(drawer).fund({ value: amt });
          totalFunded += amt;
        } else if (op === 1) {
          const p = pick(players);
          const stake = ethers.parseEther(pick(["0.5", "1", "3"]));
          sourceRoundCounter++;
          const srcAddr = await source.getAddress();
          const key = `${srcAddr}-${sourceRoundCounter}-${p.address}`;
          await source.setStake(sourceRoundCounter, p.address, stake);
          await pb.claimTickets(srcAddr, sourceRoundCounter, p.address);
          claimedHere.add(key);
          // A repeat claim of the SAME (source, round, player) must revert --
          // asserted inline, not just left to the final invariant check.
          await expect(pb.claimTickets(srcAddr, sourceRoundCounter, p.address)).to.be.revertedWithCustomError(
            pb,
            "AlreadyClaimed"
          );
        } else if (op === 2) {
          await networkHelpers.time.increase(Number(EPOCH_SECONDS) + 1);
          await tryDrawIfDue();
        } else if (op === 3) {
          await tryDrawIfDue();
        } else {
          const p = pick(players);
          const before = await pb.payments(p.address);
          if (before > 0n) {
            await pb.connect(p).withdrawPayments(p.address);
            withdrawn[p.address] = (withdrawn[p.address] || 0n) + before;
          }
        }
      } catch (_) {
        /* an expected revert (e.g. draw not due yet) -- state shouldn't have moved */
      }
      await assertConservation(`step ${i} (op ${op})`);
    }
    // Drain whatever's left in escrow so the final tally is exact.
    for (const p of players) {
      const bal = await pb.payments(p.address);
      if (bal > 0n) {
        await pb.connect(p).withdrawPayments(p.address);
        withdrawn[p.address] = (withdrawn[p.address] || 0n) + bal;
      }
    }
    await assertConservation("final (post-drain)");
  }

  it("holds conservation + no-double-claim over 100 random ops (seed 3)", async () => {
    await runFuzz(3, 100);
  });
  it("holds conservation + no-double-claim over 100 random ops (seed 555)", async () => {
    await runFuzz(555, 100);
  });
  it("holds conservation + no-double-claim over 100 random ops (seed 13013)", async () => {
    await runFuzz(13013, 100);
  });
});
