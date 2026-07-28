"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { getRarityMap, tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

type HeldToken = { tokenId: string; imageUrl: string | null };
type VaultStats = {
  ethReserveWei: string;
  ethUsd: number | null;
  vaultFeeRevenueWei: string;
  marketplaceFeeRevenueEstWei: string;
};

/** Deterministic 0..1 pseudo-random from a token id, so each organism's
 * float path is stable across re-renders instead of jittering on refetch. */
function seededUnit(seed: string, salt: number): number {
  let h = salt;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * A living picture of the vault: held NFTs drift like organisms on one
 * side, real ETH liquidity and accumulating fees pulse on the other. Purely
 * decorative — every number it reads (reserves, fee totals, held tokens)
 * comes straight from /api/market/vault/stats and /api/market/vault/held,
 * the same live data VaultDashboard renders as plain numbers.
 */
export default function LivingLiquidityViz() {
  const [held, setHeld] = useState<HeldToken[] | null>(null);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/vault/held")
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .then((d) => {
        if (!cancelled) setHeld(d.tokens ?? []);
      })
      .catch(() => {
        if (!cancelled) setHeld([]);
      });
    fetch("/api/market/vault/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setStats(d);
      })
      .catch(() => {});
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const organisms = useMemo(() => {
    if (!held) return [];
    return held.slice(0, 14).map((t, i) => ({
      ...t,
      top: 8 + seededUnit(t.tokenId, 1) * 74,
      left: 6 + seededUnit(t.tokenId, 2) * 78,
      duration: 5 + seededUnit(t.tokenId, 3) * 5,
      delay: seededUnit(t.tokenId, i + 4) * -8,
      size: 34 + seededUnit(t.tokenId, 5) * 20,
    }));
  }, [held]);

  const ethUsd = stats?.ethUsd ?? 0;
  const ethReserveEth = stats ? Number(formatTokenAmount(stats.ethReserveWei, 18, 4)) : 0;
  const reserveScale = Math.min(1, Math.max(0.25, ethReserveEth / 0.1));
  const vaultFeeEth = stats ? formatTokenAmount(stats.vaultFeeRevenueWei, 18, 4) : "0";
  const marketFeeEth = stats ? formatTokenAmount(stats.marketplaceFeeRevenueEstWei, 18, 4) : "0";

  return (
    <div className="overflow-hidden rounded-lg border border-gold-500/15 bg-black/20">
      <p className="border-b border-gold-500/10 px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
        The vault, alive
      </p>
      <div className="relative grid h-56 grid-cols-2 sm:h-64">
        <div className="relative overflow-hidden border-r border-gold-500/10 bg-gradient-to-br from-wood-900/40 to-transparent">
          {organisms.map((o) => {
            const r = rarity.get(o.tokenId);
            const glow = r ? tierGlow(r.tier) : "0 0 10px rgba(212,175,90,0.25)";
            const ring = r ? tierColor(r.tier) : "rgba(212,175,90,0.4)";
            return (
              <div
                key={o.tokenId}
                className="absolute animate-organism-float rounded-full"
                style={{
                  top: `${o.top}%`,
                  left: `${o.left}%`,
                  width: o.size,
                  height: o.size,
                  animationDuration: `${o.duration}s`,
                  animationDelay: `${o.delay}s`,
                  boxShadow: glow,
                  border: `1px solid ${ring}`,
                }}
                title={`#${o.tokenId}${r ? ` · ${r.tier}` : ""}`}
              >
                {o.imageUrl ? (
                  <Image
                    src={o.imageUrl}
                    alt={`#${o.tokenId}`}
                    fill
                    sizes="60px"
                    className="rounded-full object-cover"
                    unoptimized
                  />
                ) : null}
              </div>
            );
          })}
          <span className="absolute bottom-1.5 left-2 text-[0.55rem] font-bold uppercase tracking-wide text-foreground/35">
            {held ? `${held.length} planks held` : "loading…"}
          </span>
        </div>

        <div className="relative flex flex-col items-center justify-center gap-3 overflow-hidden bg-gradient-to-bl from-gold-900/10 to-transparent px-3">
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
