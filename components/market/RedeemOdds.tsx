"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { getRarityMap, tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup, RarityTier } from "@/lib/market/rarityClient";
import { TIER_ORDER } from "@/lib/rarity";
import { useVaultLive } from "@/lib/market/useVaultLive";
import { swrJson } from "@/lib/market/swr-fetch";

type TierRow = {
  tier: RarityTier;
  count: number;
  avgPercentile: number;
};

/**
 * A random redeem draws uniformly from the vault's held pool
 * (heldTokenIds[keccak(seed, requester) % frozenLen] — see
 * contracts/MarketplankVault.sol's claimRandomRedeem), so each currently
 * held token has an exactly equal 1/heldCount chance, and each tier's odds
 * are simply its share of the held pool.
 *
 * Marketplace listing floors do NOT belong here — redeem odds are about
 * what the vault might draw, not open-market prices.
 */
export default function RedeemOdds() {
  const { stats } = useVaultLive();
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  /** Live held list from /vault/held — more reliable than stats.heldTokenIds
   * which can be empty when the stats path times out the ID scan. */
  const [heldOverride, setHeldOverride] = useState<string[] | null>(null);

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  useEffect(() => {
    let cancelled = false;
    swrJson<{ tokens?: { tokenId: string }[] }>("/api/market/vault/held", {
      ttlMs: 15_000,
      swrMs: 120_000,
      session: true,
    })
      .then((data) => {
        if (cancelled || !data?.tokens?.length) return;
        setHeldOverride(data.tokens.map((t) => t.tokenId));
      })
      .catch(() => {
        /* keep stats-based ids */
      });
    return () => {
      cancelled = true;
    };
  }, [stats?.heldTokenCount]);

  const heldTokenIds =
    heldOverride && heldOverride.length > 0
      ? heldOverride
      : stats?.heldTokenIds && stats.heldTokenIds.length > 0
        ? stats.heldTokenIds
        : [];
  const heldCount = heldTokenIds.length > 0 ? heldTokenIds.length : stats?.heldTokenCount ?? 0;

  const { rows, unscoredCount } = useMemo(() => {
    if (rarity.size === 0 || heldCount === 0) {
      return { rows: [] as TierRow[], unscoredCount: 0 };
    }

    const byTier = new Map<RarityTier, { count: number; percentileSum: number }>();
    let unscored = 0;
    for (const id of heldTokenIds) {
      const r = rarity.get(id) ?? rarity.get(String(Number(id)));
      if (!r) {
        unscored += 1;
        continue;
      }
      const cur = byTier.get(r.tier) ?? { count: 0, percentileSum: 0 };
      cur.count += 1;
      cur.percentileSum += r.percentile;
      byTier.set(r.tier, cur);
    }

    // Always show every collection tier (Legendary → Common) so 0% draws
    // still read as real probability slots, not missing UI.
    const nextRows = TIER_ORDER.map((tier) => {
      const agg = byTier.get(tier);
      return {
        tier,
        count: agg?.count ?? 0,
        avgPercentile: agg && agg.count > 0 ? agg.percentileSum / agg.count : 0,
      };
    });
    return { rows: nextRows, unscoredCount: unscored };
  }, [rarity, heldTokenIds, heldCount]);

  const redeemCostWei = useMemo(() => {
    if (!stats?.sharePriceWei) return null;
    const base = BigInt(stats.sharePriceWei);
    const bps = BigInt(stats.redeemFeeBps + stats.targetPremiumBps);
    return base + (base * bps) / BigInt(10_000);
  }, [stats]);

  if (!stats && heldCount === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
        Loading vault odds…
      </p>
    );
  }
  if (heldCount === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
        Vault holds nothing to draw from right now.
      </p>
    );
  }
  if (rarity.size === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
        Loading rarity map for redeem odds…
      </p>
    );
  }

  const scoredHeld = heldCount - unscoredCount;

  return (
    <div className="space-y-2 rounded-lg border border-gold-500/15 bg-black/20 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Random redeem odds
        </p>
        <p className="text-[0.6rem] text-foreground/40">
          1 of {heldCount} held · uniform draw
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="py-2 text-center text-[0.65rem] text-foreground/40">Loading rarity…</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            // Denominator is full held pool (honest redeem odds), not only scored.
            const pct = heldCount > 0 ? (row.count / heldCount) * 100 : 0;
            const color = tierColor(row.tier);
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
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{ width: `${Math.max(pct > 0 ? pct : 0, 0)}%`, background: color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-0.5 border-t border-gold-500/10 pt-1.5 text-[0.6rem] text-foreground/40">
        {redeemCostWei != null && (
          <p>Redeem cost ≈ {formatTokenAmount(redeemCostWei, 18, 4)} Ξ</p>
        )}
        {unscoredCount > 0 && (
          <p>
            {unscoredCount} held not yet rarity-scored
            {scoredHeld > 0 ? ` · ${scoredHeld} scored` : ""} — odds for those will fill in as the map updates
          </p>
        )}
      </div>
    </div>
  );
}
