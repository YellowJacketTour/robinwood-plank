export const PRIVATE_LIVE_GROWTH_PER_SECOND = 0.22;

/**
 * Smooth presentation clock for an authoritative live round.
 *
 * The server owns startedAt/crashAt. performance.now() owns animation time.
 * A snapshot may only move the presentation forward; delayed or reordered
 * network responses can never rewind the multiplier or restart ignition.
 */
export class PrivateLiveClock {
  constructor(growthPerSecond = PRIVATE_LIVE_GROWTH_PER_SECOND, maxPredictionLeadMs = 2_500) {
    this.growthPerSecond = growthPerSecond;
    this.maxPredictionLeadMs = maxPredictionLeadMs;
    this.reset();
  }

  reset() {
    this.roundKey = null;
    this.startedPerfMs = null;
    this.deadlinePerfMs = null;
    this.authoritativePerfMs = null;
    this.lastBps = 10_000;
    this.lastVersion = -1n;
  }

  synchronize({ roundKey, version, phase, startedAt, crashAt, serverNow }, receivedPerfMs) {
    const parsedVersion = BigInt(version || 0);
    const isNewRound = roundKey !== this.roundKey;
    if (!isNewRound && parsedVersion < this.lastVersion) return false;
    if (isNewRound) {
      this.reset();
      this.roundKey = roundKey;
    }
    this.lastVersion = parsedVersion;
    if (phase !== "running" || !startedAt || !serverNow) return true;

    const serverNowMs = Date.parse(serverNow);
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(serverNowMs) || !Number.isFinite(startedAtMs)) return false;
    const authoritativeElapsedMs = Math.max(0, serverNowMs - startedAtMs);
    const candidateStartedPerfMs = receivedPerfMs - authoritativeElapsedMs;
    this.authoritativePerfMs = receivedPerfMs;

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
    // Dead-reckon only a short distance beyond the newest authoritative
    // heartbeat. A disconnected browser must not advertise a multiplier
    // that the server can no longer accept. Fresh heartbeats keep normal
    // motion continuous; a partition visibly holds instead of inventing
    // economic time.
    const predictedPerfMs = this.authoritativePerfMs === null
      ? perfMs
      : Math.min(perfMs, this.authoritativePerfMs + this.maxPredictionLeadMs);
    const effectivePerfMs = this.deadlinePerfMs === null ? predictedPerfMs : Math.min(predictedPerfMs, this.deadlinePerfMs);
    const elapsedSeconds = Math.max(0, effectivePerfMs - this.startedPerfMs) / 1_000;
    return Math.floor(10_000 * Math.exp(this.growthPerSecond * elapsedSeconds));
  }

  sample(perfMs) {
    this.lastBps = Math.max(this.lastBps, this.computeBps(perfMs));
    return this.lastBps;
  }

  isPredictionHeld(perfMs) {
    return this.authoritativePerfMs !== null && perfMs > this.authoritativePerfMs + this.maxPredictionLeadMs;
  }
}
