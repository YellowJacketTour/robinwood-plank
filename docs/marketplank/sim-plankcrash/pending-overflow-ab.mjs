// A/B validation of the pendingOverflow design (DESIGN-PLANKCRASH-PENDING-OVERFLOW-SEPARATION).
// Baseline = the differential-validated corrected engine (current contract semantics).
// Variant  = same engine + skim-in-_creditReserve pull-based pendingOverflow (reserve<=cap always).
// Replicates campaign.mjs's minimal halt-counting round loop for both engine classes under
// sink-failure regimes. Does NOT replace the differential (which validates the BASELINE vs chain);
// it measures the PROPOSED design's effect, built on the proven-faithful baseline.
import { Engine } from "./engine.mjs";

const E18 = 10n ** 18n;
const eth = (x) => BigInt(Math.round(x * 1e6)) * (E18 / 1_000_000n);
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; }; }
const rf = (next) => (next() >>> 8) / (1 << 24);

const BASE_CFG = {
  bettingDurationSeconds: 30n, roundIntervalSeconds: 0n, maxAwaitBlocks: 3000n,
  maxElapsedBlocks: 6969n, registrationWindowBlocks: 50n, rakeBps: 300n,
  minParticipants: 2n, minPoolSize: 0n, maxStakePerWalletBps: 5000n,
  keeperRewardBps: 100n, keeperRevealBps: 100n, keeperLockBps: 100n,
  seedNumerator: 1n, seedDenominator: 8n, seedMaxBps: 500n, seedBootstrapBudgetWei: eth(0.2),
  singlePayoutCapBps: 200n, dailyDrawdownBps: 1500n, hwmDrawdownBps: 3000n,
  reserveShareBps: 4000n, reserveFloorWei: 0n, reserveCap: 2n * E18,
  maxMultiplierBps: 10_000_000n, jackpotSink: "0xJACKPOT", treasury: "0xTREAS", beacon: "0xBEACON",
};
const GENESIS_TS = 1727521075n;

// Variant engine: reserve capped synchronously; excess -> pendingOverflow (inert to economics).
class PendingOverflowEngine extends Engine {
  constructor(cfg, ts) { super(cfg, ts); this.pendingOverflow = 0n; }
  _creditReserve(amount, raisesWindowPeak = true) {
    let bal = this.reserve + amount;
    const cap = this.cfg.reserveCap;
    if (cap !== 0n && bal > cap) { this.pendingOverflow += (bal - cap); bal = cap; }
    this.reserve = bal;
    if (bal > this.reserveHighWaterMark) this.reserveHighWaterMark = bal;
    if (raisesWindowPeak && bal > this.drawdownWindowPeak) this.drawdownWindowPeak = bal;
  }
  _spillOverflow() { this.deliverOverflow(); }
  deliverOverflow() {
    if (this.pendingOverflow === 0n || !this.cfg.jackpotSink) return false;
    const amount = this.pendingOverflow; this.pendingOverflow = 0n;
    if (this.sinkOk) { this.sinkBalance += amount; return true; }
    this.pendingOverflow = amount; return false; // retry; reserve untouched
  }
  get strandedOverflow() { return 0n; }
  // pendingOverflow is a SEPARATE in-contract bucket; conservation must count it.
  assertConservation(where) {
    const L = this.ledger();
    const rhs = L.reserve + L.pools + L.remaining + L.escrow + L.accumulatedRake +
                L.sinkBalance + (L.paidOut ?? 0n) + this.pendingOverflow;
    if (rhs !== this.totalDeposits) {
      throw new Error(`VARIANT CONSERVATION VIOLATED at ${where}: deposits=${this.totalDeposits} rhs=${rhs} diff=${rhs - this.totalDeposits} pending=${this.pendingOverflow}`);
    }
  }
}

