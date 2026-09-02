export type PlaytestPhase = "lobby" | "running" | "settled";
export type CommandStatus = "submitting" | "accepted" | "rejected" | "unknown";

export type VisibleCommand = {
  id: string;
  action: string;
  status: CommandStatus;
  message: string;
  sequence?: string;
};

export function presentedMultiplierBps(input: {
  phase: PlaytestPhase;
  liveBps: number | null;
  crashBps: string | null;
  deadlinePassed: boolean;
}): number {
  const crash = input.crashBps ? Number(input.crashBps) : 10_000;
  if (input.phase === "settled" || input.deadlinePassed) return crash;
  if (input.phase === "running") return Math.min(input.liveBps ?? 10_000, crash);
  return 10_000;
}

export function signedNet(stake: string, payout: string | null): bigint | null {
  if (payout === null) return null;
  return BigInt(payout) - BigInt(stake);
}

// ── live-curve viewport (DEFECT: choppy graph / curve not hugging the axis) ──
// The old viewport re-quantized the shared horizon in 4-second bands
// (max(4000, ceil((elapsed+1000)/4000)*4000)), so BOTH axes rebased in steps:
// every 4s the whole rendered path snapped to a new mapping, and right after
// each snap the short horizon parked the endpoint high on the y-range, hiding
// the exponential's early hug of the x-axis. This viewport is continuous in
// elapsed time, so the mapping is C0 frame-to-frame (no pixel jumps of
// already-drawn history) and the endpoint rides a stable visual band.
//
// x-horizon: golden-ratio lead — the live endpoint asymptotes to 1/φ ≈ 61.8%
// of the plot width instead of drifting to the right edge or snapping back.
// y-ceiling: the same law M(t)=e^{0.22t} evaluated a fixed 3s ahead of now,
// so the endpoint's height fraction settles near e^{-0.22·3} ≈ 52% while the
// early trace (t ≪ horizon) demonstrably hugs the bottom-left.
export const CURVE_RATE_PER_SEC = 0.22;
export const CURVE_MIN_HORIZON_MS = 4_000;
export const CURVE_X_GOLDEN = 1.618;
export const CURVE_X_LEAD_MS = 800;
export const CURVE_Y_LEAD_MS = 3_000;

export function curveViewport(elapsedMs: number): { xHorizonMs: number; yCeilMultiplier: number } {
  const clamped = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const xHorizonMs = Math.max(CURVE_MIN_HORIZON_MS, clamped * CURVE_X_GOLDEN + CURVE_X_LEAD_MS);
  const yHorizonMs = Math.max(CURVE_MIN_HORIZON_MS, clamped + CURVE_Y_LEAD_MS);
  const yCeilMultiplier = Math.exp(CURVE_RATE_PER_SEC * yHorizonMs / 1000);
  return { xHorizonMs, yCeilMultiplier };
}

/** Fractions of plot width/height for a sample at (tMs, multiplier) given the
 * live elapsed time. Monotone in both arguments; continuous in elapsedMs. */
export function curvePointFractions(tMs: number, multiplier: number, elapsedMs: number): { xFrac: number; yFrac: number } {
  const view = curveViewport(elapsedMs);
  return {
    xFrac: Math.min(1, Math.max(0, tMs) / view.xHorizonMs),
    yFrac: Math.min(1, Math.max(0, multiplier - 1) / (view.yCeilMultiplier - 1)),
  };
}

export function connectionState(lastSuccessAt: number | null, now: number): "idle" | "live" | "delayed" | "offline" {
  if (lastSuccessAt === null) return "idle";
  const age = now - lastSuccessAt;
  // The authoritative update endpoint intentionally holds a quiet request for
  // up to 20 seconds. Freshness thresholds must sit beyond that normal window.
  if (age > 45_000) return "offline";
  if (age > 25_000) return "delayed";
  return "live";
}
