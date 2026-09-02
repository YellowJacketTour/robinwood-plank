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
  constructor(growthPerSecond = PRIVATE_LIVE_GROWTH_PER_SECOND) {
    this.growthPerSecond = growthPerSecond;
    this.reset();
  }

  reset() {
    this.roundKey = null;
    this.startedPerfMs = null;
    this.deadlinePerfMs = null;
    this.lastBps = 10_000;
    this.lastVersion = -1n;
    this.displayLagMs = 0;
  }

  /**
   * `displayLagMs` is the server-published presentation lag δ: the whole
   * timeline (liftoff, curve, crash) renders δ late. During [T, T+δ] the
   * rocket burns on the pad at exactly 1.00x — the ignition hold — which is
   * also precisely the law a manual lock is granted under (m(arrival − δ)),
   * so the readout a player taps on is the multiplier the server grants.
   */
  synchronize({ roundKey, version, phase, startedAt, crashAt, serverNow, displayLagMs }, receivedPerfMs) {
    const parsedVersion = BigInt(version || 0);
    const isNewRound = roundKey !== this.roundKey;
    if (!isNewRound && parsedVersion < this.lastVersion) return false;
    if (isNewRound) {
      this.reset();
      this.roundKey = roundKey;
    }
    this.lastVersion = parsedVersion;
    const lag = Number(displayLagMs);
    if (Number.isFinite(lag) && lag > 0) this.displayLagMs = lag;
    // "settled" keeps anchoring: the authoritative crashAt is only published
    // at settlement, and the δ-lagged display still has the flight tail and
    // the crash itself left to render after the room row flips.
    if ((phase !== "running" && phase !== "settled") || !startedAt || !serverNow) return true;

    const serverNowMs = Date.parse(serverNow);
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(serverNowMs) || !Number.isFinite(startedAtMs)) return false;
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

    const crashAtMs = crashAt ? Date.parse(crashAt) : NaN;
    if (Number.isFinite(crashAtMs)) {
      const durationMs = Math.max(0, crashAtMs - startedAtMs);
      this.deadlinePerfMs = this.startedPerfMs + durationMs;
    }
    this.lastBps = Math.max(this.lastBps, this.computeBps(receivedPerfMs));
    return true;
  }

  computeBps(perfMs) {
    if (this.startedPerfMs === null) return 10_000;
    const effectivePerfMs = this.deadlinePerfMs === null ? perfMs : Math.min(perfMs, this.deadlinePerfMs);
    const elapsedSeconds = Math.max(0, effectivePerfMs - this.startedPerfMs) / 1_000;
    return Math.floor(10_000 * Math.exp(this.growthPerSecond * elapsedSeconds));
  }

  sample(perfMs) {
    this.lastBps = Math.max(this.lastBps, this.computeBps(perfMs));
    return this.lastBps;
  }
}
