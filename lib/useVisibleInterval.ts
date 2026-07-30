"use client";

import { useEffect, useRef } from "react";

type VisibleIntervalOptions = {
  /**
   * Run the callback immediately when the page returns to visibility, so the
   * user never looks at data that went stale while the tab was backgrounded.
   * Defaults to true.
   */
  runOnRestore?: boolean;
};

/**
 * setInterval that pauses while the document is hidden. Backgrounded tabs
 * stop polling entirely instead of hammering the RPC/API forever; on return
 * the callback fires once immediately and the cadence resumes.
 *
 * Non-hook form so it can drop into existing effects that manage their own
 * `cancelled` flags and dependencies. Returns a cleanup function.
 */
export function startVisibleInterval(
  fn: () => void,
  intervalMs: number,
  options?: VisibleIntervalOptions
): () => void {
  const runOnRestore = options?.runOnRestore ?? true;
  let timer: number | null = null;

  const start = () => {
    if (timer === null) timer = window.setInterval(fn, intervalMs);
  };
  const stop = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (document.hidden) {
      stop();
    } else {
      if (runOnRestore) fn();
      start();
    }
  };

  if (!document.hidden) start();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    stop();
  };
}

/**
 * Hook form for simple cases: runs `callback` every `intervalMs` while the
 * page is visible and `active` is true (e.g. the owning market tab is the
 * one on screen). Passing `active: false` stops the cadence without
 * unmounting the component; flipping back to true runs the callback once
 * immediately, then resumes.
 */
export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  options?: VisibleIntervalOptions & { active?: boolean }
) {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  const active = options?.active ?? true;
  const runOnRestore = options?.runOnRestore ?? true;

  useEffect(() => {
    if (!active) return;
    return startVisibleInterval(() => callbackRef.current(), intervalMs, { runOnRestore });
  }, [active, intervalMs, runOnRestore]);
}
