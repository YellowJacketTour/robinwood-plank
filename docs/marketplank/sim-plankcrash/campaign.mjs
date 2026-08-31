// CORRECTED Monte-Carlo campaigns over the differential-verified engine.
// Run: node campaign.mjs   (from this directory)
// Every claim is "property checked over N modeled transitions", never exhaustive.
import { Engine, deriveCrash, invertMultiplier, multiplierAt } from "./engine.mjs";
import { writeFileSync } from "node:fs";

const E18 = 10n ** 18n;
const eth = (x) => BigInt(Math.round(x * 1e6)) * (10n ** 12n);
const f = (w) => Number(w) / 1e18;

function prng(seed) {
  let s = BigInt(seed) & 0xffffffffffffffffn;
  return () => {
    s ^= s << 13n; s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n; s &= 0xffffffffffffffffn;
    return s;
  };
}
const rf = (next) => Number(next() % 1000000n) / 1e6; // [0,1)

const BASE_CFG = {
  rakeBps: 450n, minParticipants: 2n, minPoolSize: eth(0.001), maxStakePerWalletBps: 10000n,
  keeperRewardBps: 500n, keeperRevealBps: 100n, keeperLockBps: 100n,
  seedNumerator: 1n, seedDenominator: 8n, reserveShareBps: 5000n,
  reserveFloorWei: eth(0.05), reserveCap: 2n * E18, jackpotSink: "powerboard",
  seedMaxBps: 500n, singlePayoutCapBps: 200n, dailyDrawdownBps: 1500n, hwmDrawdownBps: 5000n,
  maxMultiplierBps: multiplierAt(1800n), registrationWindowBlocks: 6n,
  seedBootstrapBudgetWei: eth(0.2),
};

const GAS_PER_OP = 150000n * (10n ** 8n); // 150k gas @ 0.1 gwei = 1.5e13 wei
const ROUND_SECONDS = 120n;
const LOTTERY_EVERY = 500; // rounds between Powerboard lottery drains

