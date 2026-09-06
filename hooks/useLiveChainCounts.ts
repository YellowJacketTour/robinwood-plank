"use client";

import { useEffect, useRef, useState } from "react";

export type LiveChainCounts = {
  counts: Record<string, number>;
  total: number;
  asOf: string | null;
  /** Per-chain increase since the previous poll (only positive deltas; cleared after ~4 s). */
  deltas: Record<string, number>;
};

/**
 * Polls /api/market/multichain/chain-counts every `intervalMs` (default 15 s) so
 * the chain tabs move while a visitor is on the page, and reports the
 * per-chain increase so the UI can pulse it. Pauses when the tab is hidden.
 */
export function useLiveChainCounts(intervalMs = 15_000, enabled = true): LiveChainCounts {
  const [state, setState] = useState<LiveChainCounts>({ counts: {}, total: 0, asOf: null, deltas: {} });
  const prev = useRef<Record<string, number> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/market/multichain/chain-counts", { cache: "no-store", priority: "low" } as RequestInit);
        if (!res.ok) return;
        const data = (await res.json()) as { counts?: Record<string, number>; total?: number; asOf?: string };
        if (stopped || !data.counts) return;
        const deltas: Record<string, number> = {};
        if (prev.current) {
          for (const [chain, n] of Object.entries(data.counts)) {
            const d = n - (prev.current[chain] ?? n);
            if (d > 0) deltas[chain] = d;
          }
        }
        prev.current = data.counts;
        setState({ counts: data.counts, total: data.total ?? 0, asOf: data.asOf ?? null, deltas });
        if (Object.keys(deltas).length > 0) {
          if (clearTimer.current) clearTimeout(clearTimer.current);
          clearTimer.current = setTimeout(() => setState((s) => ({ ...s, deltas: {} })), 4_000);
        }
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(id);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [intervalMs, enabled]);

  return state;
}
