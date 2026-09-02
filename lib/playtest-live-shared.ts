/**
 * Shared PlankCrash live-flight kernel.
 *
 * This module is the ONE authoritative definition of:
 *   1. the multiplier law M(t) used by the server to settle and by the
 *      client to present (never duplicate the formula elsewhere);
 *   2. the sampled flight path the client graph draws;
 *   3. the dynamically scaled graph viewport;
 *   4. the round clock: how a client turns authoritative server timestamps
 *      into a countdown and a flight clock without trusting its wall clock.
 *
 * It is intentionally pure and dependency-free so both the Node server and
 * the browser bundle import the identical code.
 *
 * ── Multiplier law ────────────────────────────────────────────────────────
 *   M(t) = e^(k·t)          with k = LIVE_GROWTH_PER_SECOND, t in seconds.
 *   In integer basis points: bps(t) = floor(10_000 · e^(k·t)), so
 *   bps(0) = 10_000 exactly (launch is exactly 1.00×) and bps is
 *   non-decreasing and continuous in t.
 *   Inverse: t(bps) = ln(bps/10_000)/k, exposed in integer milliseconds.
 *
 * ── Round clock semantics (integer milliseconds, T = scheduled/actual
 *    launch timestamp `startedAt`) ─────────────────────────────────────────
 *   remainingMs(now)  = max(0, T − now)              (never negative)
 *   displaySeconds    = ceil(remainingMs / 1000)     (never shows 0 while
 *                                                     positive time remains)
 *     T−1001ms → 2      (a full second plus 1ms still owes “2”)
 *     T−1000ms → 1
 *     T−1ms    → 1      (the final millisecond still displays “1”)
 *     T        → 0 and the flight clock starts at exactly 0
 *     T+1ms    → flight elapsed 1ms, bps(1ms) ≥ 10_000
 *   The presentation may enter RUNNING only when now ≥ T, even if the
 *   authoritative room row already reads phase="running" during the
 *   server-side pre-roll (the server schedules startedAt slightly in the
 *   future when it launches). Therefore: countdown showing a positive
 *   number and flight visuals are mutually exclusive by construction.
 */

export const LIVE_GROWTH_PER_SECOND = 0.22;

/** Multiplier in integer basis points after elapsedMs of flight (clamped ≥ 0). */
export function multiplierBpsAtMs(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  return Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * seconds));
}

/** Inverse of the law: the first integer millisecond at which the displayed
 * integer-bps multiplier reaches targetBps. Round-trips with multiplierBpsAtMs:
 * multiplierBpsAtMs(msToReachMultiplierBps(b)) ≥ b, and one ms earlier is < b
 * (up to the 1-bps floor discretization). */
export function msToReachMultiplierBps(targetBps: number): number {
  if (!Number.isFinite(targetBps) || targetBps <= 10_000) return 0;
  const exact = Math.log(targetBps / 10_000) / LIVE_GROWTH_PER_SECOND * 1_000;
  let ms = Math.max(0, Math.ceil(exact));
  // Floating point can land one ms to either side of the integer-bps floor.
  while (multiplierBpsAtMs(ms) < targetBps) ms += 1;
  while (ms > 0 && multiplierBpsAtMs(ms - 1) >= targetBps) ms -= 1;
  return ms;
}

export type FlightSample = { tMs: number; bps: number };

/**
 * Monotone sampled trace of the CURRENT flight from launch (t=0, exactly
 * 10_000 bps) to `elapsedMs` (endpoint equals the current authoritative
 * multiplier). Uniform in time, so early flight is legible; there is no
 * phantom coordinate beyond the endpoint and no discontinuity.
 */
export function sampleFlightPath(elapsedMs: number, points = 96): FlightSample[] {
  const clamped = Math.max(0, elapsedMs);
  const n = Math.max(2, Math.floor(points));
  const samples: FlightSample[] = [];
  for (let i = 0; i < n; i += 1) {
    const tMs = clamped * i / (n - 1);
    samples.push({ tMs, bps: multiplierBpsAtMs(tMs) });
  }
  // Exact invariants at the ends regardless of float rounding.
  samples[0] = { tMs: 0, bps: 10_000 };
  samples[n - 1] = { tMs: clamped, bps: multiplierBpsAtMs(clamped) };
  return samples;
}

export type FlightViewport = {
  /** Time axis: 0 .. tMaxMs (grows in stable bands ahead of the endpoint). */
  tMaxMs: number;
  /** Multiplier axis: 10_000 .. bpsMax (scaled to the live endpoint, NEVER
   * normalized to the full-round/crash multiplier). */
  bpsMax: number;
  /** Suggested y-axis tick values in bps, ascending, first is 10_000. */
  ticksBps: number[];
};

/**
 * Dynamic viewport for the live graph. Scales with what has actually
 * happened: the y-axis tops out ~15% above the current multiplier (with a
 * legible minimum of 1.50×) and the time axis keeps a modest horizon ahead
 * of the endpoint in whole-second bands, so at launch the trace starts at
 * the origin and visibly climbs instead of hugging a full-round axis.
 */
