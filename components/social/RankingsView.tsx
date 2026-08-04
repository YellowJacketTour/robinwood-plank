"use client";

import { useEffect, useState } from "react";
import EndorseButton from "@/components/social/EndorseButton";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";

type RankedTarget = {
  targetId: string;
  score: number;
  voteCount: number;
};

function collectionName(slug: string): string {
  return MARKET_COLLECTIONS.find((c) => c.slug === slug)?.name ?? slug;
}

/**
 * Reputation-weighted collection leaderboard — surfaces
 * app/api/social/rankings/route.ts (lib/social-endorsements.ts's
 * rankTargetsByEndorsement). Each collection can be endorsed directly from
 * this list.
 */
export default function RankingsView() {
  const [ranked, setRanked] = useState<RankedTarget[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/social/rankings?targetType=collection&limit=50")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok) throw new Error(json.message || "Failed to load rankings.");
        setRanked(json.ranked ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load rankings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-[900px] px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl text-gold-300 sm:text-3xl">Community Rankings</h1>
      <p className="mt-2 max-w-prose text-sm text-cream-muted">
        Collections ranked by reputation-weighted endorsements — each voter&apos;s vote is weighted
        by their Plank Checks history and Bad Boards standing, and diluted the more targets they
        endorse at once, so no single wallet can dominate the board.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm font-bold text-red-300">
          {error}
        </p>
      )}

      {!error && ranked === null && (
        <p className="mt-6 text-sm text-cream-muted">Loading rankings…</p>
      )}

      {ranked !== null && ranked.length === 0 && (
        <p className="mt-6 text-sm text-cream-muted">No endorsements yet — be the first to back a collection.</p>
      )}

      {ranked !== null && ranked.length > 0 && (
        <ol className="mt-6 flex flex-col gap-2">
          {ranked.map((row, i) => (
            <li
              key={row.targetId}
              className="flex items-center justify-between gap-4 rounded-lg border border-line bg-panel px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-6 shrink-0 text-right font-display text-lg text-gold-300">{i + 1}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-cream">{collectionName(row.targetId)}</p>
                  <p className="text-xs text-cream-muted">
                    score {row.score.toFixed(2)} · {row.voteCount} endorsement{row.voteCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <EndorseButton targetType="collection" targetId={row.targetId} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