function runOne({ seed, rounds, cfg = {}, genesis = "cap", sinkFailProb = 0, coalition = null, honestCount = 6 }) {
  const C = { ...BASE_CFG, ...cfg };
  const next = prng(seed);
  let ts = 1727521075n, blk = 1000n;
  const eng = new Engine(C, ts);

  // genesis start states
  const strand = () => { eng.sinkOk = false; eng.fundVault(C.reserveCap + eth(0.5)); eng.sinkOk = true; };
  const G = {
    zero: () => {},
    partial: () => eng.fundVault(C.reserveCap / 2n),
    floor: () => C.reserveFloorWei > 0n && eng.fundVault(C.reserveFloorWei),
    cap: () => eng.fundVault(C.reserveCap === 0n ? 2n * E18 : C.reserveCap),
    stranded: strand,
    fundedBootstrap: () => eng.fundVault(C.reserveCap === 0n ? 2n * E18 : C.reserveCap), // bootstrap set via cfg
    noBootstrap: () => eng.fundVault(C.reserveCap === 0n ? 2n * E18 : C.reserveCap),
  };
  G[genesis]();

  const pnl = new Map(); // addr -> {stakes, payouts, gas, keeper, lottery}
  const acct = (a) => { if (!pnl.has(a)) pnl.set(a, { stakes: 0n, payouts: 0n, gas: 0n, keeper: 0n, lottery: 0n }); return pnl.get(a); };
  const coalitionAddrs = new Set();
  let lotteryPaid = 0n, powerboardPaidHonest = 0n;
  let maxReserve = 0n, haltedRounds = 0, bustedRounds = 0, transitions = 0;
  let failedSpills = 0, strandedMaxWei = 0n;

  for (let n = 0; n < rounds; n++) {
    eng.sinkOk = rf(next) >= sinkFailProb;
    const rid = eng.currentRoundId;
    const r = eng.round(rid);
    if (r.rolledOverFromPrevious === 0n) haltedRounds += (eng.reserve > 0n ? 1 : 0);

    // bets
    const bettors = [];
    for (let i = 0; i < honestCount; i++) {
      const a = `h${i}`;
      const stake = eth(0.01 + rf(next) * 0.04);
      const targetMult = 10100n + BigInt(Math.floor(rf(next) * 20000)); // 1.01x..3.01x
      eng.placeBet(a, stake, targetMult);
      acct(a).stakes += stake; acct(a).gas += GAS_PER_OP;
      bettors.push(a);
    }
    if (coalition) {
      const { absorberStake, wallets, walletStake, targetMult } = coalition;
      eng.placeBet("cAbs", absorberStake, 10001n);
      acct("cAbs").stakes += absorberStake; acct("cAbs").gas += GAS_PER_OP; coalitionAddrs.add("cAbs");
      for (let i = 0; i < wallets; i++) {
        const a = `cW${i}`;
        eng.placeBet(a, walletStake, targetMult);
        acct(a).stakes += walletStake; acct(a).gas += GAS_PER_OP; coalitionAddrs.add(a);
      }
    }
    // keepers: coalition runs keepers with prob 0.5 when present
    const keeper = coalition && rf(next) < 0.5 ? "cAbs" : "kHonest";
    if (coalition) coalitionAddrs.add("cAbs");

    ts += ROUND_SECONDS; blk += 30n;
    eng.lockRound({ blockNumber: blk, timestamp: ts, targetDrandRound: 1n, revealNotBefore: 0n, keeper });
    acct(keeper).gas += GAS_PER_OP;
    const entropy = next();
    eng.revealEntropy(rid, entropy, keeper);
    acct(keeper).gas += GAS_PER_OP;
    ts += 60n; blk += 60n;
    const before = eng.escrow.get(keeper) ?? 0n;
    eng.settleRound(rid, { blockNumber: blk, timestamp: ts, keeper });
    acct(keeper).gas += GAS_PER_OP;
    acct(keeper).keeper += (eng.escrow.get(keeper) ?? 0n) - before;
    transitions++;

    // register + claim
    let winners = 0;
    for (const [a, p] of r.players) {
      const { won } = eng.registerResult(rid, a);
      if (won) winners++;
    }
    blk += C.registrationWindowBlocks + 1n;
    if (winners === 0) {
      eng.sweepBustedRound(rid);
      bustedRounds++;
    } else {
      for (const [a, p] of r.players) {
        if (p.weight > 0n) {
          const { paid } = eng.claim(rid, a);
          acct(a).payouts += paid; acct(a).gas += GAS_PER_OP;
        }
      }
    }
    if (eng.reserve > maxReserve) maxReserve = eng.reserve;
    if (eng.strandedOverflow > strandedMaxWei) strandedMaxWei = eng.strandedOverflow;
    if (!eng.sinkOk && eng.strandedOverflow > 0n) failedSpills++;

    // Powerboard lottery drain: pays full balance to a wagering-share-weighted winner
    if ((n + 1) % LOTTERY_EVERY === 0) {
      const bal = eng.sinkBalance - lotteryPaid;
      if (bal > 0n) {
        let coStake = 0n, allStake = 0n;
        for (const [a, v] of pnl) { allStake += v.stakes; if (coalitionAddrs.has(a)) coStake += v.stakes; }
        const coShare = allStake > 0n ? Number(coStake) / Number(allStake) : 0;
        if (rf(next) < coShare) acct("cAbs").lottery += bal; else powerboardPaidHonest += bal;
        lotteryPaid += bal;
        if (lotteryPaid > eng.sinkBalance) throw new Error("POWERBOARD INSOLVENT");
      }
    }
    if (!eng.incomeBoundHolds()) throw new Error("INCOME BOUND VIOLATED");
  }

  // aggregate P&L
  const agg = (filter) => {
    let s = { stakes: 0n, payouts: 0n, gas: 0n, keeper: 0n, lottery: 0n };
    for (const [a, v] of pnl) if (filter(a)) for (const k of Object.keys(s)) s[k] += v[k];
    s.net = s.payouts + s.keeper + s.lottery - s.stakes - s.gas;
    return s;
  };
  return {
    transitions, rounds, haltedRounds, bustedRounds, failedSpills,
    finalReserve: eng.reserve, maxReserve, strandedMax: strandedMaxWei,
    sinkCumulative: eng.sinkBalance, lotteryPaid,
    seedDrawn: eng.cumSeedDrawn, seedReturned: eng.cumSeedReturned, reserveCutSum: eng.cumReserveCut,
    bootstrap: eng.cfg.seedBootstrapBudgetWei,
    coalition: agg((a) => coalitionAddrs.has(a) || a.startsWith("cW")),
    honest: agg((a) => a.startsWith("h")),
  };
}

