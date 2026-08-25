"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * Smoothly animates a DISPLAYED percentage toward the latest real
 * archivalScore between polls, so the number and bar visibly creep upward
 * in real time instead of jumping in a discrete step on every ~20s fetch.
 *
 * Honesty constraint (same discipline as every other real value in this
 * app -- never fabricate, never extrapolate past known truth): this only
 * ever tweens BETWEEN two real fetched values already returned by the
 * server. It never guesses forward past the latest real number, and it
 * always lands exactly on that real number -- the motion is a real
 * interpolation of already-true data, not invented growth.
 *
 * Real bug found live 2026-08-25 ("isnt showing the live growing piece by
 * piece level hydration"): the old 4s duration finished the tween long
 * before the next real fetch landed -- every caller here polls on a 20s
 * cadence (MultichainCollectionView's collection fetch, GlobalMarketHub's
 * rankings fetch), so the bar sat visibly static for the remaining ~16s
 * of every cycle, reading as dead between updates even though the real
 * backend kept advancing underneath. Default raised to just under that
 * real poll interval so the interpolation is still actively in motion
 * right up to the moment the next real value arrives.
 */
export function useTweenedPercent(target: number | null, durationMs = 19_000): number | null {
  const reduced = usePrefersReducedMotion();
  const [displayed, setDisplayed] = useState<number | null>(target);
  const fromRef = useRef<number | null>(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) {
      setDisplayed(null);
      fromRef.current = null;
      return;
    }
    const from = fromRef.current ?? target;
    if (reduced || from === target) {
      setDisplayed(target);
      fromRef.current = target;
      return;
    }
    const start = performance.now();
    const span = target - from;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic -- fast at first, settles into the real value rather
      // than a mechanical linear crawl.
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(from + span * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplayed(target);
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reduced, durationMs]);

  return displayed;
}
