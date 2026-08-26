"use client";

import { useEffect, useState } from "react";
import { swrJson } from "@/lib/market/swr-fetch";

export type PlankKothBuy = {
  txHash: string;
  wallet: string | null;
  ethPaidWei: string;
  plankAmount: string;
  usdValueAtBuy: number | null;
};

export type PlankKothLeaderboardRow = PlankKothBuy & { confirmedAt: string };

export type FallenChampion = PlankKothBuy & {
  becameChampionAt: string;
  dethronedAt: string;
  dethronedByTxHash: string | null;
};

export type PreSeasonRecord = PlankKothBuy & { auditedAt: string };

export type PlankKothResponse = {
  available: boolean;
  launchAt?: string;
  launched?: boolean;
  deadline?: string;
  leadingBuy?: PlankKothBuy | null;
  finalized?: boolean;
  winnerFinalizedAt?: string | null;
  winner?: PlankKothBuy | null;
  leaderboard?: PlankKothLeaderboardRow[];
  fallenChampions?: FallenChampion[];
  preSeasonRecord?: PreSeasonRecord | null;
  prize?: { supplyFraction: number; plankAmount: string | null; usdValue: number | null; plankEth: number | null };
  plankUsd?: number | null;
};

/**
 * Live poll of /api/market/plank-koth (lib/market/plank-koth.ts). 3s TTL --
 * the leader/prize's real ETH-denominated price ratio (prize.plankEth)
 * only changes when the underlying pool-price source itself refreshes, so
 * a faster poll here never invents new information -- what it DOES do is
 * shrink how long a genuine real change sits undetected before this app
 * shows it, which matters now that the prize's live USD figure is derived
 * from plankEth * a per-second ETH/USD tick (PlankKothBoard.tsx): the
 * faster this value catches a real plankEth change, the sooner both
 * figures are back in sync. Still far below hammering the route (matches
 * useLiveEthUsd.ts's own real-time feel without needing a second
 * WebSocket for a value that only meaningfully moves on real trades).
 */
export function usePlankKoth(): PlankKothResponse | null {
  const [state, setState] = useState<PlankKothResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const data = await swrJson<PlankKothResponse>("/api/market/plank-koth", {
          ttlMs: 3_000,
          swrMs: 15_000,
          session: true,
        });
        if (!cancelled) setState(data);
      } catch {
        // Keep the last good state on a transient failure -- never blank
        // a live leaderboard just because one poll dropped.
      }
      if (!cancelled) timer = window.setTimeout(poll, 3_000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  return state;
}
