"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Polls /api/market/multichain/hydration-status for a small, bounded set of
 * `${chainSlug}:${collectionKey}` composite keys (the rankings table's
 * currently rendered page -- see GlobalMarketHub's `rankings`, capped at 100
 * by its own "Show 10/25/50/100" control) and returns which of them a real
 * plank_data_jobs row is hydrating right now.
 *
 * Deliberately separate from useVisibleCollectionDemand: that hook is a
 * write-only demand signal (IntersectionObserver-scoped, fire-and-forget).
 * This one is a small read poll against an already-rendered, already-bounded
 * key set -- no viewport tracking needed, since "currently on this page" is
 * already a small enough set to poll directly.
 */
const POLL_MS = 8_000;
const STATUS_URL = "/api/market/multichain/hydration-status";

export function useHydrationJobStatus(composites: string[], enabled = true): Record<string, boolean> {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const keysRef = useRef<string[]>(composites);
  keysRef.current = composites;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let cancelled = false;
    const poll = async () => {
      const keys = keysRef.current;
      if (keys.length === 0) return;
      const pairs = keys
        .map((composite) => {
          const idx = composite.indexOf(":");
          if (idx <= 0 || idx === composite.length - 1) return null;
          return { chainSlug: composite.slice(0, idx), collectionKey: composite.slice(idx + 1) };
        })
        .filter((p): p is { chainSlug: string; collectionKey: string } => p !== null)
        .slice(0, 100);
      if (pairs.length === 0) return;
      try {
        const res = await fetch(STATUS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairs }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { jobProcessing?: Record<string, boolean> };
        if (!cancelled) setStatus(data.jobProcessing ?? {});
      } catch {
        // Best-effort live indicator only -- a dropped poll just means the
        // chip stays in its last-known (or idle) state until the next tick.
      }
    };

    void poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  return status;
}