// Faithful replica of campaign.mjs's halt-generating loop: reserveShareBps 5000, full
// register/claim/sweep cycle so BUSTED rounds occur and push reserve above cap when the sink fails.
function run(EngineClass, seeds, rounds, sinkFailProb) {
  const haltFracs = [], capViols = [], maxReserves = [], busted = [];
  for (const seed of seeds) {
    const next = prng(seed);
    const cfg = { ...BASE_CFG, reserveShareBps: 5000n };
    const eng = new EngineClass(cfg, GENESIS_TS);
    eng.fundVault(cfg.reserveCap); // genesis: funded to cap
    let ts = GENESIS_TS, blk = 1000n, halted = 0, capViol = 0, maxRes = 0n, bust = 0;
    for (let n = 0; n < rounds; n++) {
      eng.sinkOk = rf(next) >= sinkFailProb;
      const rid = eng.currentRoundId;
      const r = eng.round(rid);
      if (r.rolledOverFromPrevious === 0n && eng.reserve > 0n) halted++;
      // ~35% of rounds: all bettors target a high multiplier the crash rarely reaches -> busted
      const bustRound = rf(next) < 0.35;
      for (let i = 0; i < 6; i++) {
        const tgt = bustRound ? 900000n : 10100n + BigInt(Math.floor(rf(next) * 20000));
        eng.placeBet(`h${i}`, eth(0.01 + rf(next) * 0.04), tgt);
      }
      ts += 30n; blk += 30n;
      eng.lockRound({ blockNumber: blk, timestamp: ts, targetDrandRound: 1n, revealNotBefore: 0n, keeper: "k" });
      eng.revealEntropy(rid, next(), "k");
      ts += 60n; blk += 60n;
      eng.settleRound(rid, { blockNumber: blk, timestamp: ts, keeper: "k" });
      blk += cfg.registrationWindowBlocks + 1n;
      let winners = 0;
      for (const [a] of r.players) { const { won } = eng.registerResult(rid, a); if (won) winners++; }
      if (winners === 0) { eng.sweepBustedRound(rid); bust++; }
      else for (const [a, p] of r.players) if (p.weight > 0n) eng.claim(rid, a);
      if (cfg.reserveCap !== 0n && eng.reserve > cfg.reserveCap) capViol++;
      if (eng.reserve > maxRes) maxRes = eng.reserve;
    }
    haltFracs.push(halted / rounds); capViols.push(capViol);
    maxReserves.push(Number(maxRes) / 1e18); busted.push(bust / rounds);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { haltFrac: mean(haltFracs), capViol: mean(capViols), maxReserveEth: mean(maxReserves), bustFrac: mean(busted) };
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ROUNDS = 1500;
// NOTE: an earlier flawed A/B run (superseded) funded to cap once and never generated busted
// rounds, so it produced ~0 overflow and baseline halt ~0.0007 at ALL sink rates — it did NOT
// exercise the coupling and was inconclusive. That flawed run is documented in
// pending-overflow-ab-FLAWED-SUPERSEDED-2026-08-31.txt. THIS run adds reserveShareBps 5000 and
// ~35% busted rounds (the real overflow generator), which reproduces the pathology.
console.log("A/B: seed-halt fraction and reserve-cap invariant under sink failure (CORRECTED run)");
console.log("baseline = current contract semantics; variant = pendingOverflow design");
console.log("12 seeds x 1500 rounds; reserveShareBps 5000; ~35% busted rounds\n");
const col = (s, w) => String(s).padStart(w);
console.log(`${col("sinkFail", 8)} ${col("engine", 9)} ${col("haltFrac", 9)} ${col("capViol", 9)} ${col("maxReserveETH", 14)}`);
for (const p of [0.0, 0.3, 1.0]) {
  const b = run(Engine, seeds, ROUNDS, p);
  const v = run(PendingOverflowEngine, seeds, ROUNDS, p);
  const row = (label, r) => `${col((p * 100).toFixed(0) + "%", 8)} ${col(label, 9)} ${col(r.haltFrac.toFixed(4), 9)} ${col(r.capViol.toFixed(1), 9)} ${col(r.maxReserveEth.toFixed(3), 14)}`;
  console.log(row("baseline", b));
  console.log(row("variant", v));
}
