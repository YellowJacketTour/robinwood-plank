/**
 * Monotonic server-time estimator -- browser-module port of
 * lib/playtest-live-shared.ts's ServerClockSync (kept behaviorally identical;
 * that file is the tested source of truth, this is its browser-consumable
 * twin, since public/arcade/crash.html is a plain <script type="module"> with
 * no bundler and cannot import a TypeScript file from lib/ directly).
 *
 * Anchors the estimated server clock to performance.now() (monotonic), so a
 * wall-clock jump on the client cannot move the countdown. Each observation
 * carries the request round-trip: the server timestamped `serverNowMs`
 * somewhere inside [sentPerfMs, receivedPerfMs], so the midpoint is the
 * unbiased anchor and rtt/2 bounds the error. Only observations that tighten
 * the error bound replace the anchor; the estimate itself is a pure linear
 * extension and therefore strictly monotonic between updates.
 *
 * This is what fixes the intermission-countdown reset bug: the arcade client
 * previously derived "now" as `Date.now() + (Date.parse(serverNow) -
 * Date.now())`, RECOMPUTED on every repaint -- including a repaint of the
 * SAME cached snapshot (acknowledgePrivateSettlement's dismiss-the-reveal
 * repaint), which re-anchored the offset to whenever that snapshot was
 * originally fetched and discarded all real elapsed time since. A long-poll
 * response can also sit pending for many seconds (the room version is static
 * for the whole 30s intermission, so the fetch can hold open near the full
 * timeout before returning), which the naive offset also could not account
 * for. ServerClockSync only ever advances -- observe() only replaces the
 * anchor with a fresh, real network round-trip, and now() never moves
 * backward, so a stale repaint of old data cannot ever rewind the estimate.
 */
export class ServerClockSync {
  #anchorServerMs = null;
  #anchorPerfMs = 0;
  #anchorErrorMs = Number.POSITIVE_INFINITY;
  #lastEstimate = Number.NEGATIVE_INFINITY;

  observe(serverNowMs, sentPerfMs, receivedPerfMs) {
    if (!Number.isFinite(serverNowMs) || receivedPerfMs < sentPerfMs) return;
    const rtt = receivedPerfMs - sentPerfMs;
    const error = rtt / 2;
    // Error bounds loosen over time (clock drift ~ +1ms per elapsed second is
    // a generous skew allowance), so a fresh slightly-worse sample can still
    // replace a stale anchor.
    const age = this.#anchorServerMs === null ? Infinity : receivedPerfMs - this.#anchorPerfMs;
    if (error <= this.#anchorErrorMs + age * 0.001) {
      this.#anchorServerMs = serverNowMs + error; // midpoint of [sent, received] on the server axis
      this.#anchorPerfMs = receivedPerfMs;
      this.#anchorErrorMs = error;
    }
  }

  /** Estimated current server time; monotonic non-decreasing across calls
   * with non-decreasing perfNowMs, even when a resync moves the anchor. */
  now(perfNowMs) {
    if (this.#anchorServerMs === null) return null;
    const estimate = this.#anchorServerMs + (perfNowMs - this.#anchorPerfMs);
    this.#lastEstimate = Math.max(this.#lastEstimate, estimate);
    return this.#lastEstimate;
  }

  get synchronized() {
    return this.#anchorServerMs !== null;
  }
}
