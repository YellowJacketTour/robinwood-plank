"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { getRarityMap } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { useVaultLive } from "@/lib/market/useVaultLive";
import PlankFence from "@/components/market/PlankFence";

type HeldToken = { tokenId: string; imageUrl: string | null };

/**
 * "On The Fence" — held planks literally sitting on a fence (see
 * PlankFence — hover/drag for real stats, not decoration) next to the
 * vault's live bid/ask side: buy pressure (ETH liquidity) on the right,
 * the inventory it's backed by on the left. Every number here comes
 * straight from /api/market/vault/stats and /api/market/vault/held, the
 * same live data VaultDashboard renders as plain numbers.
 */
export default function LivingLiquidityViz() {
  const { stats } = useVaultLive();
  const [held, setHeld] = useState<HeldToken[] | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const heldTokenCount = stats?.heldTokenCount ?? null;

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  // Depending on the primitive count, not the whole `stats` object — see
  // VaultDashboard.tsx's identical fix for why: `stats` gets a new object
  // reference on every live tick even when heldTokenCount hasn't changed,
  // which was re-running this effect constantly and cancelling the
  // in-flight fetch before it ever resolved (confirmed live: held images
  // never loaded, stuck on the loading skeleton forever).
  useEffect(() => {
    if (heldTokenCount == null) return;
    let cancelled = false;
    fetch("/api/market/vault/held")
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .then((d) => {
        if (!cancelled) setHeld(d.tokens ?? []);
      })
      .catch(() => {
        if (!cancelled) setHeld([]);
      });
    return () => {
      cancelled = true;
    };
  }, [heldTokenCount]);

  const ethUsd = stats?.ethUsd ?? 0;
  const ethReserveEth = stats ? Number(formatTokenAmount(stats.ethReserveWei, 18, 4)) : 0;
  const reserveScale = Math.min(1, Math.max(0.25, ethReserveEth / 0.1));
  const vaultFeeEth = stats ? formatTokenAmount(stats.vaultFeeRevenueWei, 18, 4) : "0";
  const marketFeeEth = stats ? formatTokenAmount(stats.marketplaceFeeRevenueEstWei, 18, 4) : "0";

  return (
    <div className="overflow-hidden rounded-lg border border-gold-500/15 bg-black/20">
      <p className="border-b border-gold-500/10 px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
        On The Fence
      </p>
      <div className="relative grid grid-cols-1 sm:grid-cols-2">
        <div className="relative h-48 overflow-hidden border-b border-gold-500/10 bg-gradient-to-b from-wood-900/40 to-black/30 sm:h-64 sm:border-b-0 sm:border-r">
          <PlankFence held={held} rarity={rarity} />
          <span className="pointer-events-none absolute bottom-1.5 left-2 text-[0.55rem] font-bold uppercase tracking-wide text-foreground/35">
            {held ? `${held.length} held` : "…"}
          </span>
        </div>

        <div className="relative flex h-48 flex-col items-center justify-center gap-3 overflow-hidden bg-gradient-to-bl from-gold-900/10 to-transparent px-3 sm:h-64">
          <div
            className="animate-liquidity-pulse relative overflow-hidden rounded-full bg-gold-400/20"
            style={{
              width: 70 + reserveScale * 60,
              height: 70 + reserveScale * 60,
              boxShadow: "0 0 30px rgba(244,201,93,0.25)",
              border: "1px solid rgba(244,201,93,0.5)",
            }}
          >
            <Image
              src="/images/plank-logo.webp"
              alt=""
              fill
              sizes="130px"
              className="object-contain p-3.5 opacity-90"
              unoptimized
            />
          </div>
          <div className="text-center">
            <p className="font-display text-base text-gold-300">
              {stats ? formatTokenAmount(stats.ethReserveWei, 18, 4) : "…"} Ξ
            </p>
            <p className="text-[0.6rem] text-foreground/45">
              liquidity{ethUsd > 0 && stats ? ` · ${formatUsd(weiToUsd(stats.ethReserveWei, ethUsd))}` : ""}
            </p>
          </div>
          <div className="flex gap-2 text-center">
            <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1">
              <p className="text-[0.55rem] uppercase text-emerald-300/80">Vault fees</p>
              <p className="font-mono text-[0.65rem] text-emerald-200">{vaultFeeEth} Ξ</p>
            </div>
            <div className="rounded-md border border-sky-400/30 bg-sky-400/10 px-2 py-1">
              <p className="text-[0.55rem] uppercase text-sky-300/80">Market fees est.</p>
              <p className="font-mono text-[0.65rem] text-sky-200">{marketFeeEth} Ξ</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
