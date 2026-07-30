"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { getRarityMap, tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup, RarityTier } from "@/lib/market/rarityClient";
import { TIER_ORDER } from "@/lib/rarity";
import { useVaultBook } from "@/lib/market/useVaultBook";
import {
  vaultColorKind,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import { swrJson } from "@/lib/market/swr-fetch";

type TierRow = {
  tier: RarityTier;
  count: number;
  avgPercentile: number;
};

type Props = {
  vaultAddress?: string | null;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
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
export default function RedeemOdds({ vaultAddress = null, active = true }: Props) {
  const { stats } = useVaultBook(vaultAddress, { active });
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  /** Live held list from /vault/held — more reliable than stats.heldTokenIds
   * which can be empty when the stats path times out the ID scan. */
  const [heldOverride, setHeldOverride] = useState<string[] | null>(null);
  const colorKind = vaultColorKind(vaultAddress);

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHeldOverride(null);
    const heldUrl = vaultAddress
      ? `/api/market/vault/held?vault=${encodeURIComponent(vaultAddress)}`
      : "/api/market/vault/held";
    swrJson<{ tokens?: { tokenId: string }[] }>(heldUrl, {
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
  }, [stats?.heldTokenCount, vaultAddress]);

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

  /** ETH equivalent of one random redeem (share price + redeem fee) — the
   * headline cost is denominated in shares; this is only the parenthetical. */
  const redeemCostWei = useMemo(() => {
    if (!stats?.sharePriceWei) return null;
    const base = BigInt(stats.sharePriceWei);
    const bps = BigInt(stats.redeemFeeBps);
    return base + (base * bps) / BigInt(10_000);
  }, [stats]);

  if (!stats && heldCount === 0) {
    return (
      <p className="rounded-lg border border-gold-400/20 bg-wood-950 px-3 py-4 text-center text-xs text-foreground/45">
        Loading vault odds…
      </p>
    );
  }
  if (heldCount === 0) {
    return (
      <p className="rounded-lg border border-gold-400/20 bg-wood-950 px-3 py-4 text-center text-xs text-foreground/45">
        Vault holds nothing to draw from right now.
      </p>
    );
  }
  if (rarity.size === 0) {
    return (
      <p className="rounded-lg border border-gold-400/20 bg-wood-950 px-3 py-4 text-center text-xs text-foreground/45">
        Loading rarity map for redeem odds…
      </p>
    );
  }

  const scoredHeld = heldCount - unscoredCount;

  const vaultTag = colorKind === "v1" ? "V1" : colorKind === "v2" ? "V2" : null;

  return (
    <div className="space-y-2 rounded-xl border border-gold-400/20 bg-[rgba(30,19,11,0.94)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[0.76rem] font-black uppercase tracking-[0.06em] text-foreground">
          Random redeem odds
          {vaultTag && (
            <span
              className={`rounded border px-1 py-px text-[0.55rem] font-extrabold normal-case tracking-wide ${VAULT_LABEL_CLASS[colorKind]}`}
            >
              {vaultTag}
            </span>
          )}
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
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-wood-950">
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

      <div className="space-y-0.5 border-t border-gold-400/20 pt-1.5 text-[0.6rem] text-foreground/40">
        {stats && (
          <p>
            Random cost ≈ {(1 + stats.redeemFeeBps / 10_000).toFixed(2)} shares
            {redeemCostWei != null
              ? ` (≈ ${formatTokenAmount(redeemCostWei, 18, 4)} Ξ)`
              : ""}
          </p>
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
