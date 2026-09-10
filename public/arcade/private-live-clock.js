export const PRIVATE_LIVE_GROWTH_PER_SECOND = 0.22;

/** Unique elapsed time whose exponential curve terminates at endBps. */
export function privateCurveDurationSeconds(endBps, growthPerSecond = PRIVATE_LIVE_GROWTH_PER_SECOND) {
  const bps = Number(endBps);
  const growth = Number(growthPerSecond);
  if (!Number.isFinite(bps) || bps < 10_000 || !Number.isFinite(growth) || growth <= 0) return 0;
  return Math.log(bps / 10_000) / growth;
}

/**
 * Smooth presentation clock for an authoritative live round.
 *
 * The server owns startedAt/crashAt. performance.now() owns animation time.
 * A snapshot may only move the presentation forward; delayed or reordered
 * network responses can never rewind the multiplier or restart ignition.
 */
export class PrivateLiveClock {
  constructor(growthPerSecond = PRIVATE_LIVE_GROWTH_PER_SECOND, maxPredictionLeadMs = 2500) {
    if (!Number.isFinite(growthPerSecond) || growthPerSecond <= 0 || !Number.isFinite(maxPredictionLeadMs) || maxPredictionLeadMs < 0) throw new RangeError('Invalid clock configuration');
    this.growthPerSecond = growthPerSecond;
    this.maxPredictionLeadMs = maxPredictionLeadMs;
    this.reset();
  }

  reset() {
    this.roundKey = null;
    this.startedPerfMs = null;
    this.deadlinePerfMs = null;
    this.lastBps = 10_000;
    this.lastVersion = -1n;
    this.displayLagMs = 0;
    this.lastServerNowMs = -Infinity;
    this.authoritativePerfMs = null;
    this.phase = null;
  }

  /**
   * `displayLagMs` is the server-published presentation lag δ: the whole
   * timeline (liftoff, curve, crash) renders δ late. During [T, T+δ] the
   * rocket burns on the pad at exactly 1.00x — the ignition hold — which is
   * also precisely the law a manual lock is granted under (m(arrival − δ)),
   * so the readout a player taps on is the multiplier the server grants.
   */
  synchronize({ roundKey, version, phase, startedAt, crashAt, serverNow, displayLagMs }, receivedPerfMs) {
    if (typeof roundKey !== 'string' || !roundKey || !/^\d+$/.test(String(version)) || !Number.isFinite(receivedPerfMs)) return false;
    const parsedVersion = BigInt(version);
    const isNewRound = roundKey !== this.roundKey;
    if (!isNewRound && parsedVersion < this.lastVersion) return false;
    const previousKey = this.roundKey?.match(/^(.*):(\d+)$/);
    const nextKey = roundKey.match(/^(.*):(\d+)$/);
    if (previousKey && nextKey && previousKey[1] === nextKey[1] && BigInt(nextKey[2]) < BigInt(previousKey[2])) return false;
    const serverNowMs = Date.parse(serverNow);
    const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
    const crashAtMs = crashAt ? Date.parse(crashAt) : NaN;
    if (!Number.isFinite(serverNowMs) || !['lobby','running','settled'].includes(phase)) return false;
    if (phase !== 'lobby' && !Number.isFinite(startedAtMs)) return false;
    if (crashAt && (!Number.isFinite(crashAtMs) || crashAtMs < startedAtMs)) return false;
    if (!isNewRound && (serverNowMs < this.lastServerNowMs || (this.authoritativePerfMs !== null && receivedPerfMs < this.authoritativePerfMs))) return false;
    if (!isNewRound && this.phase === 'settled' && phase !== 'settled') return false;
    // A duplicate state is not fresh evidence of elapsed economic time.
    if (!isNewRound && parsedVersion === this.lastVersion && serverNowMs === this.lastServerNowMs) return true;
    if (isNewRound) {
      this.reset();
      this.roundKey = roundKey;
    }
    this.lastVersion = parsedVersion;
    this.lastServerNowMs = serverNowMs;
    this.authoritativePerfMs = receivedPerfMs;
    this.phase = phase;
    const lag = Number(displayLagMs);
    if (Number.isFinite(lag) && lag > 0) this.displayLagMs = lag;
    // "settled" keeps anchoring: the authoritative crashAt is only published
    // at settlement, and the δ-lagged display still has the flight tail and
    // the crash itself left to render after the room row flips.
    if ((phase !== "running" && phase !== "settled") || !startedAt || !serverNow) return true;

    // May be NEGATIVE during the server pre-roll (startedAt is scheduled in
    // the future). Clamping it at 0 used to slide the presentation start up
    // to the whole pre-roll early — which both launched the display before
    // the authoritative T and silently cancelled the δ lag. computeBps()
    // already clamps its own elapsed time at 0, so a future start is safe.
    const authoritativeElapsedMs = serverNowMs - startedAtMs;
    // Lagged presentation: the display flight clock starts δ after the
    // authoritative launch instant, so liftoff and the crash render δ late.
    const candidateStartedPerfMs = receivedPerfMs - authoritativeElapsedMs + this.displayLagMs;

    // Establish once, then accept only forward corrections. A later start
    // would make elapsed time and the visible multiplier move backwards.
    if (this.startedPerfMs === null) this.startedPerfMs = candidateStartedPerfMs;
    else this.startedPerfMs = Math.min(this.startedPerfMs, candidateStartedPerfMs);

    if (Number.isFinite(crashAtMs)) {
      const durationMs = Math.max(0, crashAtMs - startedAtMs);
      this.deadlinePerfMs = this.startedPerfMs + durationMs;
      // A revealed result outranks prediction, including a prior overshoot.
      this.lastBps = Math.min(this.lastBps, this.computeBps(this.deadlinePerfMs));
    }
    this.lastBps = Math.max(this.lastBps, this.computeBps(receivedPerfMs));
    return true;
  }

  computeBps(perfMs) {
    if (!Number.isFinite(perfMs)) return this.lastBps;
    if (this.startedPerfMs === null) return 10_000;
    // A known settled endpoint can replay to completion. An unknown live
    // endpoint may only predict briefly beyond the newest server heartbeat.
    const effectivePerfMs = this.deadlinePerfMs === null
      ? Math.min(perfMs, Math.max(this.authoritativePerfMs, this.startedPerfMs) + this.maxPredictionLeadMs)
      : Math.min(perfMs, this.deadlinePerfMs);
    const elapsedSeconds = Math.max(0, effectivePerfMs - this.startedPerfMs) / 1_000;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(10_000 * Math.exp(this.growthPerSecond * elapsedSeconds)));
  }

  sample(perfMs) {
    this.lastBps = Math.max(this.lastBps, this.computeBps(perfMs));
    return this.lastBps;
  }

  isPredictionHeld(perfMs) {
    return this.phase === 'running' && this.deadlinePerfMs === null && this.authoritativePerfMs !== null && perfMs > Math.max(this.authoritativePerfMs, this.startedPerfMs) + this.maxPredictionLeadMs;
  }
}
