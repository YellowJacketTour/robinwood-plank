"use client";

import { tierColor } from "@/lib/rarity";
import type { RarityTier } from "@/lib/rarity";

export type RarityLookup = {
  tier: RarityTier;
  rank: number;
  percentile: number;
};

type RarityResponse = {
  byTokenId: Record<string, { tier: RarityTier; rank: number; percentile: number }>;
};

let inflight: Promise<Map<string, RarityLookup>> | null = null;
let cached: Map<string, RarityLookup> | null = null;

/**
 * One bulk fetch shared by every component that wants a tier color — a
 * module-level cache, not a hook, so ListingGrid, ActivityFeed, MyInventory
 * and ItemDetail all read the SAME map instead of each firing their own
 * request. Returns an empty map on failure — callers render without a tier
 * badge rather than blocking on rarity.
 */
export async function getRarityMap(): Promise<Map<string, RarityLookup>> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = fetch("/api/market/rarity")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
    .then((data: RarityResponse) => {
      const map = new Map<string, RarityLookup>();
      for (const [tokenId, v] of Object.entries(data.byTokenId ?? {})) {
        map.set(tokenId, v);
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

export { tierColor };
export type { RarityTier };
