// Game-theory verification for F-1 (lottery drain) and F-2 (seed farm).
// Units: credits. Exact discrete survival law as on-chain: P(crash >= m) = floor(1e8/m)/1e4.
const BPS = 10000n;
const pSurv = (mBps) => Number(100_000_000n / mBps) / 1e4;
const ln = Math.log;

// ── Ratified parameters (test/contracts/helpers/casino.ts) ─────────────────
const RAKE = 0.045, FLOOR = 0.75, WHALE = 0.6, SEED = 10_000, MIN_POOL = 5_000;
const ODDS = 16, X_MIN = 0.10, X_MAX = 0.30, C_HALF = 250_000;
// lottery share of every rake credit: 40% community x 65% routed to lottery
const LOTTERY_SHARE_OF_RAKE = 0.40 * 0.65;

const x = (P) => X_MIN + (X_MAX - X_MIN) * P / (P + C_HALF);
const W = (P) => P * (1 - x(P));

// ── CCS-2L two-seat settlement (exact structure of PlankCcs2LMath) ────────
// seats: [{s, m}], crashBps: the realized crash; returns total paid to seats incl. bonus.
function settle(pool, seed, crash, seats, hCapRule) {
  const D = pool * (1 - RAKE);
  const surv = seats.map(t => t.m <= crash);
  const floors = seats.map((t, i) => surv[i] ? FLOOR * t.s : 0);
  const ws = seats.map((t, i) => surv[i] ? t.s * ln(Number(t.m) / 1e4) : 0);
  const Wsum = ws.reduce((a, b) => a + b, 0);
  let paid = 0;
  if (Wsum > 0) paid = D; // pot fully returned to survivors (floor + premium)
  // house layer
  let H = seed;                                   // reserveCap assumed non-binding (worst case)
  if (hCapRule) H = Math.min(H, hCapRule(pool));  // the candidate fix
  let bonus = 0;
  if (H > 0 && Wsum > 0) {
    for (let i = 0; i < seats.length; i++) {
      if (!surv[i]) continue;
      let b = H * ws[i] / Wsum;
      const fairCap = seats[i].s * (Number(seats[i].m) / 1e4 - 1);
      if (b > fairCap) b = fairCap;
      bonus += b;
    }
  }
  return { paid, bonus };
}

// EV of a solo table (all seats are the attacker's) = E[paid+bonus] - pool
function soloEV(pool, seed, seats, hCapRule) {
  // crash outcomes partition by the sorted distinct targets
  const ms = [...new Set(seats.map(t => t.m))].sort((a, b) => Number(a - b));
  let ev = -pool;
  let prevP = 1; // P(crash >= 1.00) = 1
  // probability crash in [ms[i], ms[i+1]) = pSurv(ms[i]) - pSurv(ms[i+1])
  for (let i = 0; i < ms.length; i++) {
    const pHere = pSurv(ms[i]) - (i + 1 < ms.length ? pSurv(ms[i + 1]) : 0);
    const r = settle(pool, seed, ms[i], seats, hCapRule);
    ev += pHere * (r.paid + r.bonus);
  }
  return ev;
}

console.log("=== F-2: two-target seed farm, CURRENT law (fixed seed) ===");
{
  const sB = WHALE * MIN_POOL, sA = MIN_POOL - sB;
  const mB = BigInt(Math.floor((1 + SEED / sB) * 1e4));
  const ev = soloEV(MIN_POOL, SEED, [{ s: sA, m: 10_100n }, { s: sB, m: mB }], null);
  console.log(`pool=${MIN_POOL} seed=${SEED} mB=${Number(mB)/1e4}x  EV/round = ${ev.toFixed(0)} credits  (audit: +2,043; rake paid ${MIN_POOL*RAKE})`);
  // best response search over split & targets
  let best = { ev: -1e9 };
  for (let share = 0.05; share <= WHALE + 1e-9; share += 0.05) {
    const b = share * MIN_POOL, a = MIN_POOL - b;
    for (let mb = 10_100; mb <= 2_000_000; mb = Math.round(mb * 1.05)) {
      const ev2 = soloEV(MIN_POOL, SEED, [{ s: a, m: 10_100n }, { s: b, m: BigInt(mb) }], null);
      if (ev2 > best.ev) best = { ev: ev2, share, mb };
    }
  }
  console.log(`attacker best response: B share=${best.share.toFixed(2)} mB=${best.mb/1e4}x  EV=+${best.ev.toFixed(0)}/round`);
  // closed form: E[bonus] = seed*sB/(seed+sB) at optimum, minus rake
  const closed = SEED * sB / (SEED + sB) - RAKE * MIN_POOL;
  console.log(`closed form  seed*sB/(seed+sB) - rake*pool = ${closed.toFixed(0)}`);
  // condition for ANY fixed seed to be farmable: seed > r*w/(w-r) * pool
  console.log(`farmable iff seed > ${(RAKE*WHALE/(WHALE-RAKE)*100).toFixed(2)}% of pool  (rake floor 2.5% -> ${(0.025*WHALE/(WHALE-0.025)*100).toFixed(2)}%)`);
}

