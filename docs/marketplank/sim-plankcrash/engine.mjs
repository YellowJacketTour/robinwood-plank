// SPDX: analysis-only. CORRECTED Node model of contracts/PlankCrashDrand.sol
// (cos worktree, tip 6966068). BigInt throughout. Fixes the two invalidating
// fidelity bugs of the prior harness:
//   (1) reserveCap/_spillOverflow implemented at EVERY call site
//       (fundVault, progression premium, settle reserveCut, sweepBusted,
//       claim excess) with BOTH sink-success and sink-failure paths;
//   (2) failed spill RETAINS the excess in the Vault (reserve stays > cap),
//       exactly as `if (ok) reserve = cap; // else keep` does.
// Time/blocks are supplied by the driver (differential: the real chain's
// values; campaigns: a synthetic clock), so the model replicates the state
// transition math, never guesses chain timing.

import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";

export const BPS = 10000n;
export const DRAWDOWN_WINDOW = 86400n;
export const SEED_INCOME_MULTIPLE_BPS = 10000n;
export const TARGET_ROUND_SAFETY_PERIODS = 20n;
export const CASHOUT_CLOSE_MARGIN_PERIODS = 2n;

export function multiplierAt(e) { e = BigInt(e); return 10000n + e * 40n + (e * e) / 5n; }
export function invertMultiplier(target) {
  target = BigInt(target);
  if (multiplierAt(0n) >= target) return 0n;
  let lo = 0n, hi = 200000n;
  if (multiplierAt(hi) < target) return hi;
  while (lo < hi) { const mid = (lo + hi) / 2n; if (multiplierAt(mid) < target) lo = mid + 1n; else hi = mid; }
  return lo;
}
export function deriveCrash(entropyBig) {
  const r = BigInt(entropyBig) % 10000n;
  if (r === 0n) return { multiplierBps: 10000n, elapsedBlocks: 0n };
  const m = (10000n * 10000n) / (10000n - r);
  return { multiplierBps: m, elapsedBlocks: invertMultiplier(m) };
}
export const RESULT_DOMAIN = keccak256(toUtf8Bytes("PLANKCRASH_RESULT_V1"));
export function deriveResultSeed({ chainId, crashAddress, beaconAddress, roundId, targetDrandRound, drandRandomness }) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "address", "uint256", "uint64", "bytes32"],
    [RESULT_DOMAIN, chainId, crashAddress, beaconAddress, roundId, targetDrandRound, drandRandomness],
  );
  return BigInt(keccak256(encoded));
}
export function weightsAt(stake, elapsed) {
  const m = multiplierAt(elapsed);
  return { w: (stake * m) / BPS, pw: (stake * (m - 10000n)) / BPS };
}

const PHASE = { BETTING: 0, LIVE: 1, CRASHED: 2, SETTLED: 3 };
export { PHASE };

export class Engine {
  constructor(cfg, genesisTimestamp) {
    // cfg: all BigInt (addresses as strings for treasury etc. not needed here)
    this.cfg = cfg;
    this.genesisTimestamp = BigInt(genesisTimestamp);
    this.reserve = 0n;
    this.reserveHighWaterMark = 0n;
    this.drawdownWindowStart = BigInt(genesisTimestamp);
    this.drawdownWindowPeak = 0n;
    this.seedBudget = BigInt(cfg.seedBootstrapBudgetWei);
    this.accumulatedRake = 0n;
    this.currentRoundId = 0n;
    this.rounds = new Map(); // id -> round object
    this.sinkBalance = 0n;   // ETH successfully spilled to jackpotSink
    this.sinkOk = true;      // driver toggles: does jackpotSink.fund() succeed?
    this.escrow = new Map(); // pull-payment ledger (player/keeper/treasury)
    this.totalDeposits = 0n; // Σ msg.value into placeBet/fundVault
    this.failedSpillEvents = []; // {excess, at}
    this.events = [];        // emitted event mirror for differential
    // seed-spend accounting for the corrected income bound
    this.cumSeedDrawn = 0n; this.cumSeedReturned = 0n; this.cumReserveCut = 0n;
    this.maxMultiplierElapsedBlocks = (() => {
      let e = invertMultiplier(cfg.maxMultiplierBps);
      if (multiplierAt(e) > cfg.maxMultiplierBps) e -= 1n;
      return e;
    })();
    this._startRound(this.genesisTimestamp); // constructor starts round 1
  }