export function flightViewport(elapsedMs: number, currentBps: number): FlightViewport {
  const bpsMax = Math.max(15_000, Math.ceil(currentBps * 1.15));
  const horizon = Math.max(6_000, Math.ceil((Math.max(0, elapsedMs) + 1_500) / 2_000) * 2_000);
  const span = bpsMax - 10_000;
  const rawStep = span / 4;
  // Round tick step to 1/2/5×10^n bps for clean labels.
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? rawStep;
  const ticksBps: number[] = [];
  for (let v = 10_000; v <= bpsMax + 1e-9; v += step) ticksBps.push(Math.round(v));
  return { tMaxMs: horizon, bpsMax, ticksBps };
}

// ── Authoritative round clock ────────────────────────────────────────────

export type RoundClockInput = {
  phase: "lobby" | "running" | "settled";
  /** Authoritative launch timestamp (ms since epoch, server clock). */
  startedAtMs: number | null;
  /** Authoritative crash deadline (only published after settlement). */
  crashAtMs: number | null;
  settledAtMs: number | null;
  /** settledAt + intermission: the next scheduled automatic launch. */
  nextLaunchAtMs: number | null;
  /** Current time ON THE SERVER CLOCK (from a ServerClockSync estimate). */
  serverNowMs: number;
};

export type RoundClockView =
  | { kind: "lobby" }
  | { kind: "countdown"; remainingMs: number; displaySeconds: number }
  | { kind: "flight"; flightMs: number; bps: number }
  | { kind: "crashed"; flightMs: number }
  | { kind: "intermission"; remainingMs: number; displaySeconds: number };

/** Ceil-seconds countdown display: positive remaining time NEVER shows 0. */
export function countdownDisplaySeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(Math.max(0, remainingMs) / 1_000));
}

/**
 * The single client-side interpretation of authoritative timestamps.
 * `serverNowMs` must come from a monotonic server-time estimate (see
 * ServerClockSync); nothing here reads Date.now().
 */
export function deriveRoundClock(input: RoundClockInput): RoundClockView {
  const now = input.serverNowMs;
  if (input.phase === "running" && input.startedAtMs !== null) {
    const remainingMs = Math.max(0, input.startedAtMs - now);
    if (remainingMs > 0) {
      // Server pre-roll: the room row is "running" but the authoritative
      // launch instant has not arrived. Presentation stays pre-launch.
      return { kind: "countdown", remainingMs, displaySeconds: countdownDisplaySeconds(remainingMs) };
    }
    const flightMs = now - input.startedAtMs;
    if (input.crashAtMs !== null && now >= input.crashAtMs) {
      return { kind: "crashed", flightMs: input.crashAtMs - input.startedAtMs };
    }
    return { kind: "flight", flightMs, bps: multiplierBpsAtMs(flightMs) };
  }
  if (input.phase === "settled") {
    if (input.nextLaunchAtMs !== null) {
      const remainingMs = Math.max(0, input.nextLaunchAtMs - now);
      return { kind: "intermission", remainingMs, displaySeconds: countdownDisplaySeconds(remainingMs) };
    }
    return { kind: "intermission", remainingMs: 0, displaySeconds: 0 };
  }
  return { kind: "lobby" };
}

/**
 * Monotonic server-time estimator.
 *
 * Anchors the estimated server clock to performance.now() (monotonic), so a
 * wall-clock jump on the client cannot move the countdown. Each observation
 * carries the request round-trip: the server timestamped `serverNowMs`
 * somewhere inside [sentPerfMs, receivedPerfMs], so the midpoint is the
 * unbiased anchor and rtt/2 bounds the error. Only observations that
 * tighten the error bound replace the anchor; the estimate itself is a pure
 * linear extension and therefore strictly monotonic between updates.
 */
export class ServerClockSync {
  private anchorServerMs: number | null = null;
  private anchorPerfMs = 0;
  private anchorErrorMs = Number.POSITIVE_INFINITY;
  private lastEstimate = Number.NEGATIVE_INFINITY;

  observe(serverNowMs: number, sentPerfMs: number, receivedPerfMs: number): void {
    if (!Number.isFinite(serverNowMs) || receivedPerfMs < sentPerfMs) return;
    const rtt = receivedPerfMs - sentPerfMs;
    const error = rtt / 2;
    // Error bounds loosen over time (clock drift ~ +1ms per elapsed second
    // is a generous skew allowance), so a fresh slightly-worse sample can
    // still replace a stale anchor.
    const age = this.anchorServerMs === null ? Infinity : receivedPerfMs - this.anchorPerfMs;
    if (error <= this.anchorErrorMs + age * 0.001) {
      this.anchorServerMs = serverNowMs + error; // midpoint of [sent, received] on server axis
      this.anchorPerfMs = receivedPerfMs;
      this.anchorErrorMs = error;
    }
  }

  /** Estimated current server time; monotonic non-decreasing across calls
   * with non-decreasing perfNowMs, even when a resync moves the anchor. */
  now(perfNowMs: number): number | null {
    if (this.anchorServerMs === null) return null;
    const estimate = this.anchorServerMs + (perfNowMs - this.anchorPerfMs);
    this.lastEstimate = Math.max(this.lastEstimate, estimate);
    return this.lastEstimate;
  }

  get synchronized(): boolean {
    return this.anchorServerMs !== null;
  }
}
