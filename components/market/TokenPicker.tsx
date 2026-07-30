"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { getRarityMap, tierAnimationClass, tierCardStyle, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { withImageWidth } from "@/lib/ipfs";

export type PickerToken = {
  tokenId: string;
  imageUrl?: string;
};

type Props = {
  tokens: PickerToken[];
  /** A single id (existing single-select callers), an array (multi-select —
   * every id in it renders as selected), or null for none. */
  selected: string | string[] | null;
  onSelect: (tokenId: string) => void;
  loading?: boolean;
  emptyMessage?: string;
  /** Free-typed entry is opt-in, never the default surface — a small
   * disclosure the user has to choose to open. */
  allowManualEntry?: boolean;
};

/**
 * Tap-to-select grid of real artwork, used anywhere a flow used to make
 * someone type a raw token ID. Manual entry is available but always
 * collapsed behind an explicit toggle, never the default input.
 */
export default function TokenPicker({
  tokens,
  selected,
  onSelect,
  loading,
  emptyMessage = "No tokens found.",
  allowManualEntry = true,
}: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const selectedSet = Array.isArray(selected) ? new Set(selected) : null;

  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="aspect-square animate-pulse rounded-lg bg-wood-900/90" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {tokens.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-wood-950/90 px-3 py-6 text-center text-xs text-foreground/45">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
          {tokens.map((t) => {
            const r = rarity.get(t.tokenId);
            const isSelected = selectedSet ? selectedSet.has(t.tokenId) : selected === t.tokenId;
            return (
              <button
                key={t.tokenId}
                type="button"
                onClick={() => onSelect(t.tokenId)}
                aria-pressed={isSelected}
                aria-label={`Select #${t.tokenId}`}
                className={`group relative aspect-square overflow-hidden rounded-lg bg-wood-900 transition ${
                  r ? `${tierAnimationClass(r.tier)} holo-card` : ""
                } ${isSelected ? "ring-2 ring-gold-300" : ""}`}
                style={r && !isSelected ? { boxShadow: tierGlow(r.tier), ...tierCardStyle(r.tier) } : undefined}
              >
                {t.imageUrl ? (
                  <Image
                    src={withImageWidth(t.imageUrl, 256)}
                    alt={`#${t.tokenId}`}
                    fill
                    sizes="80px"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[0.55rem] text-foreground/30">
                    #{t.tokenId}
                  </div>
                )}
                <span className="absolute inset-x-0 bottom-0 flex flex-col items-center bg-black/90 px-1 py-0.5 text-center leading-tight">
                  <span className="w-full truncate font-bold text-gold-300 text-[0.55rem]">
                    {r?.name ?? `#${t.tokenId}`}
                  </span>
                  <span className="w-full truncate font-mono text-[0.45rem] text-foreground/50">
                    #{t.tokenId}
                    {r ? ` · R${r.rank} · ${r.tier}` : ""}
                  </span>
                </span>
                {isSelected && (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gold-400 text-[0.6rem] font-black text-wood-950">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {allowManualEntry && (
        <div>
          {manualOpen ? (
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              placeholder="Token ID"
              value={manualValue}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                setManualValue(v);
                if (v) onSelect(v);
              }}
              className="min-h-9 w-full rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 text-xs text-foreground outline-none focus:border-gold-400"
            />
          ) : (
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              className="text-[0.65rem] font-bold text-foreground/45 underline decoration-dotted hover:text-gold-300"
            >
              Enter a token ID manually instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}
