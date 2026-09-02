"use client";

/**
 * DEV-ONLY presentation harness (no database, no credits, no wagering).
 *
 * Drives the REAL PlankCrashScene and the REAL shared round-clock /
 * multiplier kernel (lib/playtest-live-shared) with an in-page simulated
 * authoritative server, so launch geometry, the live curve, and the
 * countdown-to-launch contract can be verified in a browser without
 * PostgreSQL. The simulated server follows the production contract exactly:
 * settledAt + 30s intermission (shortened via ?intermission=), a 1.5s
 * pre-roll between the launch command and startedAt, crashAt from the shared
 * inverse of M(t).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import PlankCrashScene from "@/components/playtest/PlankCrashScene";
import {
  deriveRoundClock, msToReachMultiplierBps,
} from "@/lib/playtest-live-shared";

const PREROLL_MS = 1_500;

type SimRoom = {
  phase: "lobby" | "running" | "settled";
  round: number;
  startedAtMs: number | null;
  crashAtMs: number | null;
  settledAtMs: number | null;
  crashBps: number;
};

export default function PlaytestPreviewPage() {
  const [tick, setTick] = useState({ perfMs: 0, wallMs: 0 });
  // Read the query only after mount so SSR and client render identically.
  const [intermissionMs, setIntermissionMs] = useState(8_000);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const raw = Number(new URLSearchParams(window.location.search).get("intermission"));
      if (Number.isFinite(raw) && raw >= 1_000) setIntermissionMs(raw);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const crashSequence = useMemo(() => [23_500, 14_200, 61_000, 18_700, 32_000], []);
  const [room, setRoom] = useState<SimRoom>({
    phase: "lobby", round: 0, startedAtMs: null, crashAtMs: null,
    settledAtMs: null, crashBps: 23_500,
  });
  const roomRef = useRef(room);
  useEffect(() => { roomRef.current = room; }, [room]);

  // The simulated authoritative keeper: launches after the intermission,
  // settles at the committed crash instant. Same contract as the server.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = roomRef.current;
      const now = Date.now();
      if (current.phase === "lobby") {
        setRoom({ ...current, phase: "settled", settledAtMs: now });
      } else if (current.phase === "settled" && current.settledAtMs !== null
          && now >= current.settledAtMs + intermissionMs) {
        const crashBps = crashSequence[current.round % crashSequence.length];
        const startedAtMs = now + PREROLL_MS;
        setRoom({
          phase: "running", round: current.round + 1, startedAtMs,
          crashAtMs: startedAtMs + Math.max(350, msToReachMultiplierBps(crashBps)),
          settledAtMs: null, crashBps,
        });
      } else if (current.phase === "running" && current.crashAtMs !== null
          && now >= current.crashAtMs + 400) {
        setRoom({ ...current, phase: "settled", settledAtMs: now });
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [intermissionMs, crashSequence]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick({ perfMs: performance.now(), wallMs: Date.now() }), 100);
    return () => window.clearInterval(timer);
  }, []);

  const clock = deriveRoundClock({
    phase: room.phase,
    startedAtMs: room.startedAtMs,
    crashAtMs: room.crashAtMs,
    settledAtMs: room.settledAtMs,
    nextLaunchAtMs: room.settledAtMs === null ? null : room.settledAtMs + intermissionMs,
    serverNowMs: tick.wallMs,
  });

  return (
    <div data-market-shell className="site-shell min-h-screen px-1 py-2 text-cream md:px-3">
      <div className="mx-auto max-w-[1100px]">
        <header className="mb-3 rounded-xl border border-line bg-panel px-4 py-3">
          <p className="text-xs font-black uppercase tracking-[.18em] text-gold-400">Presentation harness · simulated clock · no credits</p>
          <h1 className="mt-1 font-display text-2xl text-gold-300">PlankCrash Scene Preview</h1>
          <p className="mt-1 font-mono text-xs text-cream-muted" data-testid="sim-state">
            round={room.round} phase={room.phase} clock={clock.kind}
            {clock.kind === "countdown" || clock.kind === "intermission" ? ` t-minus=${clock.displaySeconds}s` : ""}
            {clock.kind === "flight" ? ` elapsed=${(clock.flightMs / 1_000).toFixed(1)}s bps=${clock.bps}` : ""}
            {" "}crash={(room.crashBps / 10_000).toFixed(2)}x
          </p>
        </header>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel-strong shadow-2xl">
          <PlankCrashScene
            clock={clock}
            clockAtPerfMs={tick.perfMs}
            crashMultiplier={room.phase === "settled" ? room.crashBps / 10_000 : null}
          />
        </div>
      </div>
    </div>
  );
}