console.log("\n=== F-2 under FIX: house bonus per round <= kappa_h * rake_round (kappa_h = 0.5) ===");
{
  const cap = (pool) => 0.5 * RAKE * pool;
  let worst = -1e9, arg = null;
  for (const pool of [MIN_POOL, 20_000, 100_000, 1_000_000]) {
    for (const seed of [SEED, 10 * SEED, 100 * SEED]) {
      for (let share = 0.05; share <= WHALE + 1e-9; share += 0.05) {
        const b = share * pool, a = pool - b;
        for (let mb = 10_100; mb <= 100_000_000; mb = Math.round(mb * 1.07)) {
          for (const ma of [10_100n, 15_000n, 20_000n]) {
            const ev = soloEV(pool, seed, [{ s: a, m: ma }, { s: b, m: BigInt(mb) }], cap);
            if (ev > worst) { worst = ev; arg = { pool, seed, share, mb, ma }; }
          }
        }
      }
    }
  }
  console.log(`max attacker EV over pool/seed/split/targets = ${worst.toFixed(1)} credits/round  at ${JSON.stringify(arg,(k,v)=>typeof v==="bigint"?Number(v)/1e4+"x":v)}`);
  console.log(`proof sketch: bonus <= kappa_h*rake < rake paid, parimutuel layer zero-sum among sybils => EV <= (kappa_h - 1)*rake < 0`);
}

console.log("\n=== F-1: manufactured lottery rounds, CURRENT law (p_hit = 1/16 flat) ===");
{
  const rake = RAKE * MIN_POOL;
  for (const P of [2_000, 4_000, 10_000, 90_000, 500_000]) {
    const ev = W(P) / ODDS - rake + LOTTERY_SHARE_OF_RAKE * rake / ODDS * 0; // ignore self-contribution
    console.log(`P=${P.toString().padStart(7)}  W=${W(P).toFixed(0).padStart(7)}  EV/round = ${ev.toFixed(0)}  (rake ${rake})`);
  }
  console.log(`break-even P where W(P)/16 = rake: ${(() => { let P = 1; while (W(P) / ODDS < rake) P += 1; return P; })()} credits (audit: ~4,000)`);
  console.log(`A-10 replay: P=90,000 -> W=${W(90_000).toFixed(0)} taken for ${rake} rake (audit: 76,235)`);
}

console.log("\n=== F-1 under FIX: actuarial hit rule p = min(1/16, c_round / (kappa * W(P))), kappa = 2 ===");
{
  const KAPPA = 2;
  const c = (pool) => LOTTERY_SHARE_OF_RAKE * RAKE * pool;
  let worst = -1e9;
  for (const pool of [MIN_POOL, 20_000, 100_000]) for (const P of [1_000, 4_000, 90_000, 1_000_000, 1e7]) {
    const p = Math.min(1 / ODDS, c(pool) / (KAPPA * W(P)));
    const ev = p * W(P) - RAKE * pool;
    worst = Math.max(worst, ev);
  }
  console.log(`max attacker EV over pool and P = ${worst.toFixed(1)} credits/round  (always = c/kappa - rake < 0)`);
  console.log(`honest cadence (20k table, c=${c(20_000).toFixed(0)}/round):`);
  for (const P of [10_000, 50_000, 150_000, 500_000, 1_000_000]) {
    const p = Math.min(1 / ODDS, c(20_000) / (KAPPA * W(P)));
    console.log(`  P=${P.toString().padStart(9)}  p_hit=1/${(1/p).toFixed(0).padStart(5)}  E[rounds to hit]=${(1/p).toFixed(0).padStart(5)}  net prize growth/round=${(c(20_000)-p*W(P)).toFixed(0)}`);
  }
}

console.log("\n=== mustHitBy in CONTRIBUTION units (fires when cum. contribution since last hit >= M*W) ===");
{
  const M = 6; // owner's 6xE[R] spirit, now in money
  const P = 90_000, w = W(P);
  const costToForce = M * w / LOTTERY_SHARE_OF_RAKE; // rake an attacker must pay to force alone
  console.log(`P=${P}: forcing costs ${costToForce.toFixed(0)} credits of rake to win W=${w.toFixed(0)} -> EV=${(w - costToForce).toFixed(0)} (audit current-law forcing cost: 21,600)`);
}
