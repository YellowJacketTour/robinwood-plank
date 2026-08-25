"use client";

import { useEffect, useRef, useState } from "react";

export type TickDirection = "up" | "down" | "flat";

/**
 * Real, honest "did this number just go up or down" signal for the Season 2
 * $PLANK KOTH dashboard's live price coloring ("green up red down coded with
 * white and black when flat"). Never fabricates motion: `flat` is the
 * genuine starting/no-change state, `up`/`down` only fire on an ACTUAL
 * change between two real fetched/pushed values, and each direction is held
 * for `holdMs` so a single instant tick is visually perceivable before
 * fading back to flat -- a coloring scheme that changes for one animation
 * frame and reverts is functionally invisible to a real user.
 */
export function useTickDirection(value: number | null, holdMs = 1_800): TickDirection {
  const [direction, setDirection] = useState<TickDirection>("flat");
  const prevRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    const prev = prevRef.current;
    prevRef.current = value;
    if (prev == null || value === prev) return;

    setDirection(value > prev ? "up" : "down");
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setDirection("flat"), holdMs);
  }, [value, holdMs]);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return direction;
}