  emit(name, args) { this.events.push({ name, ...args }); }
  addEscrow(who, amt) { this.escrow.set(who, (this.escrow.get(who) ?? 0n) + amt); }
  escrowTotal() { let s = 0n; for (const v of this.escrow.values()) s += v; return s; }
  round(id = this.currentRoundId) { return this.rounds.get(id); }
  get strandedOverflow() {
    const { reserveCap, jackpotSink } = this.cfg;
    if (!jackpotSink || reserveCap === 0n) return 0n;
    return this.reserve > reserveCap ? this.reserve - reserveCap : 0n;
  }

  // ── Vault primitives ──────────────────────────────────────────────────
  _creditReserve(amount, raisesWindowPeak = true) {
    const bal = this.reserve + amount;
    this.reserve = bal;
    if (bal > this.reserveHighWaterMark) this.reserveHighWaterMark = bal;
    if (raisesWindowPeak && bal > this.drawdownWindowPeak) this.drawdownWindowPeak = bal;
  }

  _spillOverflow() {
    const { jackpotSink, reserveCap } = this.cfg;
    if (!jackpotSink || reserveCap === 0n || this.reserve <= reserveCap) return;
    const excess = this.reserve - reserveCap;
    if (this.sinkOk) {
      this.sinkBalance += excess;
      this.reserve = reserveCap;
      this.emit("VaultOverflow", { spilled: excess, reserveAfter: reserveCap });
    } else {
      this.failedSpillEvents.push({ excess }); // excess RETAINED in reserve
    }
  }

  _rolledWindow(ts) {
    let start = this.drawdownWindowStart, peak = this.drawdownWindowPeak;
    if (ts < start + DRAWDOWN_WINDOW) return { start, peak, rolled: false };
    let n = (ts - start) / DRAWDOWN_WINDOW;
    start += n * DRAWDOWN_WINDOW;
    const bal = this.reserve;
    const keepBps = BPS - this.cfg.dailyDrawdownBps;
    while (n > 0n && peak > bal) { peak = (peak * keepBps) / BPS; n -= 1n; }
    if (peak < bal) peak = bal;
    return { start, peak, rolled: true };
  }

  _seedHaltReason(ts) {
    const bal = this.reserve;
    const { peak } = this._rolledWindow(ts);
    if (peak > bal && (peak - bal) * BPS > peak * this.cfg.dailyDrawdownBps) return 1;
    let hwm = this.reserveHighWaterMark;
    if (this.cfg.reserveCap !== 0n && hwm > this.cfg.reserveCap) hwm = this.cfg.reserveCap;
    if (hwm > 0n && bal * BPS < hwm * (BPS - this.cfg.hwmDrawdownBps)) return 2;
    return 0;
  }

  _computeSeed() {
    const { reserveFloorWei, seedNumerator, seedDenominator, seedMaxBps } = this.cfg;
    const avail = this.reserve;
    if (avail === 0n) return 0n;
    if (reserveFloorWei > 0n && avail <= reserveFloorWei) return 0n;
    let seed = (avail * seedNumerator) / seedDenominator;
    const bpsCap = (avail * seedMaxBps) / BPS;
    if (seed > bpsCap) seed = bpsCap;
    const incomeCap = (this.seedBudget * SEED_INCOME_MULTIPLE_BPS) / BPS;
    if (seed > incomeCap) seed = incomeCap;
    if (reserveFloorWei > 0n) {
      const maxDraw = avail - reserveFloorWei;
      if (seed > maxDraw) seed = maxDraw;
    }
    return seed;
  }

