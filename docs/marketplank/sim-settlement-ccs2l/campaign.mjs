/**
 * CCS-2L stochastic campaign. Variants:
 *   A  uncapped player CCS (g = ln) + fair-odds/wallet-capped house bonus [PRIMARY]
 *   B  progressive same-round player-pot recycling (g = m - 1, odds-linear:
 *      redistributes the SAME player purse toward higher locks)
 *   C  forward-seed recycling [NONPREFERRED control]: all-bust PLAYER pot is
 *      carried into the NEXT round's house seed instead of the reserve, and a
 *      "sniper" strategy sizes up when the carry is fat — demonstrating the
 *      cross-round beneficiary / manufactured-round farming surface.
 *
 * Every settlement asserts the exact two-layer conservation identities.
 * Reports RTP by strategy AND by bankroll bucket, ruin probability, and
 * Vault/Powerboard(=community)/burn/founders flows.
 *
 * Usage: node campaign.mjs <variant A|B|C> <rounds> [seed] [outfile]
 */
import { writeFileSync } from "node:fs";
import {
  DEFAULT_CCS2L,
  settleCcs2L,
  deriveCrashBps,
  roundEconomics,
  ratifiedSplit,
  makeRng,
  rngBelow,
} from "./engine.mjs";

const VARIANT = String(process.argv[2] ?? "A").toUpperCase();
const ROUNDS = Number(process.argv[3] ?? 200_000);
const SEED = BigInt(process.argv[4] ?? 20260831n);
const OUT = process.argv[5] ?? null;
if (!["A", "B", "C"].includes(VARIANT)) throw new Error("variant must be A|B|C");

const rng = makeRng(SEED);
const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const RAKE = 300n;
const params = {
  ...DEFAULT_CCS2L,
  playerWeight: VARIANT === "B" ? "odds" : "ln",
};

// House reserve dynamics (mirrors the contract shape: fractional seed of the
// reserve; unused seed and busted pots return to the reserve; the reserve is
// also credited the community-agnostic house share of nothing — its only
// income here is returns, so ruin of the HOUSE is measurable too).
let reserve = E(2_000);
const SEED_NUM = 1n;
const SEED_DEN = 200n;
let carry = 0n; // variant C only: forward-seeded busted player pots

const STRATS = {
  early: () => 10_100n + rngBelow(rng, 5_000n),
  mid: () => 20_000n + rngBelow(rng, 30_000n),
  greedy: () => 50_000n + rngBelow(rng, 450_000n),
  mixed: () => {
    const r = rngBelow(rng, 3n);
    return r === 0n ? STRATS.early() : r === 1n ? STRATS.mid() : STRATS.greedy();
  },
  adversarial: () => (rngBelow(rng, 4n) === 0n ? 20_001n : 26_000n + rngBelow(rng, 3_000n)),
  // sniper: behaves like mid, but in variant C sizes UP into fat-carry rounds
  // and sits at a low-ish lock to harvest the recycled seed's fair-odds cap.
  sniper: () => 15_000n + rngBelow(rng, 10_000n),
};
const STRAT_NAMES = Object.keys(STRATS);

const COHORT = 400;
const START_BANKROLL = E(100);
const MIN_BET = E(0.01);
const LIFETIME_BETS = 1_000;
const cohorts = {};
const lifetimes = {};
for (const s of STRAT_NAMES) {
  cohorts[s] = Array.from({ length: COHORT }, () => ({ bank: START_BANKROLL, bets: 0 }));
  lifetimes[s] = { ruined: 0, survived: 0 };
}

const stats = {};
for (const s of STRAT_NAMES) stats[s] = { staked: 0n, paid: 0n, playerPaid: 0n, bonus: 0n, seats: 0, survived: 0 };
// bankroll buckets at bet time (tokens): <10, 10-100, 100-1k, >=1k
const BUCKETS = ["lt10", "10to100", "100to1k", "gte1k"];
const bucketOf = (bank) => (bank < E(10) ? "lt10" : bank < E(100) ? "10to100" : bank < E(1000) ? "100to1k" : "gte1k");
const bankStats = Object.fromEntries(BUCKETS.map((b) => [b, { staked: 0n, paid: 0n, seats: 0 }]));

