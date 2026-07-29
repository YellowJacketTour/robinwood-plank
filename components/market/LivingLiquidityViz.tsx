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
};

/**
 * "On The Fence" — held planks literally sitting on a fence (see
 * PlankFence — hover/drag for real stats, not decoration) next to the
 * vault's live bid/ask side: buy pressure (ETH liquidity) on the right,
 * the inventory it's backed by on the left. Every number here comes
 * straight from /api/market/vault/stats and /api/market/vault/held, the
 * same live data VaultDashboard renders as plain numbers.
 */
export default function LivingLiquidityViz({ vaultAddress = null }: Props) {
  const { stats } = useVaultBook(vaultAddress);
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
    <div className="overflow-hidden rounded-lg border border-gold-500/15 bg-wood-950/90">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gold-500/10 px-3 py-1.5">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          On The Fence
        </p>
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