  _seedFromReserve(ts) {
    const rw = this._rolledWindow(ts);
    if (rw.rolled) { this.drawdownWindowStart = rw.start; this.drawdownWindowPeak = rw.peak; }
    const halt = this._seedHaltReason(ts);
    if (halt !== 0) { this.emit("SeedHalted", { roundId: this.currentRoundId, reason: halt, reserveNow: this.reserve }); return 0n; }
    const seed = this._computeSeed();
    if (seed > 0n) {
      this.reserve -= seed;
      const b = this.seedBudget;
      this.seedBudget = seed >= b ? 0n : b - seed;
      this.cumSeedDrawn += seed;
    }
    return seed;
  }

  _startRound(ts) {
    this.currentRoundId += 1n;
    const seeded = this._seedFromReserve(ts);
    const r = {
      id: this.currentRoundId, phase: PHASE.BETTING, entropyRevealed: false, swept: false,
      targetDrandRound: 0n, bettingEndsAt: 0n, lockBlock: 0n,
      trueCrashElapsedBlocks: 0n, crashElapsedBlocks: 0n, crashMultiplierBps: 0n,
      pool: seeded, distributable: 0n, totalWinningWeight: 0n, provisionalWinningWeight: 0n,
      registrationDeadlineBlock: 0n, rolledOverFromPrevious: seeded,
      revealNotBefore: 0n, reserveAtLock: 0n, lockedBy: null, revealedBy: null,
      provisionalProfitWeight: 0n, totalWinningProfitWeight: 0n,
      voided: false,
      players: new Map(), // addr -> {stake, auto, cashOutBlock, registered, claimed, weight, profitWeight}
      participantCount: 0n, largestStake: 0n,
      claimedOut: 0n, // Σ (paid+excess) removed from distributable's backing
    };
    this.rounds.set(this.currentRoundId, r);
    this.emit("RoundStarted", { roundId: r.id });
    if (seeded > 0n) this.emit("VaultSeeded", { roundId: r.id, seed: seeded, reserveAfter: this.reserve });
  }

  // ── External ops (driver supplies block/timestamp observed on-chain) ──
  fundVault(value) {
    this.totalDeposits += value;
    this._creditReserve(value, true);
    this.emit("VaultFunded", { amount: value, reserveAfter: this.reserve });
    this._spillOverflow();
    this.assertConservation("fundVault");
  }

  placeBet(player, value, autoBps) {
    const r = this.round();
    this.totalDeposits += value;
    r.pool += value;
    r.participantCount += 1n;
    if (value > r.largestStake) r.largestStake = value;
    const p = { stake: value, auto: BigInt(autoBps), cashOutBlock: 0n, registered: false, claimed: false, weight: 0n, profitWeight: 0n };
    r.players.set(player, p);
    if (p.auto !== 0n) {
      const te = invertMultiplier(p.auto);
      const { w, pw } = weightsAt(value, te);
      r.provisionalWinningWeight += w;
      r.provisionalProfitWeight += pw;
    }
    this.assertConservation("placeBet");
  }

  carryForwardStake(fromRoundId, player) {
    const from = this.round(fromRoundId), fp = from.players.get(player);
    if (!from.voided || fp.carried || fp.stake === 0n) throw new Error("BadCarry");
    fp.carried = true;
    const r = this.round();
    r.pool += fp.stake;
    r.participantCount += 1n;
    if (fp.stake > r.largestStake) r.largestStake = fp.stake;
    const p = { stake: fp.stake, auto: fp.auto, cashOutBlock: 0n, registered: false, claimed: false, weight: 0n, profitWeight: 0n };
    r.players.set(player, p);
    if (p.auto !== 0n) {
      const te = invertMultiplier(p.auto);
      const { w, pw } = weightsAt(p.stake, te);
      r.provisionalWinningWeight += w;
      r.provisionalProfitWeight += pw;
    }
    this.assertConservation("carryForwardStake");
  }