let staked = 0n;
let playerPaidTotal = 0n;
let bonusTotal = 0n;
let rakeTotal = 0n;
let allBustPlayerConfiscated = 0n; // -> reserve (A/B) or carry (C)
let allBustSeedReturned = 0n;
let houseReturnedTotal = 0n;
let seedDrawnTotal = 0n;
let carryPeak = 0n;
let allBustRounds = 0;
let sniperCarryHarvest = 0n; // variant C: bonus paid to snipers in carry rounds
let solvencyFailures = 0;
let minReserve = reserve;
const modes = { "normal": 0, "floor-degenerate": 0, "no-survivor": 0 };

const t0 = Date.now();
for (let round = 0; round < ROUNDS; round++) {
  const n = 2 + Number(rngBelow(rng, 24n));
  const seats = [];
  const seatMeta = [];
  const fatCarry = VARIANT === "C" && carry > E(1);
  for (let i = 0; i < n; i++) {
    const strat = STRAT_NAMES[Number(rngBelow(rng, BigInt(STRAT_NAMES.length)))];
    const pool = cohorts[strat];
    const p = pool[Number(rngBelow(rng, BigInt(COHORT)))];
    let pctBps = 100n + rngBelow(rng, 300n); // 1-4% of current bankroll
    if (strat === "sniper" && fatCarry) pctBps = 2_000n; // size up into the carry
    let stake = (p.bank * pctBps) / 10_000n;
    if (stake < MIN_BET) stake = MIN_BET;
    if (stake > p.bank) stake = p.bank;
    seats.push({ id: `s${i}`, stake, targetBps: STRATS[strat]() });
    seatMeta.push({ strat, p });
  }
  const crash = deriveCrashBps(rngBelow(rng, 10_000n));
  let seed = (reserve * SEED_NUM) / SEED_DEN;
  if (VARIANT === "C") {
    seed += carry;
  }
  reserve -= (reserve * SEED_NUM) / SEED_DEN;
  seedDrawnTotal += seed;
  const econ = roundEconomics(seed, seats.map((s) => s.stake), RAKE);
  rakeTotal += econ.rake;
  staked += econ.playerPool;

  let r;
  try {
    r = settleCcs2L(econ.playerDistributable, seed, crash, seats, reserve, params);
  } catch {
    solvencyFailures++;
    continue;
  }
  modes[r.meta.mode]++;
  // conservation identities (redundant with engine throws; belt-and-braces)
  if (r.allBust) {
    if (r.bustedToReserve !== econ.playerDistributable + seed || r.totalBonus !== 0n) solvencyFailures++;
  } else {
    if (r.totalBonus + r.houseReturned !== seed) solvencyFailures++;
    if (r.totalPlayerPaid !== econ.playerDistributable) solvencyFailures++;
  }

  if (r.allBust) {
    allBustRounds++;
    allBustSeedReturned += seed;
    reserve += seed;
    if (VARIANT === "C") {
      carry = econ.playerDistributable; // forward-seed the busted player pot
      if (carry > carryPeak) carryPeak = carry;
    } else {
      allBustPlayerConfiscated += econ.playerDistributable;
      reserve += econ.playerDistributable;
    }
    if (VARIANT === "C") allBustPlayerConfiscated += econ.playerDistributable; // tracked as redirected
  } else {
    reserve += r.houseReturned;
    houseReturnedTotal += r.houseReturned;
    if (VARIANT === "C") {
      if (fatCarry) {
        for (let i = 0; i < seats.length; i++) {
          if (seatMeta[i].strat === "sniper") sniperCarryHarvest += r.allocations[i].houseBonus;
        }
      }
      carry = 0n;
    }
  }
  if (reserve < minReserve) minReserve = reserve;

  playerPaidTotal += r.totalPlayerPaid;
  bonusTotal += r.totalBonus;

  for (let i = 0; i < seats.length; i++) {
    const { strat, p } = seatMeta[i];
    const a = r.allocations[i];
    const bkt = bucketOf(p.bank);
    stats[strat].staked += a.stake;
    stats[strat].paid += a.payout;
    stats[strat].playerPaid += a.playerPayout;
    stats[strat].bonus += a.houseBonus;
    stats[strat].seats++;
    if (a.survived) stats[strat].survived++;
    bankStats[bkt].staked += a.stake;
    bankStats[bkt].paid += a.payout;
    bankStats[bkt].seats++;
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

// The wei-exact player-money identity for the whole campaign:
//   playerPaidTotal + rakeTotal + allBustPlayerRedirected (+ open carry) == staked
const openCarry = VARIANT === "C" ? carry : 0n;
const identityHolds = playerPaidTotal + rakeTotal + allBustPlayerConfiscated + 0n === staked
  ? true
  : playerPaidTotal + rakeTotal + allBustPlayerConfiscated === staked;
// (variant C: confiscated tracker already includes what became carry; the carry
// is spent as seed in later rounds and any open remainder is still tracked
// inside allBustPlayerConfiscated, so the identity is unchanged.)
if (!identityHolds) solvencyFailures++;

// effective rake = disclosed rake + all-bust player-pot redirection
const rtpPlayerLayer = staked > 0n ? Number((playerPaidTotal * 10n ** 9n) / staked) / 1e9 : 0;
const oneMinusEffRake = staked > 0n ? Number(((staked - rakeTotal - allBustPlayerConfiscated) * 10n ** 9n) / staked) / 1e9 : 0;
const rakeSplit = ratifiedSplit(rakeTotal);

const out = {
  variant: VARIANT,
  playerWeight: params.playerWeight,
  rounds: ROUNDS,
  seed: SEED.toString(),
  elapsedMs,
  solvencyFailures,
  modes,
  allBustRounds,
  identity: {
    stakedWei: staked.toString(),
    playerPaidWei: playerPaidTotal.toString(),
    rakeWei: rakeTotal.toString(),
    allBustPlayerRedirectedWei: allBustPlayerConfiscated.toString(),
    openCarryWei: openCarry.toString(),
    exact: identityHolds,
    playerLayerRTP: rtpPlayerLayer,
    oneMinusEffectiveRake: oneMinusEffRake,
    playerRtpEqualsOneMinusEffectiveRakeWeiExact:
      playerPaidTotal === staked - rakeTotal - allBustPlayerConfiscated,
  },
  houseLayer: {
    seedDrawnWei: seedDrawnTotal.toString(),
    bonusPaidWei: bonusTotal.toString(),
    houseReturnedWei: houseReturnedTotal.toString(),
    allBustSeedReturnedWei: allBustSeedReturned.toString(),
    reserveStartWei: E(2_000).toString(),
    reserveEndWei: reserve.toString(),
    reserveMinWei: minReserve.toString(),
    carryPeakWei: carryPeak.toString(),
    sniperCarryHarvestWei: sniperCarryHarvest.toString(),
  },
  flows: {
    rakeSplit: {
      burnWei: rakeSplit.burn.toString(),
      communityPowerboardWei: rakeSplit.community.toString(),
      foundersWei: rakeSplit.founders.toString(),
    },
    treasuryPlayerPotCapResidueWei: "0",
  },
  aggregateRTP: staked > 0n ? Number(((playerPaidTotal + bonusTotal) * 10n ** 9n) / staked) / 1e9 : 0,
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
          rtp: st.staked > 0n ? Number((st.paid * 10n ** 6n) / st.staked) / 1e6 : 0,
          rtpPlayerLayer: st.staked > 0n ? Number((st.playerPaid * 10n ** 6n) / st.staked) / 1e6 : 0,
          rtpHouseBonus: st.staked > 0n ? Number((st.bonus * 10n ** 6n) / st.staked) / 1e6 : 0,
          lifetimesCompleted: done,
          ruinProbabilityPer1000Bets: done ? lt.ruined / done : 0,
        },
      ];
    }),
  ),
  byBankroll: Object.fromEntries(
    BUCKETS.map((b) => [
      b,
      {
        seats: bankStats[b].seats,
        stakedWei: bankStats[b].staked.toString(),
        rtp: bankStats[b].staked > 0n ? Number((bankStats[b].paid * 10n ** 6n) / bankStats[b].staked) / 1e6 : 0,
      },
    ]),
  ),
};
const text = JSON.stringify(out, null, 2);
if (OUT) writeFileSync(OUT, text);
console.log(text);
if (solvencyFailures > 0) process.exit(1);
