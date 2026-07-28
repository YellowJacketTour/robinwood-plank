"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { getRarityMap, tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup, RarityTier } from "@/lib/market/rarityClient";
import { useVaultLive } from "@/lib/market/useVaultLive";
import type { Listing } from "@/lib/market/types";

type Props = {
  listings: Listing[];
};

const TIER_ORDER: RarityTier[] = ["Mythic", "Legendary", "Epic", "Rare", "Uncommon", "Common"];

type TierRow = {
  tier: RarityTier;
  count: number;
  avgPercentile: number;
  floorWei: bigint | null;
};

/**
 * A random redeem draws uniformly from the vault's held pool
 * (heldTokenIds[keccak(seed, requester) % frozenLen] — see
 * contracts/MarketplankVault.sol's claimRandomRedeem), so each currently
 * held token has an exactly equal 1/heldCount chance, and each tier's odds
 * are simply its share of the held pool. That's the one honest probability
 * claim this makes — it does not model draw timing, in-flight pending
 * redemptions, or future deposits changing the pool.
 *
 * Tier floors come from currently active marketplace listings (the same
 * `listings` CollectionStats already uses for the collection-wide floor),
 * grouped by rarity tier — so "is redeeming cheaper than buying this tier
 * on the open market" is a real comparison, not a guess, though a tier with
 * zero active listings has no floor to compare against and says so.
 */
export default function RedeemOdds({ listings }: Props) {
  const { stats } = useVaultLive();
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  const heldTokenIds = stats?.heldTokenIds ?? [];
  const heldCount = heldTokenIds.length;

  const rows = useMemo<TierRow[]>(() => {
    if (rarity.size === 0 || heldCount === 0) return [];

    const byTier = new Map<RarityTier, { count: number; percentileSum: number }>();
    for (const id of heldTokenIds) {
      const r = rarity.get(id);
      if (!r) continue;
      const cur = byTier.get(r.tier) ?? { count: 0, percentileSum: 0 };
      cur.count += 1;
      cur.percentileSum += r.percentile;
      byTier.set(r.tier, cur);
    }

    const floorByTier = new Map<RarityTier, bigint>();
    for (const l of listings) {
      const r = rarity.get(l.tokenId);
      if (!r) continue;
      const price = BigInt(l.priceWei);
      const cur = floorByTier.get(r.tier);
      if (cur === undefined || price < cur) floorByTier.set(r.tier, price);
    }

    return TIER_ORDER.filter((t) => byTier.has(t)).map((tier) => {
      const agg = byTier.get(tier)!;
      return {
        tier,
        count: agg.count,
        avgPercentile: agg.percentileSum / agg.count,
        floorWei: floorByTier.get(tier) ?? null,
      };
    });
  }, [rarity, heldTokenIds, heldCount, listings]);

  const redeemCostWei = useMemo(() => {
    if (!stats?.sharePriceWei) return null;
    const base = BigInt(stats.sharePriceWei);
    const bps = BigInt(stats.redeemFeeBps + stats.targetPremiumBps);
    return base + (base * bps) / BigInt(10_000);
  }, [stats]);

  if (!stats || heldCount === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
        Vault holds nothing to draw from right now.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-gold-500/15 bg-black/20 p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Random redeem odds
        </p>
        <p className="text-[0.6rem] text-foreground/40">1 of {heldCount} held, drawn uniformly</p>
      </div>

      {rows.length === 0 ? (
        <p className="py-2 text-center text-[0.65rem] text-foreground/40">Loading rarity…</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = (row.count / heldCount) * 100;
            const color = tierColor(row.tier);
            const delta =
              row.floorWei != null && redeemCostWei != null && redeemCostWei > BigInt(0)
                ? (Number(row.floorWei - redeemCostWei) / Number(redeemCostWei)) * 100
                : null;
            return (
              <div key={row.tier} className="space-y-0.5">
                <div className="flex items-center justify-between text-[0.65rem]">
                  <span className="flex items-center gap-1.5 font-bold" style={{ color }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                    {row.tier}
                    <span className="font-normal text-foreground/40">
                      · {row.count}/{heldCount}
                    </span>
                  </span>
                  <span className="font-mono text-foreground/70">{pct.toFixed(1)}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-wood-900/80">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                </div>
                <p className="text-[0.58rem] text-foreground/40">
                  avg beats {row.avgPercentile.toFixed(0)}% of collection
                  {row.floorWei != null ? (
                    <>
                      {" · floor "}
                      {formatTokenAmount(row.floorWei, 18, 4)} Ξ
                      {delta != null && (
                        <span className={delta >= 0 ? "text-emerald-300" : "text-red-300"}>
                          {" "}
                          (redeem {delta >= 0 ? "cheaper" : "pricier"} by {Math.abs(delta).toFixed(0)}%)
                        </span>
                      )}
                    </>
                  ) : (
                    " · no active listings to compare"
                  )}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {redeemCostWei != null && (
        <p className="border-t border-gold-500/10 pt-1.5 text-[0.6rem] text-foreground/40">
          Effective redeem cost ≈ {formatTokenAmount(redeemCostWei, 18, 4)} Ξ (share price + redeem fee +
          premium)
        </p>
      )}
    </div>
  );
}
