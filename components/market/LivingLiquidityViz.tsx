"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { getRarityMap } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { useVaultBook } from "@/lib/market/useVaultBook";
import {
  shortVault,
  vaultColorKind,
  VAULT_LABEL_CLASS,
  VAULT_TEXT_CLASS,
} from "@/lib/market/vault-registry";
import { swrJson } from "@/lib/market/swr-fetch";
import PlankFence from "@/components/market/PlankFence";
import { warmArtOnce } from "@/lib/art-warm-global";

type HeldToken = { tokenId: string; imageUrl: string | null };

type Props = {
  /** Selected Instant Swap vault — fence + liquidity follow this book. */
  vaultAddress?: string | null;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
};

/**
 * "On The Fence" — held planks literally sitting on a fence (see
 * PlankFence — hover/drag for real stats, not decoration) next to the
 * vault's live bid/ask side: buy pressure (ETH liquidity) on the right,
 * the inventory it's backed by on the left. Every number here comes
 * straight from /api/market/vault/stats and /api/market/vault/held, the
 * same live data VaultDashboard renders as plain numbers.
 */
export default function LivingLiquidityViz({ vaultAddress = null, active = true }: Props) {
  const { stats } = useVaultBook(vaultAddress, { active });
  const [held, setHeld] = useState<HeldToken[] | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const heldTokenCount = stats?.heldTokenCount ?? null;
  const colorKind = vaultColorKind(vaultAddress);

  useEffect(() => {
    void getRarityMap().then((map) => setRarity(map));
  }, []);

  // Fetch held art on mount, then again when membership count changes.
  // Do NOT gate the first fetch on stats.heldTokenCount — when SSE/stats
  // lag, the fence sat on pulse placeholders forever even though
  // /vault/held was healthy. Also: never accept/cache an empty token list
  // while stats still report holdings (poisoned SWR/CDN empties).
  useEffect(() => {
    let cancelled = false;
    const expected = heldTokenCount; // null until stats load
    setHeld(null);
    const heldUrl = vaultAddress
      ? `/api/market/vault/held?vault=${encodeURIComponent(vaultAddress)}`
      : "/api/market/vault/held";
    swrJson<{ tokens?: HeldToken[]; count?: number }>(heldUrl, {
      ttlMs: 12_000,
      swrMs: 90_000,
      session: true,
      isGood: (raw) => {
        const d = raw as { tokens?: HeldToken[]; count?: number };
        const n = d.tokens?.length ?? 0;
        // Empty is only "good" when we positively know the vault is empty.
        // Before stats load (expected null), never cache an empty blip.
        if (n === 0) return expected === 0;
        return true;
      },
    })
      .then((d) => {
        if (cancelled) return;
        const tokens = d.tokens ?? [];
        if (tokens.length > 0) {
          setHeld(tokens);
          // Single page-level warmer (deduped with VaultDashboard).
          warmArtOnce(
            tokens.map((t) => ({ tokenId: t.tokenId, imageUrl: t.imageUrl })),
            { concurrency: 4, flags: { vault: true } }
          );
          return;
        }
        // Stats say held but art payload empty — paint IDs from stats so the
        // fence never lies "nothing held", then client backfill fills art.
        if ((expected ?? 0) > 0 && stats?.heldTokenIds?.length) {
          setHeld(stats.heldTokenIds.map((tokenId) => ({ tokenId, imageUrl: null })));
          return;
        }
        if (expected === 0) setHeld([]);
        // expected null + empty: leave loading skeleton (held stays null)
      })
      .catch(() => {
        if (cancelled) return;
        // Keep prior boards on error; only show empty if vault is truly empty.
        if (expected === 0) setHeld([]);
        else if (stats?.heldTokenIds?.length) {
          setHeld((prev) =>
            prev && prev.length > 0
              ? prev
              : stats.heldTokenIds!.map((tokenId) => ({ tokenId, imageUrl: null }))
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [heldTokenCount, stats?.heldTokenIds, vaultAddress]);

  const ethUsd = stats?.ethUsd ?? 0;
  const ethReserveEth = stats ? Number(formatTokenAmount(stats.ethReserveWei, 18, 4)) : 0;
  const reserveScale = Math.min(1, Math.max(0.25, ethReserveEth / 0.1));
  const vaultFeeEth = stats ? formatTokenAmount(stats.vaultFeeRevenueWei, 18, 4) : "0";
  const marketFeeEth = stats ? formatTokenAmount(stats.marketplaceFeeRevenueEstWei, 18, 4) : "0";

  const vaultTag = colorKind === "v1" ? "V1" : colorKind === "v2" ? "V2" : null;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div>
          <p className="text-[0.58rem] font-black uppercase tracking-[0.14em] text-gold-400">
            Living liquidity
          </p>
          <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-foreground">
            On The Fence
          </p>
        </div>
        {vaultTag && (
          <span className="flex items-center gap-1.5">
            <span
              className={`rounded border px-1.5 py-0.5 text-[0.6rem] font-extrabold uppercase tracking-wide ${VAULT_LABEL_CLASS[colorKind]}`}
            >
              {vaultTag}
            </span>
            {vaultAddress && (
              <span className={`font-mono text-[0.55rem] ${VAULT_TEXT_CLASS[colorKind]}`}>
                {shortVault(vaultAddress)}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="p-3">
        {/* Finalized mockup .liquidity-visual: one centered radial-rings
            scene with the fence caption — not a thumbnail carousel. Held
            planks are drawn ON the fence line inside the rings, so the
            lore (and the held art) survives inside the approved shape. */}
        <div
          className="liquidity-visual relative grid min-h-[260px] place-items-center overflow-hidden rounded-xl"
          style={{
            background:
              "radial-gradient(circle at center, rgba(219,165,63,0.22), transparent 52%)," +
              "repeating-radial-gradient(circle at center, rgba(239,196,99,0.13) 0 1px, transparent 1px 34px)," +
              "#1b120a",
          }}
        >
          <div className="pointer-events-none z-10 flex flex-col items-center gap-1.5 text-center">
            <div
              className="animate-liquidity-pulse relative overflow-hidden rounded-full bg-gold-400/20"
              style={{
                width: 64 + reserveScale * 40,
                height: 64 + reserveScale * 40,
                border: "1px solid rgba(239,196,99,0.3)",
              }}
            >
              <Image
                src="/images/plank-logo.webp"
                alt=""
                fill
                sizes="104px"
                className="object-contain p-3 opacity-90"
                unoptimized
              />
            </div>
            <p className="font-display text-base text-gold-300">
              {held ? `${held.length} Planks in the fence` : "…"}
            </p>
            <p className="text-[0.62rem] text-foreground/50">
              {stats
                ? `${formatTokenAmount(stats.shareReserveWei, 18, 2)} shares · ${formatTokenAmount(stats.ethReserveWei, 18, 4)} Ξ${
                    ethUsd > 0 ? ` · ≈ ${formatUsd(weiToUsd(stats.ethReserveWei, ethUsd))}` : ""
                  }`
                : "reading vault…"}
            </p>
          </div>
          {/* The fence itself — held planks along the bottom of the scene. */}
          <div className="absolute inset-x-0 bottom-0 h-16">
            <PlankFence held={held} rarity={rarity} />
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Vault fee revenue</p>
            <p className="mt-0.5 text-xs font-bold text-foreground">{vaultFeeEth} Ξ</p>
          </div>
          <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Est. market fees</p>
            <p className="mt-0.5 text-xs font-bold text-foreground">{marketFeeEth} Ξ</p>
          </div>
          <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Vault</p>
            <p className="mt-0.5 truncate text-xs font-bold text-foreground">
              {vaultAddress ? (
                <a
                  href={`https://robinhoodchain.blockscout.com/address/${vaultAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-gold-300"
                  title={vaultAddress}
                >
                  {shortVault(vaultAddress)} ↗
                </a>
              ) : (
                "—"
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
