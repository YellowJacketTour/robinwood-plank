import type { Listing } from "@/lib/market/types";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/rarity";
import { TIER_ORDER } from "@/lib/rarity";
import { rarityMapGet } from "@/lib/market/rarity-lookup";

/**
 * Pure floor / premium helpers for Buy & Sell.
 * Prices are always listing wei (relay metadata) for display chips;
 * sweeps still re-validate signed orders in planSweep.
 */

export function collectionFloorWei(
  listings: readonly Pick<Listing, "priceWei">[]
): bigint | null {
  let floor: bigint | null = null;
  for (const l of listings) {
    try {
      const p = BigInt(l.priceWei);
      if (floor === null || p < floor) floor = p;
    } catch {
      /* skip bad price */
    }
  }
  return floor;
}

export type TierFloorRow = {
  tier: RarityTier;
  /** Cheapest live listing in this tier, or null if none listed. */
  floorWei: bigint | null;
  listed: number;
  /**
   * Premium vs collection floor: positive = this tier floor is above
   * collection floor (premium), negative = discount. Null when either
   * side has no listings.
   */
  premiumBps: number | null;
};

/**
 * Floor per rarity tier among listings that have a scored tokenId.
 * Unscored tokens are excluded from tier rows (they still count toward
 * collection floor via collectionFloorWei).
 */
export function tierFloors(
  listings: readonly Pick<Listing, "tokenId" | "priceWei">[],
  rarity: Map<string, RarityLookup>
): TierFloorRow[] {
  const collFloor = collectionFloorWei(listings);
  const byTier = new Map<RarityTier, { floor: bigint | null; listed: number }>();
  for (const t of TIER_ORDER) byTier.set(t, { floor: null, listed: 0 });

  for (const l of listings) {
    if (!l.tokenId) continue;
    const r = rarityMapGet(rarity, l.tokenId);
    if (!r) continue;
    let price: bigint;
    try {
      price = BigInt(l.priceWei);
    } catch {
      continue;
    }
    const cur = byTier.get(r.tier)!;
    cur.listed += 1;
    if (cur.floor === null || price < cur.floor) cur.floor = price;
  }

  return TIER_ORDER.map((tier) => {
    const cur = byTier.get(tier)!;
    let premiumBps: number | null = null;
    if (collFloor != null && collFloor > BigInt(0) && cur.floor != null) {
      // bps = (tierFloor - collFloor) / collFloor * 10000
      premiumBps = Number(((cur.floor - collFloor) * BigInt(10_000)) / collFloor);
    }
    return {
      tier,
      floorWei: cur.floor,
      listed: cur.listed,
      premiumBps,
    };
  });
}

/** Format +12% / −5% / floor for chip sublabels. */
export function formatPremiumBps(bps: number | null): string {
  if (bps == null) return "—";
  if (bps === 0) return "floor";
  const pct = Math.abs(bps) / 100;
  const body = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
  return bps > 0 ? `+${body}%` : `−${body}%`;
}