  lockRound({ blockNumber, timestamp, targetDrandRound, revealNotBefore, keeper }) {
    const id = this.currentRoundId, r = this.round();
    const seedAmt = r.rolledOverFromPrevious;
    const playerPoolFinal = r.pool > seedAmt ? r.pool - seedAmt : 0n;
    const whale = playerPoolFinal > 0n && r.largestStake * BPS > playerPoolFinal * this.cfg.maxStakePerWalletBps;
    if (r.participantCount < this.cfg.minParticipants || r.pool < this.cfg.minPoolSize || whale) {
      this.emit("RoundVoided", { roundId: id, reason: whale ? "whale-dominated" : "under-threshold" });
      r.voided = true; r.phase = PHASE.SETTLED;
      this._rescueSeed(r);
      this._startRound(BigInt(timestamp));
      this.assertConservation("lockRound(void)");
      return { voided: true };
    }
    r.phase = PHASE.LIVE;
    r.lockBlock = BigInt(blockNumber);
    r.targetDrandRound = BigInt(targetDrandRound);
    r.revealNotBefore = BigInt(revealNotBefore);
    r.reserveAtLock = this.reserve;
    r.lockedBy = keeper;
    this.assertConservation("lockRound");
    return { voided: false };
  }

  cashOut(roundId, player, blockNumber) {
    const r = this.round(roundId), p = r.players.get(player);
    const elapsed = BigInt(blockNumber) - r.lockBlock;
    if (p.auto !== 0n) {
      const autoElapsed = invertMultiplier(p.auto);
      if (elapsed >= autoElapsed) throw new Error("AlreadyCashedOut(auto fired)");
      const { w: aw, pw: apw } = weightsAt(p.stake, autoElapsed);
      r.provisionalWinningWeight -= aw;
      r.provisionalProfitWeight -= apw;
    }
    p.cashOutBlock = BigInt(blockNumber);
    const { w, pw } = weightsAt(p.stake, elapsed);
    r.provisionalWinningWeight += w;
    r.provisionalProfitWeight += pw;
    this.assertConservation("cashOut");
  }

  revealEntropy(roundId, entropyBig, keeper) {
    const r = this.round(roundId);
    const ctx = this.cfg.resultSeedContext;
    const resultEntropy = ctx
      ? deriveResultSeed({
          ...ctx,
          roundId: BigInt(roundId),
          targetDrandRound: BigInt(r.targetDrandRound),
          drandRandomness: `0x${BigInt(entropyBig).toString(16).padStart(64, "0")}`,
        })
      : BigInt(entropyBig);
    const { elapsedBlocks } = deriveCrash(resultEntropy);
    r.trueCrashElapsedBlocks = elapsedBlocks;
    r.entropyRevealed = true;
    r.revealedBy = keeper;
  }

  settleRound(roundId, { blockNumber, timestamp, keeper }) {
    const r = this.round(roundId);
    const eff = r.trueCrashElapsedBlocks < this.maxMultiplierElapsedBlocks ? r.trueCrashElapsedBlocks : this.maxMultiplierElapsedBlocks;
    r.crashElapsedBlocks = eff;
    r.crashMultiplierBps = multiplierAt(eff);
    const vaultSeed = r.rolledOverFromPrevious;
    const playerPool = r.pool - vaultSeed;
    const playerDistributable = (playerPool * (BPS - this.cfg.rakeBps)) / BPS;
    r.distributable = vaultSeed + playerDistributable;
    r.registrationDeadlineBlock = BigInt(blockNumber) + this.cfg.registrationWindowBlocks;
    r.phase = PHASE.CRASHED;

    const rake = playerPool - playerDistributable;
    const keeperReward = (rake * this.cfg.keeperRewardBps) / BPS;
    const revealReward = (rake * this.cfg.keeperRevealBps) / BPS;
    const lockReward = (rake * this.cfg.keeperLockBps) / BPS;
    const netRake = rake - keeperReward - revealReward - lockReward;
    const reserveCut = (netRake * this.cfg.reserveShareBps) / BPS;
    this.seedBudget += reserveCut;
    this.cumReserveCut += reserveCut;
    if (reserveCut > 0n) { this._creditReserve(reserveCut, true); this.emit("VaultGrew", { roundId, fromRake: reserveCut, reserveAfter: this.reserve }); }
    this.accumulatedRake += netRake - reserveCut;
    if (keeperReward > 0n) this.addEscrow(keeper, keeperReward);
    if (revealReward > 0n) this.addEscrow(r.revealedBy, revealReward);
    if (lockReward > 0n) this.addEscrow(r.lockedBy, lockReward);
    if (reserveCut > 0n) this._spillOverflow();
    this._startRound(BigInt(timestamp));
    this.assertConservation("settleRound");
    return { eff, rake, keeperReward, revealReward, lockReward, netRake, reserveCut };
  }

