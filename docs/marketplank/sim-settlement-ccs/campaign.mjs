/**
 * CCS stochastic campaign — item 5 of the owner checklist.
 *
 * Deterministic (splitmix64, fixed seed). Every settlement asserts the exact
 * bigint solvency identity. Tracks per-strategy RTP, ruin probability over
 * persistent bankroll cohorts, Vault dust and cap-excess (20/40/40) flows.
 *
 * Usage: node campaign.mjs <rounds> [seed] [outfile]
 */
import { writeFileSync } from "node:fs";
import {
  BPS,
  MIN_TARGET_BPS,
  DEFAULT_CCS,
  settleCcs,
  deriveCrashBps,
  roundEconomics,
  makeRng,
  rngBelow,
} from "./engine.mjs";

const ROUNDS = Number(process.argv[2] ?? 200_000);
const SEED = BigInt(process.argv[3] ?? 20260831n);
const OUT = process.argv[4] ?? null;

const rng = makeRng(SEED);
const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// Strategy = how a player picks targetBps.
const STRATS = {
  early: () => 10_100n + rngBelow(rng, 5_000n), // 1.01-1.51x
  mid: () => 20_000n + rngBelow(rng, 30_000n), // 2-5x
  greedy: () => 50_000n + rngBelow(rng, 450_000n), // 5-50x
  mixed: () => {
    const r = rngBelow(rng, 3n);
    return r === 0n ? STRATS.early() : r === 1n ? STRATS.mid() : STRATS.greedy();
  },
  // adversarial: hug the theoretical premium-EV peak m=e, +- jitter, and
  // occasionally 1-bps-adjacent shadowing of a common lock
  adversarial: () => (rngBelow(rng, 4n) === 0n ? 20_001n : 26_000n + rngBelow(rng, 3_000n)),
};
const STRAT_NAMES = Object.keys(STRATS);

// Persistent bankroll cohorts per strategy for ruin measurement.
const COHORT = 400;
const START_BANKROLL = E(100);
const MIN_BET = E(0.01);
// Ruin is measured per finite LIFETIME: a player starts at START_BANKROLL,
// bets 1-4% of current bankroll per seat, and the lifetime ends in "ruin" if
// the bankroll drops below MIN_BET within LIFETIME_BETS bets, else "survived".
// Ruined/finished players are replaced by fresh ones so rounds never empty.
const LIFETIME_BETS = 1_000;
const cohorts = {};
const lifetimes = {};
for (const s of STRAT_NAMES) {
  cohorts[s] = Array.from({ length: COHORT }, () => ({ bank: START_BANKROLL, bets: 0 }));
  lifetimes[s] = { ruined: 0, survived: 0 };
}

const stats = {};
for (const s of STRAT_NAMES) stats[s] = { staked: 0n, paid: 0n, seats: 0, survived: 0 };
let vaultDust = 0n;
let capExcess = 0n;
let split = { burn: 0n, community: 0n, founders: 0n };
let rakeTotal = 0n;
let maxDust = 0n;
const modes = { interior: 0, "cap-excess": 0, "floor-scaled": 0, "all-bust": 0 };
let solvencyFailures = 0;

const t0 = Date.now();
for (let round = 0; round < ROUNDS; round++) {
  const n = 2 + Number(rngBelow(rng, 24n)); // 2-25 seats
  const seats = [];
  const seatMeta = [];
  for (let i = 0; i < n; i++) {
    const strat = STRAT_NAMES[Number(rngBelow(rng, BigInt(STRAT_NAMES.length)))];
    const pool = cohorts[strat];
    const p = pool[Number(rngBelow(rng, BigInt(COHORT)))];
    // bet 1-4% of bankroll (scale-with-current-equity), floor at MIN_BET
    let stake = (p.bank * (100n + rngBelow(rng, 300n))) / 10_000n;
    if (stake < MIN_BET) stake = MIN_BET;
    if (stake > p.bank) stake = p.bank;
    seats.push({ id: `s${i}`, stake, targetBps: STRATS[strat]() });
    seatMeta.push({ strat, p });
  }
  if (seats.length === 0) continue;
  const crash = deriveCrashBps(rngBelow(rng, 10_000n));
  const seed = rngBelow(rng, 5n) === 0n ? E(0.05) : 0n;
  const econ = roundEconomics(seed, seats.map((s) => s.stake), 300n);
  rakeTotal += econ.rake;
  let r;
  try {
    r = settleCcs(econ.distributable, crash, seats, DEFAULT_CCS);
  } catch (e) {
    solvencyFailures++;
    continue;
  }
  const paidSum = r.allocations.reduce((a, x) => a + x.payout, 0n);
  if (paidSum + r.capExcess + r.vaultRemainder !== econ.distributable) solvencyFailures++;
  modes[r.meta.mode]++;
  vaultDust += r.vaultRemainder;
  capExcess += r.capExcess;
  split.burn += r.capExcessSplit.burn;
  split.community += r.capExcessSplit.community;
  split.founders += r.capExcessSplit.founders;
  if (r.meta.mode === "interior" && r.vaultRemainder > maxDust) maxDust = r.vaultRemainder;
  for (let i = 0; i < seats.length; i++) {
    const { strat, p } = seatMeta[i];
    const a = r.allocations[i];
    stats[strat].staked += a.stake;
    stats[strat].paid += a.payout;
    stats[strat].seats++;
    if (a.survived) stats[strat].survived++;
    p.bank += a.net;
    p.bets++;
    if (p.bank < MIN_BET) {
      lifetimes[strat].ruined++;
      p.bank = START_BANKROLL;
      p.bets = 0;
    } else if (p.bets >= LIFETIME_BETS) {
      lifetimes[strat].survived++;
      p.bank = START_BANKROLL;
      p.bets = 0;
    }
  }
}
const elapsedMs = Date.now() - t0;

const out = {
  rounds: ROUNDS,
  seed: SEED.toString(),
  elapsedMs,
  solvencyFailures,
  modes,
  flows: {
    rakeTotalWei: rakeTotal.toString(),
    vaultDustWei: vaultDust.toString(),
    maxSingleRoundInteriorDustWei: maxDust.toString(),
    capExcessWei: capExcess.toString(),
    capExcessSplit: {
      burnWei: split.burn.toString(),
      communityWei: split.community.toString(),
      foundersWei: split.founders.toString(),
    },
  },
  perStrategy: Object.fromEntries(
    STRAT_NAMES.map((s) => {
      const st = stats[s];
      const lt = lifetimes[s];
      const done = lt.ruined + lt.survived;
      return [
        s,
        {
          seats: st.seats,
          survivalRate: st.seats ? st.survived / st.seats : 0,
          stakedWei: st.staked.toString(),
          paidWei: st.paid.toString(),
          rtp: st.staked > 0n ? Number((st.paid * 1_000_000n) / st.staked) / 1e6 : 0,
          lifetimesCompleted: done,
          ruinProbabilityPer1000Bets: done ? lt.ruined / done : 0,
        },
      ];
    }),
  ),
};
const text = JSON.stringify(out, null, 2);
if (OUT) writeFileSync(OUT, text);
console.log(text);
if (solvencyFailures > 0) process.exit(1);