function ci(vals) {
  const n = vals.length, mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = 1.96 * sd / Math.sqrt(n);
  return { mean, lo: mean - half, hi: mean + half };
}
const fmt = (c, d = 4) => `${c.mean.toFixed(d)} [${c.lo.toFixed(d)}, ${c.hi.toFixed(d)}]`;

function campaign(name, opts, seeds = 30, rounds = 2000) {
  const runs = [];
  for (let s = 1; s <= seeds; s++) runs.push(runOne({ seed: s * 7919, rounds, ...opts }));
  const out = {
    name, seeds, roundsPerSeed: rounds,
    transitions: runs.reduce((a, r) => a + r.transitions, 0),
    finalReserveEth: ci(runs.map((r) => f(r.finalReserve))),
    maxReserveEth: ci(runs.map((r) => f(r.maxReserve))),
    strandedMaxEth: ci(runs.map((r) => f(r.strandedMax))),
    sinkCumulativeEth: ci(runs.map((r) => f(r.sinkCumulative))),
    lotteryPaidEth: ci(runs.map((r) => f(r.lotteryPaid))),
    haltedRoundFrac: ci(runs.map((r) => r.haltedRounds / r.rounds)),
    bustedRoundFrac: ci(runs.map((r) => r.bustedRounds / r.rounds)),
    netSeedSpendEth: ci(runs.map((r) => f(r.seedDrawn - r.seedReturned))),
    incomeBoundSlackEth: ci(runs.map((r) => f(r.bootstrap + r.reserveCutSum - (r.seedDrawn - r.seedReturned)))),
    coalitionNetEth: ci(runs.map((r) => f(r.coalition.net))),
    honestNetEth: ci(runs.map((r) => f(r.honest.net))),
  };
  console.log(`\n== ${name} (${out.transitions} modeled settle-transitions) ==`);
  for (const k of Object.keys(out)) if (out[k]?.mean !== undefined) console.log(`  ${k}: ${fmt(out[k])}`);
  return out;
}

const results = [];
// 1. capped Vault, sink OK vs failing
results.push(campaign("capped-sinkOK", { sinkFailProb: 0 }));
results.push(campaign("capped-sinkFAIL-30pct", { sinkFailProb: 0.3 }));
results.push(campaign("capped-sinkFAIL-100pct", { sinkFailProb: 1 }));
// 2. multi-genesis
for (const g of ["zero", "partial", "floor", "cap", "stranded"])
  results.push(campaign(`genesis-${g}`, { genesis: g }, 20, 1500));
results.push(campaign("genesis-fundedBootstrap", { genesis: "fundedBootstrap", cfg: { seedBootstrapBudgetWei: eth(0.2) } }, 20, 1500));
results.push(campaign("genesis-noBootstrap", { genesis: "noBootstrap", cfg: { seedBootstrapBudgetWei: 0n } }, 20, 1500));
// 3. direct rake runs
for (const bps of [100n, 150n, 200n])
  results.push(campaign(`rake-${bps}bps`, { cfg: { rakeBps: bps } }, 20, 1500));
// 4. coalition (absorber + 4 wallets @2x), sink OK, with lottery capture
results.push(campaign("coalition-2x", { coalition: { absorberStake: eth(0.5), wallets: 4, walletStake: eth(0.25), targetMult: 20000n } }));
results.push(campaign("coalition-1.1x", { coalition: { absorberStake: eth(0.5), wallets: 4, walletStake: eth(0.25), targetMult: 11000n } }));
results.push(campaign("coalition-2x-sinkFAIL", { sinkFailProb: 1, coalition: { absorberStake: eth(0.5), wallets: 4, walletStake: eth(0.25), targetMult: 20000n } }));

writeFileSync(new URL("./campaign-results.json", import.meta.url), JSON.stringify(results, null, 1));
console.log("\nwritten campaign-results.json");
