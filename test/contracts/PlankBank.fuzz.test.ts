import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";

/**
 * PlankBank conservation fuzz. The single invariant that matters for a
 * contract holding real player funds: the bank's ACTUAL on-chain ETH
 * balance must, after every operation, EXACTLY equal the sum of every
 * player's tracked balanceOf(). Since balanceOf only ever changes via a
 * real ETH movement (deposit's msg.value, creditFor's msg.value in;
 * withdraw/withdrawAll's real send, _bet's real placeBetFor{value} out),
 * and there is deliberately no bare receive(), this equality is exact,
 * not approximate -- any drift means either insolvency (bank owes more
 * than it holds) or stray/stuck ETH (held but unaccounted, effectively
 * lost to whoever it belonged to).
 *
 * Driven against a REAL PlankCrashDrand so betVia/cashOutVia/creditFor's
 * real win-recycling path is genuinely exercised, not mocked.
 */
describe("PlankBank -- conservation of ETH under randomized session-key play", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const BETTING_SECONDS = 8;
  const MAX_ELAPSED_BLOCKS = 30;
  const REGISTRATION_BLOCKS = 6;

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function deploy() {
    const signers = await ethers.getSigners();
    const [deployer, treasury] = signers;
    const players = signers.slice(2, 6); // 4 players
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 40,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: 450n,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 10000n, // disabled -- irrelevant to this invariant, avoid spurious reverts
      keeperRewardBps: 1n, // hardening (c): must be > 0
      seedNumerator: 1n,
      seedDenominator: 8n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(MAX_ELAPSED_BLOCKS), // Phase 3 hardening fields (test defaults)
    });
    const crashAddr = await crash.getAddress();
    const bank: any = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]);
    void deployer;
    return { crash, bank, beacon, crashAddr, treasury, players };
  }

  async function runFuzz(seed: number, steps: number) {
    const { crash, bank, beacon, players } = await deploy();
    const bankAddr = await bank.getAddress();
    const rand = prng(seed);
    const pick = (arr: any[]) => arr[Math.floor(rand() * arr.length)];

    // Every player opts into recycling, and gets a session key up front --
    // the fuzzer decides WHEN to use it (or the root-key path, or neither).
    const sessionKeys: Record<string, any> = {};
    for (const p of players) {
      await crash.connect(p).setPayoutRedirect(bankAddr);
      const sk = ethers.Wallet.createRandom().connect(ethers.provider);
      await p.sendTransaction({ to: sk.address, value: ethers.parseEther("1") });
      sessionKeys[p.address] = sk;
    }

    async function assertSolvent(tag: string) {
      const contractBal = await ethers.provider.getBalance(bankAddr);
      let sumBalances = 0n;
      for (const p of players) sumBalances += await bank.balanceOf(p.address);
      expect(contractBal, `bank insolvent/stray-ETH after ${tag}`).to.equal(sumBalances);
    }

    async function tryAdvanceLive() {
      const id: bigint = await crash.currentRoundId();
      for (let d = id > 2n ? id - 2n : 1n; d <= id; d++) {
        const r = await crash.rounds(d);
        if (Number(r.phase) !== 1) continue;
        if (!r.entropyRevealed) {
          const due = DRAND_GENESIS + BigInt(r.targetDrandRound) * DRAND_PERIOD;
          if (BigInt(await networkHelpers.time.latest()) >= due) {
            const filler = ethers.keccak256(ethers.toUtf8Bytes("bank-fuzz-" + seed + "-" + d.toString() + "-" + Math.floor(rand() * 1e9)));
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
      // Register + claim for a random past round/player -- this is the ONLY
      // path that exercises creditFor (winnings recycling into the bank).
      const pastId = id > 1n ? BigInt(1 + Math.floor(rand() * Number(id))) : 1n;
      const p = pick(players);
      await crash.registerResult(pastId, p.address).catch(() => {});
      await crash.claim(pastId, p.address).catch(() => {});
    }

    for (let i = 0; i < steps; i++) {
      const op = Math.floor(rand() * 10);
      const p = pick(players);
      const sk = sessionKeys[p.address];
      try {
        if (op === 0) {
          await bank.connect(p).deposit({ value: ethers.parseEther(pick(["0.01", "0.05", "0.1", "0.2"])) });
        } else if (op === 1) {
          const bal = await bank.balanceOf(p.address);
          if (bal > 0n) await bank.connect(p).withdraw(bal / 2n > 0n ? bal / 2n : bal);
        } else if (op === 2) {
          await bank.connect(p).withdrawAll().catch(() => {});
        } else if (op === 3) {
          const expiry = BigInt((await networkHelpers.time.latest()) + 3600);
          await bank.connect(p).grantSession(sk.address, ethers.parseEther("100"), expiry);
        } else if (op === 4) {
          await bank.connect(p).revokeSession(sk.address).catch(() => {});
        } else if (op === 5) {
          // session-key bet path
          await bank.connect(sk).betVia(await crash.getAddress(), ethers.parseEther(pick(["0.01", "0.02", "0.05"])), 0n).catch(() => {});
        } else if (op === 6) {
          // root-key bet path
          await bank.connect(p).bet(await crash.getAddress(), ethers.parseEther(pick(["0.01", "0.02"])), 0n).catch(() => {});
        } else if (op === 7) {
          const roundId = await crash.currentRoundId();
          await bank.connect(sk).cashOutVia(await crash.getAddress(), roundId).catch(() => {});
        } else if (op === 8) {
          const roundId = await crash.currentRoundId();
          await bank.connect(p).cashOut(await crash.getAddress(), roundId).catch(() => {});
        } else {
          await crash.lockRound().catch(() => {});
          await tryAdvanceLive();
        }
      } catch (_) {
        // A revert here means nothing moved -- the invariant is checked
        // regardless, so a bad path is caught if it silently broke state.
      }
      await assertSolvent(`step ${i} (op ${op})`);
    }
    await assertSolvent("final");
  }

  it("holds solvency over 150 random ops (seed 1)", async () => {
    await runFuzz(1, 150);
  });
  it("holds solvency over 150 random ops (seed 42)", async () => {
    await runFuzz(42, 150);
  });
  it("holds solvency over 150 random ops (seed 98765)", async () => {
    await runFuzz(98765, 150);
  });
});
