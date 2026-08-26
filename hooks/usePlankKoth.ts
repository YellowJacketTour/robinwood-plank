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
 * Live poll of /api/market/plank-koth (lib/market/plank-koth.ts). 8s TTL --
 * fast enough that the leaderboard/leader feel genuinely live without
 * hammering the route (matches useHydrationJobStatus's own 8s cadence
 * elsewhere in this app for the same "feels live" bar).
 */
export function usePlankKoth(): PlankKothResponse | null {
  const [state, setState] = useState<PlankKothResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const data = await swrJson<PlankKothResponse>("/api/market/plank-koth", {
          ttlMs: 8_000,
          swrMs: 30_000,
          session: true,
        });
        if (!cancelled) setState(data);
      } catch {
        // Keep the last good state on a transient failure -- never blank
        // a live leaderboard just because one poll dropped.
      }
      if (!cancelled) timer = window.setTimeout(poll, 8_000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  return state;
}
