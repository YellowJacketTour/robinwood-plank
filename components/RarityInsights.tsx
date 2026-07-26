"use client";

/**
 * Collection Insights — clean, art-first analytics.
 * Pulls revealed tokens + images from the shared nft-cache (same as Gallery),
 * then layers live Gallery items on top. Does not perform chain writes or mint.
 */

import { useEffect, useMemo, useState } from "react";
import type { GalleryNft } from "@/lib/gallery-types";
import NftImage from "@/components/NftImage";
import {
  TIER_ORDER,
  computeRaritySnapshot,
  formatRank,
  rarityMethodBlurb,
  tierColor,
  type RarityTier,
} from "@/lib/rarity";
import {
  ensureNftCacheHydrated,
  getCachedToken,
  listCachedScoredTokens,
} from "@/lib/nft-cache";
import {
  MEME_FAMILY_COLOR,
  MEME_FAMILY_ORDER,
  applyFilters,
  countBy,
  diversityStats,
  emptyFilters,
  enrichTokens,
  filtersActive,
  gradedSplit,
  holoLift,
  scoreByDimension,
  type FilterState,
  type MemeFamily,
  type Slice,
} from "@/lib/collection-analytics";

type Props = {
  items: GalleryNft[];
  onSelectToken?: (tokenId: number) => void;
  onFilteredIdsChange?: (ids: number[] | null) => void;
  compact?: boolean;
};

type View = "discover" | "art" | "traits";

/** Merge Gallery state with localStorage/memory cache so Insights always has art when cached. */
function mergeWithArtCache(items: GalleryNft[]): GalleryNft[] {
  ensureNftCacheHydrated();
  const byId = new Map<number, GalleryNft>();

  for (const item of items) {
    const cached = getCachedToken(item.tokenId);
    byId.set(item.tokenId, {
      ...item,
      imageUri: item.imageUri || cached?.imageUri || "",
      attributes:
        item.attributes?.length > 0
          ? item.attributes
          : cached?.attributes || [],
      name: item.name || cached?.name || `RobinWood Plank #${item.tokenId}`,
      tokenUri: item.tokenUri || cached?.tokenUri || "",
      owner: item.owner || cached?.owner || "",
      loaded:
        item.loaded ||
        Boolean(cached?.imageUri || (cached?.attributes?.length ?? 0) > 0),
    });
  }

  // Tokens scored in cache but not yet in Gallery React state
  for (const scored of listCachedScoredTokens()) {
    if (byId.has(scored.tokenId)) continue;
    const cached = getCachedToken(scored.tokenId);
    if (!cached) continue;
    byId.set(scored.tokenId, {
      tokenId: scored.tokenId,
      tokenUri: cached.tokenUri || "",
      name: cached.name || `RobinWood Plank #${scored.tokenId}`,
      description: cached.description || "",
      imageUri: cached.imageUri || "",
      attributes: cached.attributes?.length
        ? cached.attributes
        : scored.attributes,
      owner: cached.owner || "",
      searchText: "",
      searchWords: [],
      loaded: true,
    });
  }

  return Array.from(byId.values());
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-gold-500/25 bg-black/30 px-3 py-2.5">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300/80">
        {label}
      </p>
      <p className="mt-0.5 truncate text-xl font-black text-foreground">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-foreground/50">{hint}</p>}
    </div>
  );
}

