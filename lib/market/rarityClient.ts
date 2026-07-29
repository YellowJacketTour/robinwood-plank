"use client";

import {
  normalizeRarityTier,
  tierAnimationClass,
  tierCardStyle,
  tierColor,
  tierGlow,
} from "@/lib/rarity";
import type { RarityTier } from "@/lib/rarity";
import { swrJson } from "@/lib/market/swr-fetch";

export type RarityLookup = {
  /** Base trait value — the collection's real plank name, not the raw
   * "RobinWood Plank #N" metadata name. Falls back to `Plank #{tokenId}`. */
  name: string;
  tier: RarityTier;
  rank: number;
  percentile: number;
};

type RarityResponse = {
  byTokenId: Record<string, { name: string; tier: RarityTier; rank: number; percentile: number }>;
};

let cached: Map<string, RarityLookup> | null = null;
let inflight: Promise<Map<string, RarityLookup>> | null = null;

/**
 * One bulk fetch shared by every component that wants a tier color — a
 * module-level cache + SWR so ListingGrid, ActivityFeed, fence, odds all
 * share one request. Empty map on failure (fail closed for tier filters).
 */
export async function getRarityMap(): Promise<Map<string, RarityLookup>> {
  if (cached) return cached;
  if (inflight) return inflight;

  // ?v=4 busts session/SWR after Mythic removed (not a real collection tier).
  inflight = swrJson<RarityResponse>("/api/market/rarity?v=4", {
    ttlMs: 120_000,
    swrMs: 30 * 60_000,
    session: true,
  })
    .then((data) => {
      const map = new Map<string, RarityLookup>();
      for (const [tokenId, v] of Object.entries(data.byTokenId ?? {})) {
        map.set(tokenId, { ...v, tier: normalizeRarityTier(v.tier) });
      }
      cached = map;
      return map;
    })
    .catch(() => new Map<string, RarityLookup>())
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export { tierColor, tierGlow, tierAnimationClass, tierCardStyle };
export type { RarityTier };
