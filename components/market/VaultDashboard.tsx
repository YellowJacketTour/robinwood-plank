"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { getRarityMap, tierAnimationClass, tierCardStyle, tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { useVaultLive } from "@/lib/market/useVaultLive";
import ScrollBox from "@/components/market/ScrollBox";
import CachedNftImage from "@/components/CachedNftImage";
import { warmArtOnce } from "@/lib/art-warm-global";

type HeldToken = { tokenId: string; imageUrl: string | null };

function statCell(label: string, value: string, sub?: string) {
  return (
    <div className="rounded-lg border border-gold-500/20 bg-wood-950/90 px-3 py-2.5">
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
  const { stats } = useVaultLive();
  const [held, setHeld] = useState<HeldToken[]>([]);
  const [heldLoading, setHeldLoading] = useState(true);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const heldTokenCount = stats?.heldTokenCount ?? null;

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  // Fetch on mount + when held count changes. Don't gate the first load on
  // stats.heldTokenCount. Never paint "Nothing held" from a poisoned empty
  // cache while stats still report inventory.
  useEffect(() => {
    let cancelled = false;
    setHeldLoading(true);
    const expected = heldTokenCount; // null until stats load
    import("@/lib/market/swr-fetch")
      .then(({ swrJson }) =>
        swrJson<{ tokens?: HeldToken[]; count?: number }>("/api/market/vault/held", {
          ttlMs: 12_000,
          swrMs: 90_000,
          session: true,
          isGood: (raw) => {
            const d = raw as { tokens?: HeldToken[] };
            const n = d.tokens?.length ?? 0;
            if (n === 0) return expected === 0;
            return true;
          },
        })
      )
      .then((data) => {
        if (cancelled) return;
        const tokens = data.tokens ?? [];
        if (tokens.length > 0) {
          setHeld(tokens);
          warmArtOnce(
            tokens.map((t) => ({ tokenId: t.tokenId, imageUrl: t.imageUrl })),
            { concurrency: 4, flags: { vault: true } }
          );
          return;
        }
        if ((expected ?? 0) > 0 && stats?.heldTokenIds?.length) {
          setHeld(stats.heldTokenIds.map((tokenId) => ({ tokenId, imageUrl: null })));
          return;
        }
        if (expected === 0) setHeld([]);
      })
      .catch(() => {
        if (cancelled) return;
        if (expected === 0) setHeld([]);
        else if (stats?.heldTokenIds?.length) {
          setHeld((prev) =>
            prev.length > 0
              ? prev
              : stats.heldTokenIds!.map((tokenId) => ({ tokenId, imageUrl: null }))
          );
        }
      })
      .finally(() => {
        if (!cancelled) setHeldLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [heldTokenCount, stats?.heldTokenIds]);

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
        {statCell("ETH liquidity", ethAndUsd(stats.ethReserveWei))}
        {statCell(
          "Share liquidity",
          `${formatTokenAmount(stats.shareReserveWei, 18, 2)} shares`,
          stats.sharePriceWei ? `${ethAndUsd(stats.sharePriceWei, 5)}/share` : undefined
        )}
        {statCell("Held", String(stats.heldTokenCount))}
        {statCell(
          "APR",
          stats.aprPct != null
            ? `${stats.aprPct >= 1000 ? stats.aprPct.toFixed(0) : stats.aprPct.toFixed(1)}%`
            : "—",
          stats.aprPct != null
            ? stats.aprBasisHours != null
              ? `est. · ${stats.aprBasisHours.toFixed(1)}h fees`
              : "est. from mint/redeem fees"
            : stats.aprBasisHours != null
              ? `${stats.aprBasisHours.toFixed(1)}h history`
              : stats.depositCount > 0
                ? "computing…"
                : "no fee history"
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-gold-500/15 bg-wood-950/90 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Mint fee</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.mintFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-500/15 bg-wood-950/90 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Redeem fee</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.redeemFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-500/15 bg-wood-950/90 px-2 py-1.5">
          <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">Redeem premium</p>
          <p className="font-mono text-xs text-foreground/70">{(stats.targetPremiumBps / 100).toFixed(2)}%</p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Inventory · {stats.heldTokenCount}
        </p>
        {heldLoading ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-lg bg-wood-900/90" />
            ))}
          </div>
        ) : held.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-3 py-4 text-center text-xs text-foreground/45">
            Nothing held right now.
          </p>
        ) : (
          <ScrollBox storageKey="vault-inventory" defaultHeight={220} maxHeight={600}>
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
                  title={r ? `${r.name} · #${t.tokenId} · Rank #${r.rank} · ${r.tier}` : `#${t.tokenId}`}
                >
                  {t.imageUrl ? (
                    <CachedNftImage
                      imageUrl={t.imageUrl}
                      tokenId={t.tokenId}
                      alt={`#${t.tokenId}`}
                      fill
                      sizes="80px"
                      className="object-cover"
                      vault
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[0.55rem] text-foreground/30">
                      #{t.tokenId}
                    </div>
                  )}
                  <span className="card-overlay legible-text absolute inset-x-0 bottom-0 flex flex-col items-center bg-black/90 px-1 py-0.5 text-center leading-tight">
                    <span className="w-full truncate font-bold text-gold-300 text-[0.55rem]">
                      {r?.name ?? `#${t.tokenId}`}
                    </span>
                    <span className="w-full truncate font-mono text-[0.45rem] text-foreground/50">
                      #{t.tokenId}
                      {r ? ` · R${r.rank}` : ""}
                    </span>
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
          </ScrollBox>
        )}
      </div>
    </div>
  );
}
