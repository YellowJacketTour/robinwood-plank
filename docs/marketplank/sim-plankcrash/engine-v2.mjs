// Analysis-only. pendingOverflow VARIANT of the differential-validated Engine
// (engine.mjs), mirroring contracts/test/sim-plankcrash/PlankCrashOverflowV2Proto.sol:
//   - _creditReserve skims excess above reserveCap into pendingOverflow BEFORE
//     touching hwm / drawdownWindowPeak (design §3.2);
//   - _spillOverflow is a NO-OP (all five call sites removed in the proto);
//   - deliverOverflow(): debit-before-call, exact restore on failure (§8.4);
//   - forcedEth tracked separately (inert, §8.3): balance identity becomes
//     balance == Σ buckets + forcedEth.
// The §8.1 solvency identity is asserted after EVERY transition.
import { Engine } from "./engine.mjs";

export class EngineV2 extends Engine {
  constructor(cfg, genesisTimestamp) {
    super(cfg, genesisTimestamp);
    // NOTE: super() runs _startRound → _creditReserve is already the V2 one
    // (subclass method dispatch), but pendingOverflow may not exist yet at
    // that point — ensure init-before-use via the ??= in _creditReserve.
    this.pendingOverflow ??= 0n;
    this.forcedEth ??= 0n;
  }

  // §3.2: skim-before-peak. Replaces the base credit entirely.
  _creditReserve(amount, raisesWindowPeak = true) {
    this.pendingOverflow ??= 0n;
    let bal = this.reserve + amount;
    const cap = this.cfg.reserveCap;
    if (cap !== 0n && bal > cap) {
      const excess = bal - cap;
      this.pendingOverflow += excess;
      bal = cap;
      this.emit("OverflowQueued", { attempted: excess, queued: excess, pendingTotal: this.pendingOverflow });
    }
    this.reserve = bal;
    if (bal > this.reserveHighWaterMark) this.reserveHighWaterMark = bal;
    if (raisesWindowPeak && bal > this.drawdownWindowPeak) this.drawdownWindowPeak = bal;
  }

  // §8.8: no game transition calls the sink.
  _spillOverflow() {}

  // §8.4: CEI delivery. `ok` supplied by the driver (chain result / sinkOk).
  deliverOverflow(ok = this.sinkOk) {
    const amount = this.pendingOverflow;
    if (amount === 0n || !this.cfg.jackpotSink) return false;
    this.pendingOverflow = 0n;
    if (ok) {
      this.sinkBalance += amount;
      this.emit("OverflowDelivered", { attempted: amount, delivered: amount, restored: 0n, remaining: 0n });
    } else {
      this.pendingOverflow = amount;
      this.emit("OverflowDeliveryFailed", { attempted: amount, delivered: 0n, restored: amount, remaining: amount });
    }
    this.assertConservation("deliverOverflow");
    return ok;
  }

  forceEth(amount) {
    // selfdestruct-forced ETH: inert, unaccounted in any economic bucket.
    this.forcedEth = (this.forcedEth ?? 0n) + amount;
    this.assertConservation("forceEth");
  }

  get strandedOverflow() {
    return 0n; // reserve can never exceed cap in V2
  }

  ledger() {
    const L = super.ledger();
    L.pendingOverflow = this.pendingOverflow ?? 0n;
    L.forcedEth = this.forcedEth ?? 0n;
    return L;
  }

  // §8.1 exact solvency identity over currently-held + delivered + paid-out
  // value: Σ deposits == reserve + pendingOverflow + unsettledRoundLiabilities
  // (pools + crashed remaining incl. accountedDust + voided stakes) +
  // playerEscrows+keeper/treasury escrow + accumulatedRake + sinkBalance
  // (delivered) + paidOut. forcedEth sits OUTSIDE (balance-side surplus).
  assertConservation(where) {
    const L = this.ledger();
    const rhs = L.reserve + (this.pendingOverflow ?? 0n) + L.pools + L.remaining + L.escrow + L.accumulatedRake + L.sinkBalance + L.paidOut;
    if (rhs !== this.totalDeposits) {
      throw new Error(
        `V2 SOLVENCY IDENTITY VIOLATED at ${where}: deposits=${this.totalDeposits} rhs=${rhs} diff=${rhs - this.totalDeposits} ledger=${JSON.stringify(L, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`
      );
    }
  }

  snapshot() {
    const s = super.snapshot();
    s.pendingOverflow = this.pendingOverflow ?? 0n;
    s.forcedEth = this.forcedEth ?? 0n;
    return s;
  }
}