  voidStaleRound(roundId, timestamp) {
    const r = this.round(roundId);
    this.emit("RoundVoided", { roundId, reason: "reveal-timeout" });
    r.voided = true; r.phase = PHASE.SETTLED;
    this._rescueSeed(r);
    this._startRound(BigInt(timestamp));
    this.assertConservation("voidStaleRound");
  }

  _rescueSeed(r) {
    const seed = r.rolledOverFromPrevious;
    if (seed > 0n) {
      r.rolledOverFromPrevious = 0n;
      this._creditReserve(seed, false);
      this.seedBudget += seed;
      this.cumSeedReturned += seed;
    }
  }

  sweepBustedRound(roundId) {
    const r = this.round(roundId);
    if (r.totalWinningWeight !== 0n) throw new Error("RoundHasWinners");
    r.swept = true;
    const amount = r.distributable;
    r.distributable = 0n;
    this._creditReserve(amount, true);
    this.seedBudget += r.rolledOverFromPrevious;
    this.cumSeedReturned += r.rolledOverFromPrevious;
    this.emit("PoolRolledOver", { roundId, amount });
    this._spillOverflow();
    this.assertConservation("sweepBustedRound");
  }

  effectiveCashOutBlock(r, p) {
    const manual = p.cashOutBlock;
    if (p.auto === 0n) return manual;
    if (r.lockBlock === 0n) return 0n;
    const autoBlock = r.lockBlock + invertMultiplier(p.auto);
    if (manual !== 0n && manual < autoBlock) return manual;
    return autoBlock;
  }

  registerResult(roundId, player) {
    const r = this.round(roundId), p = r.players.get(player);
    p.registered = true;
    const cob = this.effectiveCashOutBlock(r, p);
    const won = cob !== 0n && (cob - r.lockBlock) <= r.crashElapsedBlocks;
    let weight = 0n;
    if (won) {
      const { w, pw } = weightsAt(p.stake, cob - r.lockBlock);
      weight = w;
      r.totalWinningWeight += w;
      r.totalWinningProfitWeight += pw;
      p.profitWeight = pw;
    }
    p.weight = weight;
    this.emit("ResultRegistered", { roundId, player, won, weight });
    return { won, weight };
  }

  _splitPayout(r, w, pw, W, PW, distributable) {
    const seed = r.rolledOverFromPrevious;
    const playerPot = distributable > seed ? distributable - seed : 0n;
    let paid = (playerPot * w) / W;
    if (seed === 0n) return { paid, excess: 0n };
    const seedRaw = PW > 0n ? (seed * pw) / PW : (seed * w) / W;
    let seedPaid = seedRaw > pw ? pw : seedRaw;
    const capBase = r.lockBlock === 0n ? this.reserve : r.reserveAtLock;
    const cap = (capBase * this.cfg.singlePayoutCapBps) / BPS;
    if (seedPaid > cap) seedPaid = cap;
    paid += seedPaid;
    return { paid, excess: seedRaw - seedPaid };
  }

