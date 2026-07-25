"use client";

import { useMemo, useState } from "react";
import type { GalleryNft } from "@/lib/gallery-types";
import NftImage from "@/components/NftImage";
import {
  TIER_ORDER,
  computeRaritySnapshot,
  formatRank,
  tierColor,
  type RarityTier,
  type TraitValueStat,
} from "@/lib/rarity";

type Props = {
  items: GalleryNft[];
  onSelectToken?: (tokenId: number) => void;
  compact?: boolean;
};

function StatPill({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-gold-500/25 bg-black/25 px-3 py-2.5">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300/80">
        {label}
      </p>
      <p className="mt-0.5 truncate text-lg font-black text-foreground sm:text-xl">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-foreground/55">{sub}</p>}
    </div>
  );
}

function TierBar({
  tierCounts,
  sampleSize,
}: {
  tierCounts: Record<RarityTier, number>;
  sampleSize: number;
}) {
  const max = Math.max(1, ...TIER_ORDER.map((tier) => tierCounts[tier]));
  return (
    <div className="space-y-2">
      {TIER_ORDER.map((tier) => {
        const count = tierCounts[tier];
        const pct = sampleSize ? (count / sampleSize) * 100 : 0;
        const width = (count / max) * 100;
        return (
          <div key={tier} className="grid grid-cols-[5.5rem_1fr_2.75rem] items-center gap-2 text-xs sm:grid-cols-[6.5rem_1fr_3rem] sm:text-sm">
            <span className="font-bold" style={{ color: tierColor(tier) }}>
              {tier}
            </span>
            <div className="h-2.5 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${width}%`,
                  background: `linear-gradient(90deg, ${tierColor(tier)}99, ${tierColor(tier)})`,
                }}
              />
            </div>
            <span className="text-right font-mono text-foreground/70">
              {count}
              <span className="hidden text-foreground/40 sm:inline"> · {pct.toFixed(0)}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Histogram({
  histogram,
}: {
  histogram: { label: string; count: number }[];
}) {
  const max = Math.max(1, ...histogram.map((bucket) => bucket.count));
  return (
    <div className="flex h-28 items-end gap-1 sm:h-32 sm:gap-1.5">
      {histogram.map((bucket) => {
        const height = Math.max(4, (bucket.count / max) * 100);
        return (
          <div key={bucket.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="font-mono text-[0.6rem] text-foreground/50 sm:text-[0.65rem]">
              {bucket.count || ""}
            </span>
            <div
              className="w-full rounded-t-md bg-gradient-to-t from-gold-500/40 to-gold-300/90 transition-[height] duration-500"
              style={{ height: `${height}%` }}
              title={`${bucket.label}: ${bucket.count}`}
            />
            <span className="w-full truncate text-center font-mono text-[0.55rem] text-foreground/45 sm:text-[0.6rem]">
              {bucket.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TraitChart({
  trait,
  stats,
  limit = 8,
}: {
  trait: string;
  stats: TraitValueStat[];
  limit?: number;
}) {
  const rows = stats.slice(0, limit);
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="truncate font-display text-base text-gold-300 sm:text-lg">{trait}</h4>
        <span className="shrink-0 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
          {stats.length} values
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={`${row.trait}-${row.value}`} className="min-w-0">
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[0.7rem] sm:text-xs">
              <span className="min-w-0 truncate font-bold text-foreground/85" title={row.value}>
                {row.value}
              </span>
              <span className="shrink-0 font-mono text-foreground/55">
                {row.count} · {row.pct < 1 ? row.pct.toFixed(2) : row.pct.toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full rounded-full bg-gold-500/85"
                style={{ width: `${(row.count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RarityInsights({ items, onSelectToken, compact = false }: Props) {
  const [traitFocus, setTraitFocus] = useState<string>("");

  const snapshot = useMemo(() => computeRaritySnapshot(items), [items]);
  const itemById = useMemo(() => {
    const map = new Map<number, GalleryNft>();
    for (const item of items) map.set(item.tokenId, item);
    return map;
  }, [items]);

  const focusTrait = traitFocus || snapshot.traitOrder[0] || "";
  const focusStats = focusTrait ? snapshot.traitStats.get(focusTrait) || [] : [];

  if (snapshot.sampleSize === 0) {
    return (
      <div className="rounded-xl border border-gold-500/20 bg-black/20 px-4 py-8 text-center text-sm text-foreground/60">
        Indexing revealed metadata for live rarity…
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${compact ? "" : "sm:space-y-4"}`}>
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <StatPill
          label="Scored"
          value={snapshot.scoredCount.toLocaleString()}
          sub="with full traits"
        />
        <StatPill
          label="Base art"
          value={snapshot.uniqueBases.toLocaleString()}
          sub="unique bases"
        />
        <StatPill
          label="Holo rate"
          value={`${snapshot.holoPct.toFixed(1)}%`}
          sub={`${snapshot.holoYes} holographic`}
        />
        <StatPill
          label="Rarest"
          value={
            snapshot.topRarest[0] != null
              ? `#${snapshot.topRarest[0]}`
              : "—"
          }
          sub={
            snapshot.byTokenId.get(snapshot.topRarest[0] || 0)
              ? `rank ${formatRank(1)}`
              : "live sample"
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Score distribution */}
        <div className="rounded-xl border border-gold-500/25 bg-black/20 p-3 sm:p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-display text-base text-gold-300 sm:text-lg">
              Score distribution
            </h3>
            <span className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
              common → rare
            </span>
          </div>
          <Histogram histogram={snapshot.histogram} />
        </div>

        {/* Tier mix */}
        <div className="rounded-xl border border-gold-500/25 bg-black/20 p-3 sm:p-4">
          <h3 className="mb-3 font-display text-base text-gold-300 sm:text-lg">
            Tier mix
          </h3>
          <TierBar tierCounts={snapshot.tierCounts} sampleSize={snapshot.sampleSize} />
        </div>
      </div>

      {/* Trait explorer */}
      <div className="rounded-xl border border-gold-500/25 bg-black/20 p-3 sm:p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="font-display text-base text-gold-300 sm:text-lg">
            Trait frequency
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {snapshot.traitOrder.map((trait) => (
              <button
                key={trait}
                type="button"
                onClick={() => setTraitFocus(trait)}
                className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-extrabold transition-colors ${
                  focusTrait === trait
                    ? "bg-gold-500 text-wood-950"
                    : "border border-gold-500/35 text-gold-300 hover:border-gold-400"
                }`}
              >
                {trait}
              </button>
            ))}
          </div>
        </div>
        {focusTrait && <TraitChart trait={focusTrait} stats={focusStats} limit={10} />}
      </div>

      {/* Top rarest */}
      <div className="rounded-xl border border-gold-500/25 bg-black/20 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-display text-base text-gold-300 sm:text-lg">
            Rarest right now
          </h3>
          <span className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
            live · revealed only
          </span>
        </div>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {snapshot.topRarest.slice(0, compact ? 6 : 12).map((tokenId) => {
            const nft = itemById.get(tokenId);
            const rarity = snapshot.byTokenId.get(tokenId);
            if (!nft || !rarity) return null;
            return (
              <li key={tokenId}>
                <button
                  type="button"
                  onClick={() => onSelectToken?.(tokenId)}
                  className="group flex w-full flex-col overflow-hidden rounded-lg border border-gold-500/25 bg-wood-950/60 text-left transition-transform hover:-translate-y-0.5"
                >
                  <div className="relative aspect-square w-full bg-wood-950">
                    <NftImage
                      imageUri={nft.imageUri}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <span
                      className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-[0.6rem] font-black"
                      style={{
                        background: `${tierColor(rarity.tier)}22`,
                        color: tierColor(rarity.tier),
                        border: `1px solid ${tierColor(rarity.tier)}66`,
                      }}
                    >
                      {formatRank(rarity.rank)}
                    </span>
                  </div>
                  <div className="p-1.5">
                    <p className="truncate font-mono text-[0.65rem] text-gold-300">
                      #{tokenId}
                    </p>
                    <p className="truncate text-[0.6rem] font-bold" style={{ color: tierColor(rarity.tier) }}>
                      {rarity.tier} · {rarity.normalizedScore.toFixed(0)}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="text-center text-[0.7rem] text-foreground/45">
        Rarity is statistical on currently revealed traits only — scores recompute as the gallery indexes.
      </p>
    </div>
  );
}

export { computeRaritySnapshot };