function HBars({
  slices,
  max = 8,
  onPick,
}: {
  slices: Slice[];
  max?: number;
  onPick?: (key: string) => void;
}) {
  const rows = slices.slice(0, max);
  const peak = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(row.key)}
          className="block w-full min-w-0 text-left disabled:cursor-default"
        >
          <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-bold text-foreground/90" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 font-mono text-foreground/50">
              {row.count} · {row.pct < 1 ? row.pct.toFixed(2) : row.pct.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(row.count / peak) * 100}%`,
                background: `linear-gradient(90deg, ${row.color}88, ${row.color})`,
              }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}

function Thumb({
  tokenId,
  imageUri,
  name,
  badge,
  badgeColor,
  onClick,
}: {
  tokenId: number;
  imageUri: string;
  name: string;
  badge?: string;
  badgeColor?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-gold-500/25 bg-wood-950/70 text-left transition-transform hover:-translate-y-0.5"
    >
      <div className="relative aspect-square w-full bg-wood-950">
        <NftImage
          imageUri={imageUri}
          alt={name}
          className="h-full w-full object-cover"
        />
        {badge && (
          <span
            className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-[0.6rem] font-black"
            style={{
              color: badgeColor || "#f8d98a",
              background: "rgba(0,0,0,0.75)",
              border: `1px solid ${(badgeColor || "#f8d98a")}55`,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div className="space-y-0.5 p-1.5">
        <p className="font-mono text-[0.65rem] font-bold text-gold-300">#{tokenId}</p>
        <p className="line-clamp-1 text-[0.65rem] font-bold text-foreground/80">{name}</p>
      </div>
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-8 rounded-full px-2.5 py-1 text-[0.7rem] font-extrabold"
      style={
        active
          ? {
              background: color || "#d9a441",
              color: "#1a0b03",
            }
          : {
              border: `1px solid ${color ? `${color}66` : "rgba(217,164,65,0.4)"}`,
              color: color || "#f8d98a",
              background: "transparent",
            }
      }
    >
      {children}
    </button>
  );
}

function toggleSet<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function RarityInsights({
  items,
  onSelectToken,
  onFilteredIdsChange,
}: Props) {
  const [view, setView] = useState<View>("discover");
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Art-complete universe: Gallery items + anything already in local cache
  const universe = useMemo(() => mergeWithArtCache(items), [items]);
  const snapshot = useMemo(() => computeRaritySnapshot(universe), [universe]);
  const enriched = useMemo(() => enrichTokens(universe, snapshot), [universe, snapshot]);
  const filtered = useMemo(() => applyFilters(enriched, filters), [enriched, filters]);
  const active = filtersActive(filters);

  const byId = useMemo(() => {
    const m = new Map<number, GalleryNft>();
    for (const i of universe) m.set(i.tokenId, i);
    return m;
  }, [universe]);

  useEffect(() => {
    if (!onFilteredIdsChange) return;
    if (!active) onFilteredIdsChange(null);
    else onFilteredIdsChange(filtered.map((t) => t.tokenId));
  }, [active, filtered, onFilteredIdsChange]);

  const bgSlices = useMemo(
    () => countBy(filtered, (t) => t.traits.Background),
    [filtered],
  );
  const baseSlices = useMemo(
    () => countBy(filtered, (t) => t.traits.Base),
    [filtered],
  );
  const familySlices = useMemo(() => {
    const raw = countBy(filtered, (t) => t.family);
    return raw.map((s) => ({
      ...s,
      color: MEME_FAMILY_COLOR[s.key as MemeFamily] || s.color,
    }));
  }, [filtered]);
  const holoSlices = useMemo(
    () => countBy(filtered, (t) => t.traits.Holographic || "—"),
    [filtered],
  );
  const graded = useMemo(() => gradedSplit(filtered), [filtered]);
  const diversity = useMemo(() => diversityStats(filtered), [filtered]);
  const lift = useMemo(() => holoLift(filtered), [filtered]);
  const rarestBases = useMemo(
    () => scoreByDimension(filtered, (t) => t.traits.Base).slice(0, 6),
    [filtered],
  );

  const rarestTokens = useMemo(
    () =>
      filtered
        .filter((t) => t.rarity)
        .sort((a, b) => a.rarity!.rank - b.rarity!.rank)
        .slice(0, 12),
    [filtered],
  );

  const holoTokens = useMemo(
    () =>
      filtered
        .filter((t) => /yes/i.test(t.traits.Holographic))
        .sort((a, b) => (a.rarity?.rank ?? 9999) - (b.rarity?.rank ?? 9999))
        .slice(0, 8),
    [filtered],
  );

  /** One representative with art per top base */
  const baseShowcase = useMemo(() => {
    const out: Array<{ base: string; count: number; pct: number; sample?: GalleryNft; rarity?: number }> =
      [];
    for (const slice of baseSlices.slice(0, 10)) {
      const candidates = filtered.filter((t) => t.traits.Base === slice.key);
      const withArt =
        candidates.find((t) => t.imageUri) ||
        candidates[0];
      const gallery = withArt ? byId.get(withArt.tokenId) : undefined;
      out.push({
        base: slice.key,
        count: slice.count,
        pct: slice.pct,
        sample: gallery
          ? gallery
          : withArt
            ? {
                tokenId: withArt.tokenId,
                tokenUri: getCachedToken(withArt.tokenId)?.tokenUri || "",
                name: withArt.name,
                description: "",
                imageUri: withArt.imageUri,
                attributes: withArt.attributes,
                owner: withArt.owner || "",
                searchText: "",
                searchWords: [],
                loaded: true,
              }
            : undefined,
        rarity: withArt?.rarity?.rank,
      });
    }
    return out;
  }, [baseSlices, filtered, byId]);

  const takeaways = useMemo(() => {
    const lines: string[] = [];
    if (!filtered.length) {
      return ["Waiting for revealed metadata in the gallery cache…"];
    }
    const topBase = baseSlices[0];
    if (topBase) {
      lines.push(
        `Most common base: ${topBase.label} (${topBase.pct.toFixed(1)}% of this cut).`,
      );
    }
    const rareBase = rarestBases[0];
    if (rareBase) {
      lines.push(
        `Highest avg score base: ${rareBase.key} (avg ${rareBase.avg.toFixed(1)}, n=${rareBase.n}).`,
      );
    }
    lines.push(
      `Holo rate ${lift.overallHoloPct.toFixed(1)}% · Graded backgrounds ${graded.gradedPct.toFixed(1)}%.`,
    );
    if (lift.byBase[0] && lift.byBase[0].lift > 1.2) {
      lines.push(
        `Holo magnet: ${lift.byBase[0].base} (${lift.byBase[0].lift.toFixed(2)}× collection average).`,
      );
    }
    const topFamily = familySlices[0];
    if (topFamily) {
      lines.push(
        `Biggest meme tribe: ${topFamily.label} (${topFamily.pct.toFixed(1)}%).`,
      );
    }
    if (diversity.topBaseShare > 15) {
      lines.push(
        `Supply is concentrated — top base is ${diversity.topBaseShare.toFixed(1)}% of the cut.`,
      );
    } else {
      lines.push(
        `Base diversity looks healthy (top share ${diversity.topBaseShare.toFixed(1)}%, Simpson ${diversity.simpsonBase.toFixed(2)}).`,
      );
    }
    return lines;
  }, [
    filtered.length,
    baseSlices,
    rarestBases,
    lift,
    graded,
    familySlices,
    diversity,
  ]);

  const withArtCount = universe.filter((i) => i.imageUri).length;
  const scoredCount = snapshot.scoredCount;

  if (scoredCount === 0 && withArtCount === 0) {
    return (
      <div className="rounded-xl border border-gold-500/20 bg-black/20 px-4 py-10 text-center">
        <p className="text-sm text-foreground/65">
          Waiting on the <strong className="text-gold-300">Grid</strong> to load art —
          check back here shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi
          label={active ? "In cut" : "Scored"}
          value={filtered.length.toLocaleString()}
          hint={
            active
              ? `of ${enriched.length.toLocaleString()} revealed`
              : `${withArtCount.toLocaleString()} with art cached`
          }
        />
        <Kpi
          label="Holo"
          value={`${lift.overallHoloPct.toFixed(1)}%`}
          hint={`${holoTokens.length ? holoTokens.length + "+" : "0"} foil in view`}
        />
        <Kpi
          label="Graded BG"
          value={`${graded.gradedPct.toFixed(1)}%`}
          hint={`${graded.graded} graded slabs`}
        />
        <Kpi
          label="Bases"
          value={diversity.uniqueBases.toLocaleString()}
          hint={`${diversity.uniqueCombos} unique combos`}
        />
      </div>

      {/* Compact controls */}
      <div className="flex flex-col gap-2 rounded-xl border border-gold-500/25 bg-black/25 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["discover", "Discover"],
              ["art", "Art board"],
              ["traits", "Trait mix"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-extrabold sm:text-sm ${
                view === id
                  ? "bg-gold-500 text-wood-950"
                  : "border border-gold-500/40 text-gold-300"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-extrabold sm:text-sm ${
              active || filtersOpen
                ? "bg-gold-500/90 text-wood-950"
                : "border border-gold-500/40 text-gold-300"
            }`}
          >
            Filters{active ? ` · on` : ""}
          </button>
          {active && (
            <button
              type="button"
              onClick={() => setFilters(emptyFilters())}
              className="min-h-9 rounded-lg border border-gold-500/35 px-3 py-1.5 text-xs font-extrabold text-gold-300"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-[0.65rem] text-foreground/45">
            Cache · {withArtCount.toLocaleString()} art ·{" "}
            {scoredCount.toLocaleString()} scored
          </span>
        </div>

        {/* Quick filters always visible */}
        <div className="flex flex-wrap gap-1.5">
          <Chip
            active={filters.holos.has("Yes") && filters.holos.size === 1}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                holos:
                  f.holos.has("Yes") && f.holos.size === 1
                    ? new Set()
                    : new Set(["Yes"]),
              }))
            }
            color="#67e8f9"
          >
            Holo only
          </Chip>
          <Chip
            active={filters.gradedOnly === true}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                gradedOnly: f.gradedOnly === true ? null : true,
              }))
            }
          >
            Graded BG
          </Chip>
          <Chip
            active={filters.gradedOnly === false}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                gradedOnly: f.gradedOnly === false ? null : false,
              }))
            }
          >
            Ungraded
          </Chip>
          {TIER_ORDER.slice(0, 4).map((tier) => (
            <Chip
              key={tier}
              active={filters.tiers.has(tier)}
              color={tierColor(tier)}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  tiers: toggleSet(f.tiers, tier as RarityTier),
                }))
              }
            >
              {tier}
            </Chip>
          ))}
        </div>

        {filtersOpen && (
          <div className="grid gap-3 border-t border-gold-500/15 pt-3 sm:grid-cols-2">
            <label className="block text-xs font-bold text-foreground/70">
              Search
              <input
                type="search"
                value={filters.search}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, search: e.target.value }))
                }
                placeholder="Base, id, family…"
                className="mt-1 min-h-10 w-full rounded-lg border border-gold-500/40 bg-wood-950 px-3 py-2 text-sm font-bold outline-none focus:border-gold-300"
              />
            </label>
            <div>
              <p className="mb-1.5 text-[0.65rem] font-extrabold uppercase tracking-wide text-gold-300/85">
                Meme family
              </p>
              <div className="flex flex-wrap gap-1">
                {MEME_FAMILY_ORDER.filter((f) =>
                  familySlices.some((s) => s.key === f) ||
                  enriched.some((t) => t.family === f),
                ).map((fam) => (
                  <Chip
                    key={fam}
                    active={filters.families.has(fam)}
                    color={MEME_FAMILY_COLOR[fam]}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        families: toggleSet(f.families, fam),
                      }))
                    }
                  >
                    {fam}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-[0.65rem] font-extrabold uppercase tracking-wide text-gold-300/85">
                Top bases (tap to isolate)
              </p>
              <div className="flex flex-wrap gap-1">
                {baseSlices.slice(0, 16).map((s) => (
                  <Chip
                    key={s.key}
                    active={filters.bases.has(s.key)}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        bases: toggleSet(f.bases, s.key),
                      }))
                    }
                  >
                    {s.label} · {s.count}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-[0.65rem] font-extrabold uppercase tracking-wide text-gold-300/85">
                Background grade
              </p>
              <div className="flex flex-wrap gap-1">
                {bgSlices.map((s) => (
                  <Chip
                    key={s.key}
                    active={filters.backgrounds.has(s.key)}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        backgrounds: toggleSet(f.backgrounds, s.key),
                      }))
                    }
                  >
                    {s.label} · {s.count}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── DISCOVER ─── */}
      {view === "discover" && (
        <div className="space-y-4">
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="font-display text-lg text-gold-300">What stands out</h3>
            <ul className="mt-2 space-y-1.5">
              {takeaways.map((line) => (
                <li
                  key={line}
                  className="flex gap-2 text-sm leading-snug text-foreground/80"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gold-500" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <div className="mb-3 flex items-end justify-between gap-2">
              <div>
                <h3 className="font-display text-lg text-gold-300">Rarest right now</h3>
              </div>
              <span className="text-[0.65rem] font-bold text-foreground/45">
                {active ? "filtered cut" : "full sample"}
              </span>
            </div>
            {rarestTokens.length === 0 ? (
              <p className="py-6 text-center text-sm text-foreground/55">
                No scored tokens in this cut yet.
              </p>
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {rarestTokens.map((t) => {
                  const nft = byId.get(t.tokenId);
                  const img = nft?.imageUri || t.imageUri;
                  return (
                    <li key={t.tokenId}>
                      <Thumb
                        tokenId={t.tokenId}
                        imageUri={img}
                        name={t.traits.Base || t.name}
                        badge={
                          t.rarity
                            ? `${formatRank(t.rarity.rank)} ${t.rarity.tier}`
                            : undefined
                        }
                        badgeColor={
                          t.rarity ? tierColor(t.rarity.tier) : undefined
                        }
                        onClick={() => onSelectToken?.(t.tokenId)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {holoTokens.length > 0 && (
            <section className="rounded-xl border border-cyan-400/25 bg-black/25 p-3 sm:p-4">
              <h3 className="mb-3 font-display text-lg text-cyan-300">Holographic planks</h3>
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {holoTokens.map((t) => (
                  <li key={t.tokenId}>
                    <Thumb
                      tokenId={t.tokenId}
                      imageUri={byId.get(t.tokenId)?.imageUri || t.imageUri}
                      name={t.traits.Base || t.name}
                      badge="HOLO"
                      badgeColor="#67e8f9"
                      onClick={() => onSelectToken?.(t.tokenId)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
              <h3 className="mb-3 font-display text-lg text-gold-300">
                Background grades
              </h3>
              <HBars
                slices={bgSlices}
                max={10}
                onPick={(key) =>
                  setFilters((f) => ({
                    ...f,
                    backgrounds: toggleSet(f.backgrounds, key),
                  }))
                }
              />
            </section>
            <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
              <h3 className="mb-3 font-display text-lg text-gold-300">
                Meme families
              </h3>
              <HBars
                slices={familySlices}
                max={12}
                onPick={(key) =>
                  setFilters((f) => ({
                    ...f,
                    families: toggleSet(f.families, key as MemeFamily),
                  }))
                }
              />
            </section>
          </div>

          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-3 font-display text-lg text-gold-300">
              Power bases (avg score)
            </h3>
            <div className="space-y-2">
              {rarestBases.map((row, i) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() =>
                    setFilters((f) => ({
                      ...f,
                      bases: new Set([row.key]),
                    }))
                  }
                  className="flex w-full items-center gap-3 rounded-lg border border-gold-500/15 bg-black/20 px-2 py-2 text-left hover:border-gold-500/40"
                >
                  <span className="w-5 shrink-0 font-mono text-xs text-foreground/40">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-foreground">
                      {row.key}
                    </p>
                    <p className="font-mono text-[0.65rem] text-foreground/50">
                      avg {row.avg.toFixed(1)} · median {row.median.toFixed(1)} · n=
                      {row.n}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ─── ART BOARD ─── */}
      {view === "art" && (
        <div className="space-y-4">
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-1 font-display text-lg text-gold-300">
              Base art roster
            </h3>
            <p className="mb-3 text-xs text-foreground/50">Tap to filter</p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
              {baseShowcase.map((row) => (
                <li key={row.base}>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((f) => ({
                        ...f,
                        bases: new Set([row.base]),
                      }));
                      if (row.sample) onSelectToken?.(row.sample.tokenId);
                    }}
                    className="group flex w-full flex-col overflow-hidden rounded-lg border border-gold-500/25 bg-wood-950/70 text-left"
                  >
                    <div className="relative aspect-square w-full bg-wood-950">
                      <NftImage
                        imageUri={row.sample?.imageUri || ""}
                        alt={row.base}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[0.6rem] font-bold text-gold-300">
                        {row.count}× · {row.pct.toFixed(1)}%
                      </span>
                    </div>
                    <p className="line-clamp-2 p-2 text-xs font-black text-foreground">
                      {row.base}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-display text-lg text-gold-300">
                Filtered woodpile
              </h3>
              <span className="text-xs font-bold text-foreground/50">
                {filtered.length.toLocaleString()} · showing{" "}
                {Math.min(48, filtered.length)}
              </span>
            </div>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {filtered
                .slice()
                .sort(
                  (a, b) =>
                    (a.rarity?.rank ?? 99999) - (b.rarity?.rank ?? 99999),
                )
                .slice(0, 48)
                .map((t) => (
                  <li key={t.tokenId}>
                    <Thumb
                      tokenId={t.tokenId}
                      imageUri={byId.get(t.tokenId)?.imageUri || t.imageUri}
                      name={t.traits.Base || t.name}
                      badge={t.rarity ? formatRank(t.rarity.rank) : undefined}
                      badgeColor={
                        t.rarity ? tierColor(t.rarity.tier) : undefined
                      }
                      onClick={() => onSelectToken?.(t.tokenId)}
                    />
                  </li>
                ))}
            </ul>
            {filtered.length > 48 && (
              <p className="mt-3 text-center text-xs text-foreground/45">
                48 of {filtered.length.toLocaleString()} — filter to narrow.
              </p>
            )}
          </section>
        </div>
      )}

      {/* ─── TRAIT MIX ─── */}
      {view === "traits" && (
        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-3 font-display text-lg text-gold-300">Base share</h3>
            <HBars
              slices={baseSlices}
              max={14}
              onPick={(key) =>
                setFilters((f) => ({
                  ...f,
                  bases: toggleSet(f.bases, key),
                }))
              }
            />
          </section>
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-3 font-display text-lg text-gold-300">
              Background share
            </h3>
            <HBars
              slices={bgSlices}
              max={12}
              onPick={(key) =>
                setFilters((f) => ({
                  ...f,
                  backgrounds: toggleSet(f.backgrounds, key),
                }))
              }
            />
          </section>
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-3 font-display text-lg text-gold-300">
              Holographic
            </h3>
            <HBars slices={holoSlices} max={4} />
            {lift.byBase.slice(0, 5).length > 0 && (
              <div className="mt-4 border-t border-gold-500/15 pt-3">
                <p className="mb-2 text-[0.65rem] font-extrabold uppercase tracking-wide text-cyan-300/90">
                  Holo lift by base
                </p>
                <ul className="space-y-1.5 text-xs">
                  {lift.byBase.slice(0, 5).map((row) => (
                    <li
                      key={row.base}
                      className="flex justify-between gap-2 font-bold"
                    >
                      <span className="min-w-0 truncate">{row.base}</span>
                      <span className="shrink-0 font-mono text-cyan-300/90">
                        {row.lift.toFixed(2)}× · {row.holo}/{row.total}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <section className="rounded-xl border border-gold-500/25 bg-black/25 p-3 sm:p-4">
            <h3 className="mb-3 font-display text-lg text-gold-300">
              Meme family
            </h3>
            <HBars
              slices={familySlices}
              max={12}
              onPick={(key) =>
                setFilters((f) => ({
                  ...f,
                  families: toggleSet(f.families, key as MemeFamily),
                }))
              }
            />
          </section>
        </div>
      )}

      <p className="text-center text-[0.7rem] text-foreground/40">
        {rarityMethodBlurb(scoredCount)} · filters also apply to Grid
      </p>
    </div>
  );
}

export { computeRaritySnapshot };
