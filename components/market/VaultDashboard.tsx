"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { getRarityMap, tierAnimationClass, tierCardStyle, tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

type VaultStats = {
  poolOpen: boolean;
  ethReserveWei: string;
  shareReserveWei: string;
  heldTokenCount: number;
  sharePriceWei: string | null;
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
  ethUsd: number | null;
  aprPct: number | null;
  aprBasisHours: number | null;
  depositCount: number;
  redeemCount: number;
};

type HeldToken = { tokenId: string; imageUrl: string | null };

function statCell(label: string, value: string, sub?: string) {
  return (
    <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
      <dt className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="mt-0.5 font-display text-lg text-gold-300">{value}</dd>
      {sub && <p className="mt-0.5 text-[0.6rem] text-foreground/40">{sub}</p>}
    </div>
  );
}

/**
 * Public vault dashboard — full liquidity picture at a glance: what's
 * actually held, the live rate, both fee-side costs, USD alongside ETH
 * everywhere, and a real (not fabricated) trailing APR estimate. Every
 * number here comes straight from app/api/market/vault/stats, which is
 * itself either a direct on-chain read or a replay of real Deposited/
 * Redeemed events — see lib/market/vault-stats.ts.
 */
export default function VaultDashboard() {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [held, setHeld] = useState<HeldToken[]>([]);
  const [heldLoading, setHeldLoading] = useState(true);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/vault/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    fetch("/api/market/vault/held")
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .then((data) => {
        if (!cancelled) setHeld(data.tokens ?? []);
      })
      .catch(() => {
        if (!cancelled) setHeld([]);
      })
      .finally(() => {
        if (!cancelled) setHeldLoading(false);
      });
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="py-4 text-center text-xs text-red-300">Could not read vault stats.</p>;
  }
  if (!stats) {
    return <p className="py-4 text-center text-xs text-foreground/45">Reading vault dashboard…</p>;
  }

  const ethUsd = stats.ethUsd ?? 0;
  const ethAndUsd = (wei: string, ethDecimals = 4) => {
    const eth = formatTokenAmount(wei, 18, ethDecimals);
    const usd = ethUsd > 0 ? formatUsd(weiToUsd(wei, ethUsd)) : null;
    return usd ? `${eth} Ξ · ${usd}` : `${eth} Ξ`;
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {statCell("Liquidity (ETH side)", ethAndUsd(stats.ethReserveWei))}
        {statCell(
          "Liquidity (share side)",
          `${formatTokenAmount(stats.shareReserveWei, 18, 2)} shares`,
          stats.sharePriceWei ? `≈ ${ethAndUsd(stats.sharePriceWei, 5)} / share` : undefined
        )}
        {statCell("NFTs held", String(stats.heldTokenCount))}
        {statCell(
          "Depositor APR",
          stats.aprPct != null ? `${stats.aprPct.toFixed(1)}%` : "—",
          stats.aprPct != null
            ? "est., trailing fee revenue"
            : stats.aprBasisHours != null
              ? `only ${stats.aprBasisHours.toFixed(1)}h of history yet`
              : "no activity yet"
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-gold-500/15 bg-black/10 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Mint fee</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.mintFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-500/15 bg-black/10 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Redeem fee</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.redeemFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-500/15 bg-black/10 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Redeem premium</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.targetPremiumBps / 100).toFixed(2)}%</p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Vault inventory · {stats.heldTokenCount} plank{stats.heldTokenCount === 1 ? "" : "s"}
        </p>
        {heldLoading ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-lg bg-wood-900/70" />
            ))}
          </div>
        ) : held.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
            Nothing held right now.
          </p>
        ) : (
          <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {held.map((t) => {
              const r = rarity.get(t.tokenId);
              return (
                <li
                  key={t.tokenId}
                  className={`relative aspect-square overflow-hidden rounded-lg bg-wood-900 ${
                    r ? `${tierAnimationClass(r.tier)} holo-card` : ""
                  }`}
                  style={r ? { boxShadow: tierGlow(r.tier), ...tierCardStyle(r.tier) } : undefined}
                  title={r ? `#${t.tokenId} · ${r.tier}` : `#${t.tokenId}`}
                >
                  {t.imageUrl ? (
                    <Image src={t.imageUrl} alt={`#${t.tokenId}`} fill sizes="80px" className="object-cover" unoptimized />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[0.55rem] text-foreground/30">
                      #{t.tokenId}
                    </div>
                  )}
                  <span className="card-overlay legible-text absolute inset-x-0 bottom-0 bg-black/75 px-1 py-0.5 text-center font-mono text-[0.55rem] font-bold text-gold-300">
                    #{t.tokenId}
                  </span>
                  {r && (
                    <span
                      className="tier-badge absolute right-1 top-1 rounded-full px-1 py-0.5 text-[0.5rem] font-bold uppercase"
                      style={{ color: tierColor(r.tier) }}
                    >
                      {r.tier.slice(0, 3)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
