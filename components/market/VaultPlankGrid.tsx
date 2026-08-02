"use client";

/**
 * The V3 swap page's hero: a big, artwork-forward grid of planks — the vault's
 * held planks (to redeem) or the wallet's own planks (to deposit), driven by the
 * trade widget's active action. Lifts the marketplace card look (MyNfts /
 * ListingGrid): real NFT art, rarity badge, an Info button to full detail, and a
 * tap-to-select ring when the current action is selectable. Falls back to the
 * collection logo when a plank has no resolved image (e.g. the local mock).
 */

import Image from "next/image";
import { useEffect, useState } from "react";
import { Check, Info } from "lucide-react";
import { getRarityMap, tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { withImageWidth } from "@/lib/ipfs";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import type { PickerToken } from "@/components/market/TokenPicker";
import ItemDetail from "@/components/market/ItemDetail";

const COLLECTION = MARKET_COLLECTIONS[0]; // RobinWood — the only vault collection

export default function VaultPlankGrid({
  tokens,
  selected,
  selectable,
  onToggle,
  loading,
  headerLabel,
  emptyMessage = "No planks here yet.",
}: {
  tokens: PickerToken[];
  selected: Set<string>;
  selectable: boolean;
  onToggle: (tokenId: string) => void;
  loading?: boolean;
  headerLabel: string;
  emptyMessage?: string;
}) {
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((m) => {
      if (!cancelled) setRarity(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-cream">{headerLabel}</h3>
        <span className="text-[0.72rem] tabular-nums text-cream-muted">· {tokens.length} plank{tokens.length === 1 ? "" : "s"}</span>
        {selectable && selected.size > 0 && (
          <span className="ml-auto rounded-full bg-gold-500/15 px-2.5 py-0.5 text-[0.7rem] font-black tabular-nums text-gold-300">
            {selected.size} selected
          </span>
        )}
      </div>

      {loading && tokens.length === 0 ? (
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="aspect-square animate-pulse rounded-lg bg-wood-950" />
          ))}
        </ul>
      ) : tokens.length === 0 ? (
        <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-sm text-cream-muted">
          {emptyMessage}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {tokens.map((t) => {
            const isSelected = selected.has(t.tokenId);
            const r = rarity.get(t.tokenId);
            return (
              <li
                key={t.tokenId}
                className={`dense-card relative flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong ${
                  isSelected ? "ring-2 ring-gold-400" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDetailId(t.tokenId); }}
                  aria-label={`View details for #${t.tokenId}`}
                  className="absolute bottom-1.5 right-1.5 z-[3] flex h-6 w-6 items-center justify-center rounded-full bg-black/90 text-gold-300 transition hover:bg-black hover:text-gold-200"
                >
                  <Info size={13} strokeWidth={2.5} />
                </button>
                <button
                  type="button"
                  disabled={!selectable}
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Deselect" : "Select"} #${t.tokenId}`}
                  onClick={() => selectable && onToggle(t.tokenId)}
                  className={`relative block aspect-square w-full bg-wood-900 outline-none transition ${
                    selectable ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-gold-400/60" : "cursor-default"
                  }`}
                >
                  <Image
                    src={withImageWidth(t.imageUrl ?? "", 256) || COLLECTION.image}
                    alt={`${COLLECTION.name} #${t.tokenId}`}
                    fill
                    sizes="(min-width: 1024px) 16vw, 50vw"
                    className="object-cover"
                    unoptimized={Boolean(t.imageUrl)}
                  />
                  {selectable && isSelected && (
                    <span className="card-overlay absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold-500 text-wood-950">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  )}
                  {r && (
                    <span
                      className="tier-badge absolute left-2 top-2 rounded-full px-2 py-1 text-[0.55rem] font-black uppercase tracking-wide"
                      style={{ color: tierColor(r.tier) }}
                      title={`Rank #${r.rank} · ${r.percentile.toFixed(0)}th percentile`}
                    >
                      {r.tier}
                    </span>
                  )}
                </button>
                <div className="flex flex-1 flex-col gap-0.5 p-2.5 leading-tight sm:p-3">
                  <span className="truncate text-[0.72rem] font-bold text-foreground">{r?.name ?? `Plank #${t.tokenId}`}</span>
                  <span className="truncate text-[0.6rem] tabular-nums text-cream-muted">#{t.tokenId}{r ? ` · Rank ${r.rank}` : ""}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {detailId && (
        <ItemDetail tokenId={detailId} collection={COLLECTION} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