  claim(roundId, player) {
    const r = this.round(roundId), p = r.players.get(player);
    if (p.weight === 0n) throw new Error("NotWinner");
    p.claimed = true;
    const { paid, excess } = this._splitPayout(r, p.weight, p.profitWeight, r.totalWinningWeight, r.totalWinningProfitWeight, r.distributable);
    r.claimedOut += paid + excess;
    if (excess > 0n) {
      this._creditReserve(excess, false);
      this.seedBudget += excess;
      this.cumSeedReturned += excess;
      this.emit("PayoutCapped", { roundId, player, paid, excess });
    }
    this.addEscrow(player, paid);
    this.emit("Claimed", { roundId, player, payout: paid });
    if (excess > 0n) this._spillOverflow();
    this.assertConservation("claim");
    return { paid, excess };
  }

  claimRake(treasuryAddr = "treasury") {
    const amount = this.accumulatedRake;
    this.accumulatedRake = 0n;
    this.addEscrow(treasuryAddr, amount);
    this.assertConservation("claimRake");
    return amount;
  }

  withdrawPayments(who) { // ETH leaves the escrow contract; conservation still counts it as paid-out
    const amt = this.escrow.get(who) ?? 0n;
    this.escrow.set(who, 0n);
    this.paidOut = (this.paidOut ?? 0n) + amt;
    return amt;
  }

  // ── TOTAL SYSTEM CONSERVATION, checked to the wei on every transition ──
  // Σ deposits == reserve + Σ live/betting pools + Σ crashed remaining
  // distributable + escrowOwed + accumulatedRake + sinkBalance + paidOut.
  // (strandedOverflow is INSIDE reserve, per the contract; roundDust is the
  //  part of a fully-claimed round's distributable never allocated to any
  //  share — it stays inside "remaining distributable" until swept/never.)
  ledger() {
    let pools = 0n, remaining = 0n;
    for (const r of this.rounds.values()) {
      if (r.phase === PHASE.BETTING || r.phase === PHASE.LIVE) pools += r.pool;
      else if (r.phase === PHASE.CRASHED) remaining += r.distributable - r.claimedOut;
      else if (r.phase === PHASE.SETTLED && r.voided) {
        // voided: seed rescued back to reserve; player stakes stay claimable
        // via carryForwardStake — they remain in-contract, owed to players.
        for (const p of r.players.values()) if (!p.carried) remaining += p.stake;
      }
    }
    return {
      reserve: this.reserve, pools, remaining,
      escrow: this.escrowTotal(), accumulatedRake: this.accumulatedRake,
      sinkBalance: this.sinkBalance, paidOut: this.paidOut ?? 0n,
      strandedOverflow: this.strandedOverflow,
    };
  }

  assertConservation(where) {
    const L = this.ledger();
    const rhs = L.reserve + L.pools + L.remaining + L.escrow + L.accumulatedRake + L.sinkBalance + L.paidOut;
    if (rhs !== this.totalDeposits) {
      throw new Error(`CONSERVATION VIOLATED at ${where}: deposits=${this.totalDeposits} rhs=${rhs} diff=${rhs - this.totalDeposits} ledger=${JSON.stringify(L, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    }
  }

  // Corrected income bound (includes bootstrap term):
  // cumSeedDrawn - cumSeedReturned <= seedBootstrapBudgetWei + cumReserveCut
  incomeBoundHolds() {
    return this.cumSeedDrawn - this.cumSeedReturned <= this.cfg.seedBootstrapBudgetWei + this.cumReserveCut;
  }

  snapshot() {
    return {
      reserve: this.reserve, seedBudget: this.seedBudget,
      reserveHighWaterMark: this.reserveHighWaterMark,
      drawdownWindowStart: this.drawdownWindowStart, drawdownWindowPeak: this.drawdownWindowPeak,
      accumulatedRake: this.accumulatedRake, currentRoundId: this.currentRoundId,
      sinkBalance: this.sinkBalance, strandedOverflow: this.strandedOverflow,
    };
  }
}
